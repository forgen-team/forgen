/**
 * Forgen — Compound Pattern Share (패턴별 export/import)
 *
 * `compound-export.ts`의 `export`/`import`는 `~/.forgen/me/` 전체를 tar.gz로
 * 통짜 백업/이관한다. 이 모듈은 그와 달리 **이름 지정된 패턴 단위**로 신뢰도
 * (confidence/status/evidence)와 provenance를 함께 담은 JSON 번들을 만들고,
 * 받는 쪽에서 안전하게 병합한다 (ECC `/instinct-import/export` 대응, OSS gap #1).
 *
 * 핵심 설계:
 *   - 번들은 스키마 버전 고정 JSON. 최상위/패턴 필드 모두 화이트리스트 검증 —
 *     예상 못한 필드가 있으면 통째로 reject (실행 가능한 콘텐츠가 섞여 들어올
 *     여지 자체를 차단).
 *   - 패턴마다 contentHash(sha256)를 동봉 — import 시 재계산해 일치하지 않으면
 *     reject (변조/손상 탐지).
 *   - 이름 충돌 시: 로컬 콘텐츠 해시가 같으면 "동일 패턴 재발견"으로 간주해
 *     `reExtracted` 카운터만 증가(기존 신뢰도는 건드리지 않음 — 이미 solution-writer.ts
 *     의 dual-path 금지 불변식과 일치). 다르면 절대 덮어쓰지 않고 suffix된
 *     이름으로 새로 생성.
 *   - 신규 생성되는 패턴은 항상 probation: status='experiment', confidence는
 *     신규 솔루션 표준 베이스라인(statusConfidence('experiment')=0.3, 참고:
 *     extraction-persistence.ts saveExtractedSolution)을 상한으로 export 시점
 *     confidence의 절반만 반영. evidence는 전부 0으로 리셋 — exporter의 로컬
 *     사용 이력을 이 머신이 검증 없이 물려받지 않는다. 이후 승급은 기존
 *     compound-lifecycle.ts의 단일 경로(runLifecycleCheck)로만 진행된다.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseSolutionV3,
  serializeSolutionV3,
  validateFrontmatter,
  diagnoseFrontmatter,
  DEFAULT_EVIDENCE,
  type SolutionV3,
  type SolutionFrontmatter,
} from './solution-format.js';
import { statusConfidence } from './compound-lifecycle.js';
import { loadRoiDemotions, isRoiQuarantined } from './roi-demotion.js';
import { mutateSolutionFile } from './solution-writer.js';
import { detectSecrets } from '../hooks/secret-filter.js';
import { atomicWriteText } from '../hooks/shared/atomic-write.js';
import { ME_SOLUTIONS, ME_RULES } from '../core/paths.js';

// ── Schema ──

export const SHARE_BUNDLE_SCHEMA_VERSION = 1 as const;

/** 번들 하나에 담을 수 있는 최대 패턴 수 — 전체 스토어 이관은 tar.gz export의 몫. */
const MAX_PATTERNS_PER_BUNDLE = 50;
/** 번들 원본 JSON 텍스트의 최대 바이트 수 (파싱 전에 먼저 확인 — DoS 가드). */
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
/** 패턴 하나의 context/content 필드 최대 길이 (문자 수). */
const MAX_FIELD_LENGTH = 20000;
/** probation confidence 계산 시 exporter confidence에 곱하는 비율. */
const PROBATION_SCALE = 0.5;

export interface ShareBundlePatternV1 {
  name: string;
  category: 'solution' | 'rule';
  frontmatter: SolutionFrontmatter;
  context: string;
  content: string;
  /** sha256(type + sorted tags/identifiers + context + content) — confidence/evidence/timestamp 제외한 콘텐츠 지문. */
  contentHash: string;
}

export interface ShareBundleV1 {
  schemaVersion: 1;
  exportedAt: string;
  /** sha256(hostname:username) 앞 16자 — 원본 식별용, PII 비가역. */
  originHash: string;
  patterns: ShareBundlePatternV1[];
}

const BUNDLE_TOP_KEYS = ['schemaVersion', 'exportedAt', 'originHash', 'patterns'] as const;
const PATTERN_KEYS = ['name', 'category', 'frontmatter', 'context', 'content', 'contentHash'] as const;
const FRONTMATTER_KEYS = [
  'name', 'version', 'status', 'confidence', 'type', 'scope', 'tags',
  'identifiers', 'evidence', 'created', 'updated', 'supersedes', 'extractedBy',
] as const;
const EVIDENCE_KEYS = ['injected', 'reflected', 'negative', 'sessions', 'reExtracted'] as const;

function hasOnlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(obj).every(k => allowed.includes(k));
}

// ── Hashing ──

function computePatternContentHash(
  fm: Pick<SolutionFrontmatter, 'type' | 'tags' | 'identifiers'>,
  context: string,
  content: string,
): string {
  const stable = JSON.stringify({
    type: fm.type,
    tags: [...fm.tags].sort(),
    identifiers: [...fm.identifiers].sort(),
    context,
    content,
  });
  return createHash('sha256').update(stable, 'utf-8').digest('hex');
}

function computeOriginHash(): string {
  let raw: string;
  try {
    raw = `${os.hostname()}:${os.userInfo().username}`;
  } catch {
    raw = `${os.hostname()}:unknown`;
  }
  return createHash('sha256').update(raw, 'utf-8').digest('hex').slice(0, 16);
}

// ── Local lookup ──

interface LocalSolution {
  filePath: string;
  solution: SolutionV3;
}

/** 이름으로 category 디렉터리 안의 솔루션/룰 파일을 찾는다 (symlink 무시). */
function findLocalSolution(category: 'solution' | 'rule', name: string): LocalSolution | null {
  const dir = category === 'solution' ? ME_SOLUTIONS : ME_RULES;
  if (!fs.existsSync(dir)) return null;

  // fast path: 파일명이 곧 name.md인 관례를 먼저 시도
  const fastPath = path.join(dir, `${name}.md`);
  const tryRead = (filePath: string): LocalSolution | null => {
    try {
      if (fs.lstatSync(filePath).isSymbolicLink()) return null;
      const content = fs.readFileSync(filePath, 'utf-8');
      const solution = parseSolutionV3(content);
      if (solution && solution.frontmatter.name === name) return { filePath, solution };
    } catch { /* 다음 후보로 */ }
    return null;
  };

  if (fs.existsSync(fastPath)) {
    const hit = tryRead(fastPath);
    if (hit) return hit;
  }

  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const hit = tryRead(path.join(dir, file));
      if (hit) return hit;
    }
  } catch { /* dir read 실패 — not found로 취급 */ }

  return null;
}

/** import 시 태그로 남기는 원본 번들 해시 표식. */
const IMPORT_HASH_TAG_PREFIX = 'import-hash:';

function importHashTag(contentHash: string): string {
  return `${IMPORT_HASH_TAG_PREFIX}${contentHash.slice(0, 16)}`;
}

/**
 * 같은 원본 패턴이 이미 수입됐는지를 `import-hash:` 태그로 찾는다.
 *
 * import는 provenance(태그/노트)를 덧붙여 저장하므로 로컬 재계산 해시가 원본
 * 번들 해시와 달라진다 — 콘텐츠 해시 비교만으로는 재import를 인식하지 못해
 * 같은 번들을 다시 들이면 매번 suffix 사본이 늘었다 (리뷰 #10 SEV-3 실증).
 * 수입 시점의 *원본* 해시를 태그로 보존해두고 여기서 우선 조회한다.
 */
function findLocalByImportHash(category: 'solution' | 'rule', contentHash: string): LocalSolution | null {
  const dir = category === 'solution' ? ME_SOLUTIONS : ME_RULES;
  if (!fs.existsSync(dir)) return null;
  const tag = importHashTag(contentHash);
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        if (fs.lstatSync(filePath).isSymbolicLink()) continue;
        const solution = parseSolutionV3(fs.readFileSync(filePath, 'utf-8'));
        if (solution && solution.frontmatter.tags.includes(tag)) return { filePath, solution };
      } catch { /* 다음 후보로 */ }
    }
  } catch { /* dir read 실패 — not found로 취급 */ }
  return null;
}

function findSolutionOrRule(name: string): (LocalSolution & { category: 'solution' | 'rule' }) | null {
  const sol = findLocalSolution('solution', name);
  if (sol) return { ...sol, category: 'solution' };
  const rule = findLocalSolution('rule', name);
  if (rule) return { ...rule, category: 'rule' };
  return null;
}

function pickAvailableName(category: 'solution' | 'rule', baseName: string): string {
  const dir = category === 'solution' ? ME_SOLUTIONS : ME_RULES;
  let n = 1;
  let candidate = `${baseName}-import`;
  while (fs.existsSync(path.join(dir, `${candidate}.md`)) || findLocalSolution(category, candidate)) {
    n++;
    candidate = `${baseName}-import-${n}`;
  }
  return candidate;
}

// ── Export ──

export interface BuildBundleResult {
  bundle: ShareBundleV1;
  notFound: string[];
  rejectedSecrets: string[];
}

/**
 * 이름 목록으로 패턴 번들 생성.
 *
 * 시크릿 감지된 패턴은 조용히 스킵하지 않고 `rejectedSecrets`로 보고하되,
 * 번들 자체는 나머지 clean한 패턴으로 계속 진행한다 (부분 실패 허용).
 */
export function buildShareBundle(names: string[]): BuildBundleResult {
  const patterns: ShareBundlePatternV1[] = [];
  const notFound: string[] = [];
  const rejectedSecrets: string[] = [];

  for (const rawName of names) {
    const name = rawName.trim();
    if (!name) continue;

    const found = findSolutionOrRule(name);
    if (!found) {
      notFound.push(name);
      continue;
    }

    const { category, solution } = found;
    // 시크릿 스캔은 패턴의 *직렬화 전체*에 건다 — context/content만 검사하면
    // frontmatter(identifiers/tags 등 auto-추출 필드)에 붙여넣기된 토큰이
    // 공유 번들로 그대로 유출된다 (리뷰 #10 SEV-2 실증: identifiers 안의
    // AWS 키가 번들에 포함됨). 번들에 실리는 바이트 = 스캔되는 바이트.
    const serialized = JSON.stringify({
      frontmatter: solution.frontmatter,
      context: solution.context,
      content: solution.content,
    });
    const secretHits = detectSecrets(serialized);
    if (secretHits.length > 0) {
      const kinds = [...new Set(secretHits.map(h => h.name))].join(', ');
      rejectedSecrets.push(`${name} (${kinds})`);
      continue;
    }

    patterns.push({
      name: solution.frontmatter.name,
      category,
      frontmatter: solution.frontmatter,
      context: solution.context,
      content: solution.content,
      contentHash: computePatternContentHash(solution.frontmatter, solution.context, solution.content),
    });
  }

  return {
    bundle: {
      schemaVersion: SHARE_BUNDLE_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      originHash: computeOriginHash(),
      patterns,
    },
    notFound,
    rejectedSecrets,
  };
}

// ── Validation ──

export interface ShareBundleValidation {
  ok: boolean;
  bundle: ShareBundleV1 | null;
  errors: string[];
}

/**
 * 번들 검증: 크기 캡 → 최상위 필드 화이트리스트 → 패턴별 필드 화이트리스트 →
 * frontmatter 정합성 → contentHash 재계산 일치. 하나라도 실패하면 번들 전체를
 * reject한다 (부분 신뢰 없음 — 손상/변조된 번들은 통째로 버린다).
 */
export function validateShareBundle(raw: unknown, rawSize: number): ShareBundleValidation {
  const errors: string[] = [];

  if (rawSize > MAX_BUNDLE_BYTES) {
    return { ok: false, bundle: null, errors: [`bundle too large: ${rawSize} bytes (max ${MAX_BUNDLE_BYTES})`] };
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, bundle: null, errors: ['bundle root must be an object'] };
  }

  const root = raw as Record<string, unknown>;
  if (!hasOnlyKeys(root, BUNDLE_TOP_KEYS)) {
    const extra = Object.keys(root).filter(k => !(BUNDLE_TOP_KEYS as readonly string[]).includes(k));
    errors.push(`unexpected top-level fields: ${extra.join(', ')}`);
  }
  if (root.schemaVersion !== SHARE_BUNDLE_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion: ${String(root.schemaVersion)}`);
  }
  if (typeof root.exportedAt !== 'string' || Number.isNaN(new Date(root.exportedAt).getTime())) {
    errors.push('exportedAt must be a valid ISO date string');
  }
  if (typeof root.originHash !== 'string' || !/^[0-9a-f]{16}$/.test(root.originHash)) {
    errors.push('originHash must be a 16-char hex string');
  }
  if (!Array.isArray(root.patterns)) {
    errors.push('patterns must be an array');
    return { ok: false, bundle: null, errors };
  }
  if (root.patterns.length === 0) {
    errors.push('patterns must not be empty');
  }
  if (root.patterns.length > MAX_PATTERNS_PER_BUNDLE) {
    errors.push(`too many patterns: ${root.patterns.length} (max ${MAX_PATTERNS_PER_BUNDLE})`);
  }

  const patterns: ShareBundlePatternV1[] = [];
  for (let i = 0; i < root.patterns.length; i++) {
    const rawPattern = root.patterns[i];
    if (rawPattern == null || typeof rawPattern !== 'object' || Array.isArray(rawPattern)) {
      errors.push(`pattern[${i}]: must be an object`);
      continue;
    }
    const p = rawPattern as Record<string, unknown>;
    if (!hasOnlyKeys(p, PATTERN_KEYS)) {
      const extra = Object.keys(p).filter(k => !(PATTERN_KEYS as readonly string[]).includes(k));
      errors.push(`pattern[${i}]: unexpected fields ${extra.join(', ')}`);
      continue;
    }
    if (typeof p.name !== 'string' || !/^[a-z0-9가-힣-]{1,60}$/.test(p.name)) {
      errors.push(`pattern[${i}]: invalid name`);
      continue;
    }
    if (p.category !== 'solution' && p.category !== 'rule') {
      errors.push(`pattern[${i}]: category must be solution|rule`);
      continue;
    }
    if (typeof p.context !== 'string' || p.context.length > MAX_FIELD_LENGTH) {
      errors.push(`pattern[${i}]: context invalid or too long`);
      continue;
    }
    if (typeof p.content !== 'string' || p.content.length > MAX_FIELD_LENGTH) {
      errors.push(`pattern[${i}]: content invalid or too long`);
      continue;
    }
    if (typeof p.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(p.contentHash)) {
      errors.push(`pattern[${i}]: invalid contentHash`);
      continue;
    }
    if (p.frontmatter == null || typeof p.frontmatter !== 'object' || Array.isArray(p.frontmatter)) {
      errors.push(`pattern[${i}]: frontmatter must be an object`);
      continue;
    }
    const fm = p.frontmatter as Record<string, unknown>;
    if (!hasOnlyKeys(fm, FRONTMATTER_KEYS)) {
      errors.push(`pattern[${i}]: frontmatter has unexpected fields`);
      continue;
    }
    if (fm.evidence != null && typeof fm.evidence === 'object'
      && !hasOnlyKeys(fm.evidence as Record<string, unknown>, EVIDENCE_KEYS)) {
      errors.push(`pattern[${i}]: frontmatter.evidence has unexpected fields`);
      continue;
    }
    if (!validateFrontmatter(fm)) {
      errors.push(`pattern[${i}] (${String(p.name)}): frontmatter invalid — ${diagnoseFrontmatter(fm).join('; ')}`);
      continue;
    }

    const typedFm = fm as unknown as SolutionFrontmatter;
    const recomputed = computePatternContentHash(typedFm, p.context, p.content);
    if (recomputed !== p.contentHash) {
      errors.push(`pattern[${i}] (${p.name}): contentHash mismatch — bundle corrupted or tampered`);
      continue;
    }

    patterns.push({
      name: p.name,
      category: p.category,
      frontmatter: typedFm,
      context: p.context,
      content: p.content,
      contentHash: p.contentHash,
    });
  }

  if (errors.length > 0) {
    return { ok: false, bundle: null, errors };
  }

  return {
    ok: true,
    errors: [],
    bundle: {
      schemaVersion: SHARE_BUNDLE_SCHEMA_VERSION,
      exportedAt: root.exportedAt as string,
      originHash: root.originHash as string,
      patterns,
    },
  };
}

// ── Import ──

/**
 * Import된 패턴의 probation confidence.
 *
 * status는 항상 'experiment'로 시작해 승급 게이트(age/evidence)를 이 머신에서
 * 처음부터 다시 통과해야 한다. confidence 상한은 신규 솔루션 표준 베이스라인
 * (statusConfidence('experiment')=0.3, extraction-persistence.ts의
 * saveExtractedSolution과 동일 기준)이고, exporter confidence의 절반을 반영해
 * "완전 무근거는 아니다"라는 정보만 남긴다. 하한은 0.05
 * (compound-lifecycle.ts의 STATUS_CONFIDENCE_MIN.experiment)보다 위로 둬서
 * 다음 lifecycle 체크에서 곧바로 retired되는 것을 막는다.
 */
function computeProbationConfidence(sourceConfidence: number): number {
  const ceiling = statusConfidence('experiment');
  const scaled = sourceConfidence * PROBATION_SCALE;
  return Math.min(ceiling, Math.max(0.05, scaled));
}

export interface ShareImportAction {
  sourceName: string;
  category: 'solution' | 'rule';
  action: 'merge-reextract' | 'create' | 'create-suffixed';
  targetName: string;
  detail: string;
}

export interface ShareImportSummary {
  dryRun: boolean;
  actions: ShareImportAction[];
}

/** dry-run과 실제 실행이 공유하는 계획 수립 — 파일시스템에 아무것도 쓰지 않는다. */
export function planShareImport(bundle: ShareBundleV1): ShareImportAction[] {
  const actions: ShareImportAction[] = [];

  for (const pattern of bundle.patterns) {
    // 재import 인식이 이름/콘텐츠 비교보다 우선한다 — 수입본은 provenance가
    // 덧붙어 해시가 달라지므로, 원본 해시 태그로 먼저 찾는다 (suffix sprawl 방지).
    const priorImport = findLocalByImportHash(pattern.category, pattern.contentHash);
    if (priorImport) {
      actions.push({
        sourceName: pattern.name,
        category: pattern.category,
        action: 'merge-reextract',
        targetName: priorImport.solution.frontmatter.name,
        detail: '이미 수입된 패턴(import-hash 일치) — reExtracted 카운터만 증가',
      });
      continue;
    }

    const existing = findLocalSolution(pattern.category, pattern.name);

    if (!existing) {
      actions.push({
        sourceName: pattern.name,
        category: pattern.category,
        action: 'create',
        targetName: pattern.name,
        detail: '신규 — probation 신뢰도(experiment)로 생성',
      });
      continue;
    }

    const localHash = computePatternContentHash(
      existing.solution.frontmatter,
      existing.solution.context,
      existing.solution.content,
    );

    if (localHash === pattern.contentHash) {
      actions.push({
        sourceName: pattern.name,
        category: pattern.category,
        action: 'merge-reextract',
        targetName: pattern.name,
        detail: '동일 콘텐츠 — reExtracted 카운터만 증가 (기존 신뢰도 유지)',
      });
    } else {
      const targetName = pickAvailableName(pattern.category, pattern.name);
      actions.push({
        sourceName: pattern.name,
        category: pattern.category,
        action: 'create-suffixed',
        targetName,
        detail: `이름 충돌, 콘텐츠 다름 — 기존 파일을 덮어쓰지 않고 "${targetName}"로 생성 (probation)`,
      });
    }
  }

  return actions;
}

export function executeShareImport(bundle: ShareBundleV1, opts: { dryRun?: boolean } = {}): ShareImportSummary {
  const actions = planShareImport(bundle);
  if (opts.dryRun) {
    return { dryRun: true, actions };
  }

  for (const action of actions) {
    const pattern = bundle.patterns.find(p => p.name === action.sourceName && p.category === action.category);
    if (!pattern) continue;

    if (action.action === 'merge-reextract') {
      const existing = findLocalSolution(action.category, action.targetName);
      if (existing) {
        mutateSolutionFile(existing.filePath, sol => {
          sol.frontmatter.evidence.reExtracted += 1;
          return true;
        });
      }
      continue;
    }

    const today = new Date().toISOString().split('T')[0];
    // 프로버넌스 태그는 forge(이 코드)만 부여한다 — incoming 번들이 위조
    // `import-hash:`/`origin:`/`imported` 태그를 로컬 스토어에 심지 못하게
    // 스트립 후 재부여 (리뷰 #11 defense-in-depth: 위조 태그 기반 merge
    // hijack 메커니즘 원천 제거).
    const incomingTags = pattern.frontmatter.tags.filter(t =>
      t !== 'imported' && !t.startsWith('origin:') && !t.startsWith(IMPORT_HASH_TAG_PREFIX));
    const tags = Array.from(new Set([
      ...incomingTags,
      'imported',
      `origin:${bundle.originHash}`,
      // 원본 번들 해시 표식 — 재import 시 findLocalByImportHash가 이 태그로
      // 기존 수입본을 찾아 merge로 라우팅한다 (suffix 사본 무한 증식 방지).
      importHashTag(pattern.contentHash),
    ]));
    const provenanceNote = `[imported: origin=${bundle.originHash} exportedAt=${bundle.exportedAt} `
      + `sourceName=${pattern.name} sourceConfidence=${pattern.frontmatter.confidence.toFixed(2)} `
      + `sourceStatus=${pattern.frontmatter.status}]`;

    const solution: SolutionV3 = {
      frontmatter: {
        ...pattern.frontmatter,
        name: action.targetName,
        status: 'experiment',
        confidence: computeProbationConfidence(pattern.frontmatter.confidence),
        tags,
        evidence: { ...DEFAULT_EVIDENCE },
        created: today,
        updated: today,
        supersedes: null,
        extractedBy: 'manual',
      },
      context: [pattern.context, provenanceNote].filter(Boolean).join('\n\n'),
      content: pattern.content,
    };

    const dir = action.category === 'solution' ? ME_SOLUTIONS : ME_RULES;
    const filePath = path.join(dir, `${action.targetName}.md`);
    // 덮어쓰기 절대 금지 불변식: race로 그새 같은 이름이 생겼으면 스킵.
    if (fs.existsSync(filePath)) continue;

    fs.mkdirSync(dir, { recursive: true });
    atomicWriteText(filePath, serializeSolutionV3(solution));
  }

  return { dryRun: false, actions };
}

// ── File-type sniffing (compound-loop.ts 디스패처가 export/import 대상을
//    tar.gz(통짜 백업) vs JSON 번들(패턴 공유)로 구분할 때 사용) ──

export function looksLikeShareBundle(filePath: string): boolean {
  if (filePath.endsWith('.tar.gz') || filePath.endsWith('.tgz')) return false;
  if (filePath.endsWith('.json')) return true;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(1);
      const bytesRead = fs.readSync(fd, buf, 0, 1, 0);
      return bytesRead > 0 && buf[0] === 0x7b; // '{'
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// ── CLI handlers ──

export async function handleShareExport(args: string[]): Promise<void> {
  const outIdx = args.indexOf('--out');
  const outputPath = outIdx !== -1 ? args[outIdx + 1] : undefined;
  const names = args.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (outIdx !== -1 && i === outIdx + 1) return false;
    return true;
  });

  if (names.length === 0) {
    console.log('  Usage: forgen compound export <name...> [--out <file>]\n');
    return;
  }

  const { bundle, notFound, rejectedSecrets } = buildShareBundle(names);

  if (bundle.patterns.length === 0) {
    console.log('\n  내보낼 패턴이 없습니다.');
    if (notFound.length) console.log(`  찾을 수 없음: ${notFound.join(', ')}`);
    if (rejectedSecrets.length) console.log(`  비밀정보 감지로 제외: ${rejectedSecrets.join(', ')}`);
    console.log();
    return;
  }

  const date = new Date().toISOString().split('T')[0];
  const resolved = outputPath ?? path.join(process.cwd(), `forgen-share-${date}.json`);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  atomicWriteText(resolved, JSON.stringify(bundle, null, 2));

  console.log('\n  Compound Pattern Export\n');
  console.log(`  Output: ${resolved}`);
  console.log(`  Exported: ${bundle.patterns.length}`);
  for (const p of bundle.patterns) {
    console.log(`    + ${p.name} [${p.category}] (confidence ${p.frontmatter.confidence.toFixed(2)}, status ${p.frontmatter.status})`);
  }
  if (notFound.length) console.log(`  Not found: ${notFound.join(', ')}`);
  if (rejectedSecrets.length) console.log(`  Excluded (secrets detected): ${rejectedSecrets.join(', ')}`);
  // 죽은 패턴을 조용히 공유하지 않는다 — 받는 쪽 probation을 거치더라도,
  // 보내는 쪽이 이미 은퇴(status)·격리(ROI 저장소)시킨 지식임을 명시 경고
  // (리뷰 #10 관찰. quarantine은 SolutionStatus가 아니라 roi-demotions 저장소 소관).
  const roiDemotions = loadRoiDemotions();
  const dead = bundle.patterns.filter(p => {
    if (p.frontmatter.status === 'retired') return true;
    const roiEntry = roiDemotions[p.name];
    return roiEntry ? isRoiQuarantined(roiEntry) : false;
  });
  if (dead.length) {
    console.log(`  ⚠ Warning: ${dead.map(p => p.name).join(', ')} — 로컬에서 retired 또는 ROI-격리 상태인 패턴입니다. 공유 전 유효성을 확인하세요.`);
  }
  console.log();
}

export async function handleShareImport(args: string[]): Promise<void> {
  const filteredArgs = args.filter(a => !a.startsWith('--'));
  const bundlePath = filteredArgs[0];
  const dryRun = args.includes('--dry-run');

  if (!bundlePath) {
    console.log('  Usage: forgen compound import <bundle.json> [--dry-run]\n');
    return;
  }

  const resolved = path.resolve(bundlePath);
  if (!fs.existsSync(resolved)) {
    console.log(`\n  Bundle not found: ${resolved}\n`);
    return;
  }

  // 크기컷은 read/parse *전에* — 번들은 외부 수신 산출물이라 악성 대용량
  // 파일을 통째로 메모리에 올린 뒤 거부하면 이미 늦다 (리뷰 #10 SEV-3).
  let rawSize: number;
  try {
    rawSize = fs.statSync(resolved).size;
  } catch (e) {
    console.log(`\n  Bundle stat failed: ${(e as Error).message}\n`);
    return;
  }
  if (rawSize > MAX_BUNDLE_BYTES) {
    console.log(`\n  Bundle too large: ${rawSize} bytes (max ${MAX_BUNDLE_BYTES})\n`);
    return;
  }

  let raw: unknown;
  try {
    const text = fs.readFileSync(resolved, 'utf-8');
    // TOCTOU 봉쇄: stat과 read 사이 파일이 커졌을 수 있다 — 실제 읽은 길이로 재검
    // (리뷰 #11). rawSize도 실측치로 갱신해 validateShareBundle이 stale 크기를
    // 신뢰하지 않게 한다.
    rawSize = Buffer.byteLength(text, 'utf-8');
    if (rawSize > MAX_BUNDLE_BYTES) {
      console.log(`\n  Bundle too large: ${rawSize} bytes (max ${MAX_BUNDLE_BYTES})\n`);
      return;
    }
    raw = JSON.parse(text);
  } catch (e) {
    console.log(`\n  Bundle read/parse failed: ${(e as Error).message}\n`);
    return;
  }

  const validated = validateShareBundle(raw, rawSize);
  if (!validated.ok || !validated.bundle) {
    console.log('\n  Bundle validation failed:\n');
    for (const err of validated.errors) console.log(`    - ${err}`);
    console.log();
    return;
  }

  const summary = executeShareImport(validated.bundle, { dryRun });

  console.log(`\n  Compound Pattern Import${dryRun ? ' (dry-run)' : ''}\n`);
  console.log(`  Bundle: ${resolved}`);
  console.log(`  Origin: ${validated.bundle.originHash}  Exported: ${validated.bundle.exportedAt}\n`);
  for (const a of summary.actions) {
    const icon = a.action === 'merge-reextract' ? '~' : a.action === 'create-suffixed' ? '+*' : '+';
    console.log(`    ${icon} ${a.sourceName} → ${a.targetName}  (${a.detail})`);
  }
  console.log(`\n  ${summary.actions.length} pattern(s) ${dryRun ? 'would be processed (dry-run — nothing written)' : 'processed'}.\n`);
}
