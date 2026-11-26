/**
 * `forgen audit` 한 회차 — 원천 읽기 → 결정적 검사 → 결과(JSON) · manifest.
 * 쓰기는 writeRun() 하나뿐이고 그 위치는 <FORGEN_HOME>/audit/<회차>/ 다. 나머지는 읽기만 한다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { FORGEN_HOME, ME_BEHAVIOR, ME_RULES } from '../core/paths.js';
import { renderSessionStartReadOnly } from '../core/v1-bootstrap.js';
import { planSessionScopes } from '../engine/rule-project-cli.js';
import { ruleToText } from '../renderer/rule-renderer.js';
import { readProjectRegistry } from '../store/project-registry.js';
import { scanRuleFiles } from '../store/rule-store.js';
import { projectKeyFor } from '../store/rule-scope.js';
import type { Rule } from '../store/types.js';
import { projectKeysIn, projectSpecificSuspects } from '../way/compile.js';
import { isHomeDir } from '../way/io.js';
import type { WayItem } from '../way/types.js';
import {
  checkSameSentence, checkStale, checkTruncation, markdownUnits, mergeMixCandidates, normalizeSentence,
  type MixCandidate, type SameSentenceGroup, type StaleRef, type TruncationResult, type Unit, type UnscopedRule,
} from './checks.js';
import {
  defaultEnv, defaultFolders, gitRootOf, hostLoadFor, listMemoryDirs, readMemoryDir, SourceReader,
  type AuditEnv, type FolderLoad, type Layer, type MemoryDir,
  readSkillCatalog, type SkillEntry, frontmatterField, splitFrontmatter,
} from './sources.js';
import { estimateTokens } from './tokens.js';
import { latestRecurrence, recurrenceLine } from './recurrence.js';
import type { ModelChecks } from './model-checks.js';

export const AUDIT_SCHEMA = 'forgen-audit/2' as const;
export const MANIFEST_SCHEMA = 'forgen-audit-manifest/1' as const;

export interface AuditOptions {
  folders?: string[];
  cwd?: string;
  claudeDir?: string;
  now?: Date;
  /** 섞임 후보의 "근거가 한 프로젝트" 신호(대화 기록에서 교정 위치 찾기). 기본 켬. */
  sessionEvidence?: boolean;
}

export interface FolderSummary {
  folder: string;
  projectKey: string | null;
  memoryDir: string | null;
  totalTokens: number;
  byLayer: Partial<Record<Layer, number>>;
  entries: FolderLoad['entries'];
  forgenRules: number;
  /** 결정적으로 줄일 수 있는 몫: 같은 문장의 남는 사본 + 낡은 줄. */
  reducible: { duplicate: number; stale: number; total: number; pct: number };
  /** 다른 프로젝트 섞임 후보가 이 폴더에서 차지하는 토큰(모델 판정 전). */
  mixCandidateTokens: number;
  /** 스킬·에이전트 목록 몫(앞머리 name·description 근사). */
  skills?: { tokens: number; count: number; bySource: Record<string, number> };
  /**
   * 0.9.0 두 층: 세션 시작에는 색인 줄로만 보이는 2층 룰 수와, 전부 들어오면 더해질 토큰(상한).
   * expected: 발동률 추정을 반영해 한 세션에 들어올 것으로 보는 토큰(승인 조건은 과거 세션 발동률, 넓은 조건은 늘 들어오는 것으로 — 절감 0).
   * N3 의 "최대치" = 상시 로드(1층 + 색인), "기대치" = 최대치 + expected. 선전에는 기대치를 쓴다.
   */
  forgenTier2?: { rules: number; tokens: number; expected?: number };
}

export interface AuditResult {
  schema: typeof AUDIT_SCHEMA;
  forgenVersion: string;
  generatedAt: string;
  claudeDir: string;
  forgenHome: string;
  model: { used: boolean; note: string };
  summary: {
    /** 첫 화면 첫 줄 — 가장 최근 `audit recurrence` 결과(§4.4 작을 때 규칙 적용). 없으면 status 'none'. */
    recurrence: { status: 'none' | 'ok' | 'insufficient' | 'incomplete' | 'no-data'; line: string; generatedAt?: string; window?: { since: string; until: string }; per1000?: { total: number; written: number }; per30d?: { total: number; written: number; corrections: number }; sampled?: boolean; tier2Missed?: number };
    tokens: { folders: number; min: number; max: number; median: number; reduciblePctMin: number; reduciblePctMax: number; reduciblePctMedian: number };
    /** conflicts·dupGroups·mixConfirmed 는 모델 판정 뒤의 확정 지적 수. 모델을 쓰지 않은 회차는 'pending'·null. */
    findings: { sameSentence: number; mixCandidates: number; stale: number; unscopedRules: number; claudeMdOver200: number; conflicts: number | 'pending'; dupGroups: number | null; mixConfirmed: number | null };
    /**
     * N3 같은 집합 비교(오너 결정 2026-11-26) — 처방 기준값(forgen fix 를 처음 적용할 때 남김)이 있을 때만. 처방 전에 실리던 룰·기억을
     * 그대로 실을 때의 토큰끼리 비교하고, 빈자리로 새로 실린 룰은 되살린 룰로 따로. allNow* 는 이전 정의(지금 실리는 전부).
     */
    n3?: { baselineAt: string; medianPct: number; allNowMedianPct: number; revived: number; revivedImportant: number; folders: Array<{ folder: string; before: number; sameSet: number; allNow: number; pct: number; allNowPct: number; revived: number; revivedImportant: number }> };
    truncation: { memoryDirs: number; truncated: number; tightest: { dir: string; folder: string | null; spareLines: number; spareBytes: number; spareItems: number; firstLimit: 'lines' | 'bytes' } | null };
  };
  folders: FolderSummary[];
  checks: {
    truncation: TruncationResult[];
    claudeMdOver200: Array<{ path: string; layer: Layer; lines: number }>;
    sameSentence: SameSentenceGroup[];
    stale: StaleRef[];
    mix: MixCandidate[];
    unscopedRules: UnscopedRule[];
    /** 모델 판정 검사(같은 뜻 중복·부딪힘·섞임 확정). --no-model 이면 없음. */
    model?: ModelChecks;
  };
  sources: { files: number; bytes: number; unreadable: Array<{ path: string; error: string }>; brokenRules: Array<{ file: string; error: string }> };
}

export interface ManifestSource { path: string; layers: string[]; bytes: number; sha256: string; error?: string }
export interface AuditManifest {
  schema: typeof MANIFEST_SCHEMA;
  forgenVersion: string;
  runId: string;
  generatedAt: string;
  claudeDir: string;
  forgenHome: string;
  folders: string[];
  sources: ManifestSource[];
  /** 원천 목록(경로·크기·해시) 전체의 해시. 같으면 같은 원천. */
  sourcesDigest: string;
  /**
   * 원천 밖에서 결과에 영향을 주는 입력(근거 교정 위치를 찾느라 읽는 대화 기록·근거 파일)의 지문.
   * 대화 기록은 크기가 커서 내용 해시 대신 (경로·크기·수정 시각)으로 센다. 없으면 그 신호를 쓰지 않은 회차.
   * "같은 manifest 면 같은 숫자"는 sourcesDigest + inputsDigest 가 같을 때다.
   */
  inputs?: { transcripts: { files: number; bytes: number }; evidence: { files: number }; digest: string };
  inputsDigest: string;
  /** 결과(생성 시각 제외)의 해시. 같은 원천이면 같아야 한다. */
  resultDigest: string;
  model: { used: false } | { used: true; judges: Array<{ model: string; version: string }>; candidates: Record<string, number> };
}

/**
 * 모델 판정·처방이 쓰는 비교 단위(결과 JSON 에는 넣지 않는다).
 *   units: 지시 줄·forgen 룰(세션 시작에 실리는 것과 잘린 색인 줄), topics: 감사한 메모 폴더의 주제 파일(파일 하나 = 한 단위)
 *   loadedIn: 단위 키(unitKey) → 그 단위가 세션 시작에 실리는 폴더들
 */
export interface AuditContext {
  units: Unit[]; topics: Unit[]; loadedIn: Map<string, string[]>; rules: Map<string, Rule>; projectKeys: string[]; homeMemoryIndex: Set<string>; memory: Map<string, MemoryDir>;
  /** 0.9.0 두 층: 룰 ID → 그 룰이 2층(색인 줄로 보이고 상황이 맞으면 들어옴)인 폴더들. Q11 — 누락 검사에서 실린 것으로 본다 */
  tier2In?: Map<string, string[]>;
}
export interface AuditRun { result: AuditResult; manifest: Omit<AuditManifest, 'runId'>; timing: Record<string, number>; ctx: AuditContext }

export const unitKey = (u: { path: string; line: number; ruleId?: string }) => `${u.ruleId ?? u.path}:${u.line}`;

/** 2층 룰이 한 세션에 들어올 비율(기대치 셈): 승인 조건은 추정 세션 발동률(넓음 ≥ 50% 은 1 — 절감 0), 게이트 통과 룰은 추정이 없어 0. */
export function expectedLoadShare(r: Rule | undefined): number {
  const e = r?.applies_when?.approved ? r.applies_when.estimate : undefined;
  if (!e) return 0;
  return e.sessions >= 0.5 ? 1 : Math.max(0, Math.min(1, e.sessions));
}

export function forgenVersion(): string {
  try { return (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version?: string }).version ?? ''; } catch { return ''; }
}

/** 대화 기록(최상위 세션 jsonl)·근거 파일의 (경로·크기·수정 시각) 지문. 읽지 않고 stat 만 한다. */
function statInputs(projectsDir: string, evidenceDir: string): NonNullable<AuditManifest['inputs']> {
  const rows: string[] = [];
  let tFiles = 0, tBytes = 0, eFiles = 0;
  const list = (d: string) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
  for (const proj of list(projectsDir)) {
    for (const f of list(path.join(projectsDir, proj))) {
      if (!f.endsWith('.jsonl')) continue;
      try { const st = fs.statSync(path.join(projectsDir, proj, f)); rows.push(`t:${proj}/${f}:${st.size}:${Math.floor(st.mtimeMs)}`); tFiles++; tBytes += st.size; } catch { /* 사라짐 */ }
    }
  }
  for (const f of list(evidenceDir)) {
    if (!f.endsWith('.json')) continue;
    try { const st = fs.statSync(path.join(evidenceDir, f)); rows.push(`e:${f}:${st.size}:${Math.floor(st.mtimeMs)}`); eFiles++; } catch { /* 사라짐 */ }
  }
  return { transcripts: { files: tFiles, bytes: tBytes }, evidence: { files: eFiles }, digest: sha(rows.join('\n')) };
}

function skillsBySource(s: SkillEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of s) out[e.source] = (out[e.source] ?? 0) + e.tokens;
  return out;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const GENERIC_KEYS = new Set(['home', 'workspace', 'projects', 'project', 'users', 'src', 'docs', 'test', 'tests', 'tmp', 'claude', 'memory']);

function ruleItem(r: Rule): WayItem {
  return { id: r.rule_id, kind: 'rule', statement: r.policy, applies_when: '', why: '', projects: r.projects ?? [], strength: r.strength, provenance: { kind: 'mined' }, enforceable: false };
}

/** 원천을 읽어 결정적 검사까지. 아무 파일도 쓰지 않는다. */
export function runAudit(opts: AuditOptions = {}): AuditRun {
  const timing: Record<string, number> = {};
  let t0 = performance.now();
  const lap = (k: string) => { const t = performance.now(); timing[k] = Math.round(t - t0); t0 = t; };
  const env: AuditEnv = defaultEnv(opts.claudeDir);
  const reader = new SourceReader();
  const folders = (opts.folders?.length ? opts.folders.map((f) => path.resolve(f)) : defaultFolders(env, opts.cwd ?? process.cwd()));
  const uniqFolders = [...new Set(folders.map((f) => { try { return fs.realpathSync(f); } catch { return f; } }))].sort();

  // 1. 호스트 기억 층 + 메모 폴더
  const memory = new Map<string, MemoryDir>();
  const hostLoads = uniqFolders.map((f) => hostLoadFor(reader, env, f, memory));
  for (const d of listMemoryDirs(env.claudeDir)) if (!memory.has(d)) memory.set(d, readMemoryDir(reader, d));
  lap('sources');

  // 2. forgen 룰 + 폴더별 세션 시작 렌더(상태를 쓰지 않는 경로)
  const scan = scanRuleFiles();
  for (const f of (() => { try { return fs.readdirSync(ME_RULES).filter((n) => n.endsWith('.json')).sort(); } catch { return []; } })()) reader.read(path.join(ME_RULES, f));
  const active = scan.rules.filter((r) => r.status === 'active');
  const ruleById = new Map(active.map((r) => [r.rule_id, r]));
  const loads: FolderLoad[] = hostLoads.map((h) => {
    let forgen = { tokens: 0, ruleIds: [] as string[], tier2Ids: [] as string[] };
    try {
      // 세션 시작 몫 = 1층 + 2층 색인 줄(두 층). 감사와 실제 세션 시작은 같은 렌더 함수를 쓴다.
      const r = renderSessionStartReadOnly(h.folder);
      forgen = { tokens: estimateTokens(r.text), ruleIds: [...r.includedRuleIds].sort(), tier2Ids: [...r.tier2RuleIds].sort() };
    } catch { /* 렌더 실패는 0 으로 */ }
    const hostTokens = h.entries.filter((e) => e.always).reduce((n, e) => n + e.tokens, 0);
    let projectKey: string | null = null;
    try { projectKey = projectKeyFor(h.folder); } catch { /* 없음 */ }
    const skills = readSkillCatalog(reader, env, h.gitRoot ?? null);
    const skillTokens = skills.reduce((n, s) => n + s.tokens, 0);
    return { ...h, projectKey, forgen, skills: { tokens: skillTokens, count: skills.length, bySource: skillsBySource(skills) }, totalTokens: hostTokens + forgen.tokens + skillTokens };
  });
  lap('forgenRender');

  // 3. 비교 단위
  const layerOf = new Map<string, Layer>();
  for (const l of loads) for (const e of l.entries) if (!layerOf.has(e.path)) layerOf.set(e.path, e.layer);
  const instructionUnits: Unit[] = [];
  for (const [p, layer] of [...layerOf].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const sf = reader.files.get(p);
    if (!sf) continue;
    const m = layer === 'memory-index' ? [...memory.values()].find((x) => x.index?.path === p) : undefined;
    instructionUnits.push(...markdownUnits(sf, layer, m ? m.loadedLines : Infinity));
  }
  // 잘린 뒤의 색인 줄도 같은 문장·낡음 대상(세션 시작엔 안 실림)
  for (const m of [...memory.values()].sort((a, b) => (a.dir < b.dir ? -1 : 1))) {
    if (!m.index || m.index.error) continue;
    const loadedHere = layerOf.has(m.index.path);
    instructionUnits.push(...markdownUnits(m.index, 'memory-index').filter((u) => !loadedHere || u.line > m.loadedLines));
  }
  const ruleUnits: Unit[] = active.map((r) => ({ text: r.policy, norm: normalizeSentence(r.policy), path: path.join(ME_RULES, `${r.rule_id}.json`), line: 0, layer: 'forgen-rule' as const, ruleId: r.rule_id, tokens: estimateTokens(ruleToText(r, { compact: true })) }));
  const auditedMemory = new Set(loads.map((l) => l.memoryDir).filter(Boolean));
  const topicUnits: Unit[] = [];
  const topicFiles: Unit[] = [];
  for (const m of memory.values()) if (auditedMemory.has(m.dir)) for (const t of m.topics) {
    topicUnits.push(...markdownUnits(t, 'memory-topic'));
    if (t.error) continue;
    const body = splitFrontmatter(t.text).body.replace(/\s+/g, ' ').trim();
    const desc = frontmatterField(t.text, 'description') ?? '';
    const text = `${desc}${desc && body ? ' / ' : ''}${body}`.slice(0, 500);
    if (text) topicFiles.push({ text, norm: normalizeSentence(text), path: t.path, line: 0, layer: 'memory-topic', tokens: estimateTokens(t.text), ...(t.memoryType ? { memoryType: t.memoryType } : {}) });
  }

  // 4. 검사
  const truncation = [...memory.values()].map(checkTruncation).filter((x): x is TruncationResult => !!x).sort((a, b) => (a.dir < b.dir ? -1 : 1));
  const sameSentence = checkSameSentence([...instructionUnits, ...ruleUnits, ...topicUnits]);
  const rootCache = new Map<string, string | null>();
  const rootOf = (file: string) => { const d = path.dirname(file); if (!rootCache.has(d)) rootCache.set(d, gitRootOf(d, env.home)); return rootCache.get(d) ?? null; };
  const memFolder = new Map<string, string | null>();
  for (const m of memory.values()) if (m.index) memFolder.set(m.index.path, m.folder ? (gitRootOf(m.folder, env.home) ?? m.folder) : null);
  const projectDirOf = (u: Unit): string | null => {
    if (u.layer === 'memory-index') return memFolder.get(u.path) ?? null;
    if (u.layer === 'project' || u.layer === 'project-local' || u.layer === 'project-rules' || u.layer === 'agents') return rootOf(u.path) ?? path.dirname(u.path);
    return null;
  };
  const stale = checkStale([...instructionUnits, ...ruleUnits], { home: env.home, projectDirOf });

  // 섞임 후보: 전역 층(관리형·사용자·사용자 룰·그 import, 홈 메모 색인, forgen 전역 룰)
  const keys = new Set<string>();
  for (const r of scan.rules) for (const p of r.projects ?? []) keys.add(p.toLowerCase());
  try { for (const k of Object.keys(readProjectRegistry().projects)) keys.add(k.toLowerCase()); } catch { /* 없음 */ }
  for (const l of loads) { if (l.projectKey) keys.add(l.projectKey); if (l.gitRoot) keys.add(path.basename(l.gitRoot).toLowerCase()); }
  keys.delete(path.basename(env.home).toLowerCase());
  for (const k of [...keys]) if (k.length < 4 || GENERIC_KEYS.has(k)) keys.delete(k);
  const globalFiles = new Set<string>();
  for (const l of loads) for (const e of l.entries) {
    if (e.layer === 'managed' || e.layer === 'user' || (e.layer === 'user-rules' && e.always)) globalFiles.add(e.path);
    if (e.layer === 'import' && e.via && globalFiles.has(e.via)) globalFiles.add(e.path);
  }
  const homeMemory = [...memory.values()].filter((m) => m.folder && (m.folder === env.home || isHomeDir(m.folder)));
  for (const m of homeMemory) if (m.index) globalFiles.add(m.index.path);
  const mixRaw: MixCandidate[] = [];
  const mixOf = (u: Unit, project: string | null, why: string) => mixRaw.push({ path: u.path, line: u.line, layer: u.layer, ...(u.ruleId ? { ruleId: u.ruleId } : {}), text: u.text, project, why: [why], tokens: u.tokens });
  const sortedKeys = [...keys].sort();
  for (const u of instructionUnits) {
    if (!globalFiles.has(u.path)) continue;
    const hit = projectKeysIn(u.text, sortedKeys);
    if (hit.length === 1) mixOf(u, hit[0], `프로젝트 "${hit[0]}" 언급`);
  }
  const globalRules = ruleUnits.filter((u) => { const r = ruleById.get(u.ruleId ?? ''); return r && !r.projects?.length && r.strength !== 'hard'; });
  const unitByRule = new Map(globalRules.map((u) => [u.ruleId, u]));
  for (const u of globalRules) {
    const hit = projectKeysIn(u.text, sortedKeys);
    if (hit.length === 1) mixOf(u, hit[0], `프로젝트 "${hit[0]}" 언급`);
  }
  const phantom: WayItem[] = sortedKeys.map((k) => ({ id: `key:${k}`, kind: 'habit', statement: '', applies_when: '', why: '', projects: [k], strength: 'default', provenance: { kind: 'mined' }, enforceable: false }));
  for (const s of projectSpecificSuspects([...globalRules.map((u) => ruleItem(ruleById.get(u.ruleId ?? '') as Rule)), ...phantom])) {
    const u = unitByRule.get(s.id);
    if (u && !s.why.startsWith('프로젝트')) mixOf(u, null, s.why);
  }
  lap('checksBase');
  // 근거 교정 위치(대화 기록·근거 파일을 읽는다) — 무거워서 시간을 따로 잰다. 읽은 입력은 manifest 의 inputs 에 남긴다.
  if (opts.sessionEvidence !== false) {
    try {
      for (const p of planSessionScopes({ projectsDir: path.join(env.claudeDir, 'projects') })) {
        const u = unitByRule.get(p.rule.rule_id);
        if (u && p.projects.length === 1) mixOf(u, p.projects[0], `근거 교정 ${p.sessions}세션이 모두 "${p.projects[0]}" 안`);
      }
    } catch { /* 대화 기록 문제는 이 신호만 빠진다 */ }
  }
  const inputs = opts.sessionEvidence !== false ? statInputs(path.join(env.claudeDir, 'projects'), ME_BEHAVIOR) : undefined;
  lap('sessionEvidence');
  const mix = mergeMixCandidates(mixRaw);

  // paths: 없는 룰, 200줄 넘는 CLAUDE.md
  const ruleFolders = new Map<string, number>();
  for (const l of loads) for (const e of l.entries) if ((e.layer === 'user-rules' || e.layer === 'project-rules') && e.always) ruleFolders.set(e.path, (ruleFolders.get(e.path) ?? 0) + 1);
  const unscopedRules: UnscopedRule[] = [...ruleFolders].map(([p, n]) => {
    const sf = reader.files.get(p);
    return { path: p, layer: layerOf.get(p) ?? 'project-rules', tokens: sf ? estimateTokens(sf.text) : 0, lines: sf?.lines ?? 0, folders: n };
  }).sort((a, b) => (a.path < b.path ? -1 : 1));
  const mdLayers = new Set<Layer>(['managed', 'user', 'project', 'project-local', 'agents', 'import']);
  const claudeMdOver200 = [...layerOf].filter(([p, l]) => mdLayers.has(l) && (reader.files.get(p)?.lines ?? 0) > 200)
    .map(([p, l]) => ({ path: p, layer: l, lines: reader.files.get(p)?.lines ?? 0 })).sort((a, b) => (a.path < b.path ? -1 : 1));

  // 5. 폴더별 토큰과 결정적으로 줄일 몫
  const staleKeys = new Set(stale.map((s) => `${s.ruleId ?? s.path}:${s.line}`));
  const loadedIn = new Map<string, string[]>();
  const ruleUnitTokens = new Map(ruleUnits.map((u) => [u.ruleId as string, u.tokens + 1]));
  const tier2In = new Map<string, string[]>();
  for (const l of loads) for (const id of l.forgen.tier2Ids ?? []) tier2In.set(id, [...(tier2In.get(id) ?? []), l.folder]);
  const folderSummaries: FolderSummary[] = loads.map((l) => {
    const always = new Set(l.entries.filter((e) => e.always).map((e) => e.path));
    const memIdx = l.memoryDir ? memory.get(l.memoryDir) : undefined;
    const included = new Set(l.forgen.ruleIds);
    const loaded = (u: { path: string; line: number; ruleId?: string; layer: string }) =>
      u.ruleId ? included.has(u.ruleId) : always.has(u.path) && (u.layer !== 'memory-index' || !memIdx || u.line <= memIdx.loadedLines);
    const unitsHere = [...instructionUnits, ...ruleUnits].filter(loaded);
    for (const u of unitsHere) { const k = unitKey(u); const arr = loadedIn.get(k) ?? []; if (!arr.includes(l.folder)) arr.push(l.folder); loadedIn.set(k, arr); }
    const byNorm = new Map<string, Unit[]>();
    for (const u of unitsHere) if (u.norm.length >= 20) { const g = byNorm.get(u.norm); if (g) g.push(u); else byNorm.set(u.norm, [u]); }
    const counted = new Set<string>();
    let duplicate = 0;
    for (const g of byNorm.values()) {
      const distinct = new Map<string, Unit>();
      for (const u of g) distinct.set(`${u.ruleId ?? u.path}:${u.line}`, u);
      if (new Set([...distinct.values()].map((u) => u.ruleId ?? u.path)).size < 2) continue;
      [...distinct.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(1).forEach(([k, u]) => { counted.add(k); duplicate += u.tokens; });
    }
    let staleTok = 0;
    for (const u of unitsHere) { const k = `${u.ruleId ?? u.path}:${u.line}`; if (staleKeys.has(k) && !counted.has(k)) { counted.add(k); staleTok += u.tokens; } }
    const mixTok = mix.filter((c) => loaded(c) && c.project !== l.projectKey).reduce((n, c) => n + c.tokens, 0);
    const byLayer: Partial<Record<Layer, number>> = {};
    for (const e of l.entries) if (e.always) byLayer[e.layer] = (byLayer[e.layer] ?? 0) + e.tokens;
    if (l.forgen.tokens) byLayer['forgen-render'] = l.forgen.tokens;
    if (l.skills?.tokens) (byLayer as Record<string, number>).skills = l.skills.tokens;
    const total = duplicate + staleTok;
    return {
      folder: l.folder, projectKey: l.projectKey, memoryDir: l.memoryDir, totalTokens: l.totalTokens, byLayer, entries: l.entries,
      forgenRules: l.forgen.ruleIds.length,
      reducible: { duplicate, stale: staleTok, total, pct: l.totalTokens ? Math.round((total / l.totalTokens) * 1000) / 10 : 0 },
      mixCandidateTokens: mixTok,
      ...(l.skills ? { skills: l.skills } : {}),
      ...(l.forgen.tier2Ids?.length ? { forgenTier2: { rules: l.forgen.tier2Ids.length, tokens: l.forgen.tier2Ids.reduce((n, id) => n + (ruleUnitTokens.get(id) ?? 0), 0), expected: Math.round(l.forgen.tier2Ids.reduce((n, id) => n + (ruleUnitTokens.get(id) ?? 0) * expectedLoadShare(ruleById.get(id)), 0)) } } : {}),
    };
  });
  lap('checks');

  const tokens = folderSummaries.map((f) => f.totalTokens);
  const pcts = folderSummaries.map((f) => f.reducible.pct);
  const tight = [...truncation].sort((a, b) => a.spareItems - b.spareItems || (a.dir < b.dir ? -1 : 1))[0];
  const files = [...reader.files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  const result: AuditResult = {
    schema: AUDIT_SCHEMA,
    forgenVersion: forgenVersion(),
    generatedAt: (opts.now ?? new Date()).toISOString(),
    claudeDir: env.claudeDir,
    forgenHome: FORGEN_HOME,
    model: { used: false, note: '결정적 검사만 했고 아무것도 기기 밖으로 보내지 않았다(--no-model). 같은 말 다시 하기(첫 줄)는 `forgen audit recurrence` 의 저장된 결과를 읽는다.' },
    summary: {
      recurrence: (() => {
        const rec = latestRecurrence();
        if (!rec || rec.status === 'model-off') return { status: 'none' as const, line: recurrenceLine(null) };
        return {
          status: rec.status, line: recurrenceLine(rec), generatedAt: rec.generatedAt, window: { since: rec.window.since, until: rec.window.until },
          per1000: { total: rec.per1000.total, written: rec.per1000.written }, per30d: { total: rec.per30d.total, written: rec.per30d.written, corrections: rec.corrections.per30d }, sampled: rec.prompts.limit !== null, tier2Missed: rec.counts.tier2Missed ?? 0,
        };
      })(),
      tokens: { folders: tokens.length, min: tokens.length ? Math.min(...tokens) : 0, max: tokens.length ? Math.max(...tokens) : 0, median: median(tokens), reduciblePctMin: pcts.length ? Math.min(...pcts) : 0, reduciblePctMax: pcts.length ? Math.max(...pcts) : 0, reduciblePctMedian: pcts.length ? [...pcts].sort((a, b) => a - b)[pcts.length >> 1] : 0 },
      findings: { sameSentence: sameSentence.length, mixCandidates: mix.length, stale: stale.length, unscopedRules: unscopedRules.length, claudeMdOver200: claudeMdOver200.length, conflicts: 'pending', dupGroups: null, mixConfirmed: null },
      truncation: { memoryDirs: truncation.length, truncated: truncation.filter((t) => t.overLines || t.overBytes).length, tightest: tight ? { dir: tight.dir, folder: tight.folder, spareLines: tight.spareLines, spareBytes: tight.spareBytes, spareItems: tight.spareItems, firstLimit: tight.firstLimit } : null },
    },
    folders: folderSummaries,
    checks: { truncation, claudeMdOver200, sameSentence, stale, mix, unscopedRules },
    sources: {
      files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0),
      unreadable: files.filter((f) => f.error).map((f) => ({ path: f.path, error: f.error ?? '' })),
      brokenRules: [...scan.broken].sort((a, b) => (a.file < b.file ? -1 : 1)),
    },
  };
  const layersByPath = new Map<string, Set<string>>();
  const tag = (p: string, layer: string) => { const s = layersByPath.get(p) ?? new Set<string>(); s.add(layer); layersByPath.set(p, s); };
  for (const l of loads) for (const e of l.entries) tag(e.path, e.layer);
  for (const m of memory.values()) {
    if (m.index) tag(m.index.path, 'memory-index');
    for (const t of m.topics) tag(t.path, 'memory-topic');
  }
  const sources: ManifestSource[] = files.map((f) => ({
    path: f.path,
    layers: [...(layersByPath.get(f.path) ?? new Set(f.path.startsWith(ME_RULES) ? ['forgen-rule'] : ['other']))].sort(),
    bytes: f.bytes, sha256: f.sha256, ...(f.error ? { error: f.error } : {}),
  }));
  const manifest = {
    schema: MANIFEST_SCHEMA, forgenVersion: result.forgenVersion, generatedAt: result.generatedAt,
    claudeDir: env.claudeDir, forgenHome: FORGEN_HOME, folders: uniqFolders, sources,
    sourcesDigest: sha(JSON.stringify(sources)), ...(inputs ? { inputs } : {}), inputsDigest: inputs?.digest ?? 'none',
    resultDigest: resultDigest(result), model: { used: false as const },
  };
  const homeMemoryIndex = new Set(homeMemory.map((m) => m.index?.path).filter((p): p is string => !!p));
  const seenUnit = new Set<string>();
  const units = [...instructionUnits, ...ruleUnits].filter((u) => { const k = unitKey(u); if (seenUnit.has(k)) return false; seenUnit.add(k); return true; });
  return { result, manifest, timing, ctx: { units, topics: topicFiles, loadedIn, rules: ruleById, projectKeys: sortedKeys, homeMemoryIndex, memory, ...(tier2In.size ? { tier2In } : {}) } };
}

/** 생성 시각을 뺀 결과의 해시 — 같은 원천이면 같은 값. */
export function resultDigest(r: AuditResult): string {
  const { generatedAt: _g, ...rest } = r;
  return sha(JSON.stringify(rest));
}

/** <FORGEN_HOME>/audit/<회차>/ 에 manifest.json 과 audit.html 을 쓴다(권한 600, 폴더 700). */
export function writeRun(run: AuditRun, html: (r: AuditResult, runId: string) => string): { dir: string; runId: string; manifestPath: string; htmlPath: string } {
  const base = path.join(FORGEN_HOME, 'audit');
  const stamp = run.result.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let runId = `${stamp}-${run.manifest.sourcesDigest.slice(0, 8)}`;
  for (let i = 2; fs.existsSync(path.join(base, runId)); i++) runId = `${stamp}-${run.manifest.sourcesDigest.slice(0, 8)}-${i}`;
  const dir = path.join(base, runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(base, 0o700); fs.chmodSync(dir, 0o700); } catch { /* 윈도우 등 */ }
  const manifest: AuditManifest = { ...run.manifest, runId };
  const manifestPath = path.join(dir, 'manifest.json');
  const htmlPath = path.join(dir, 'audit.html');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(htmlPath, html(run.result, runId), { mode: 0o600 });
  // 검수(audit review --kind)가 이 회차의 판정을 읽는다.
  fs.writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify(run.result)}\n`, { mode: 0o600 });
  try { fs.chmodSync(manifestPath, 0o600); fs.chmodSync(htmlPath, 0o600); } catch { /* 윈도우 등 */ }
  return { dir, runId, manifestPath, htmlPath };
}
