import * as yaml from 'js-yaml';
import { normalizeColloquialKo } from './ko-colloquial.js';

// ── Types ──

export type SolutionStatus = 'experiment' | 'candidate' | 'verified' | 'mature' | 'retired';
export type SolutionType =
  | 'pattern'
  | 'solution'
  | 'decision'
  | 'troubleshoot'
  | 'anti-pattern'
  | 'convention';

export interface SolutionEvidence {
  injected: number;
  reflected: number;
  negative: number;
  sessions: number;
  reExtracted: number;
}

export interface SolutionFrontmatter {
  name: string;
  version: number;
  status: SolutionStatus;
  confidence: number;
  type: SolutionType;
  scope: 'me' | 'team' | 'project' | 'universal';
  tags: string[];
  identifiers: string[];
  evidence: SolutionEvidence;
  created: string;
  updated: string;
  supersedes: string | null;
  extractedBy: 'auto' | 'manual';
  /**
   * 적용 프로젝트 키(룰의 `projects` 와 같은 키: git 저장소 폴더 이름 소문자). 없으면 전역.
   * 구버전 파서는 모르는 키를 무시하므로 호환된다(검증이 추가 키를 거부하지 않는다).
   */
  projects?: string[];
  /** 은퇴 사유 (D6). stale=기간 경과, contradicted=반증, manual=사용자 지정. 없으면 사유 미상(구버전 은퇴). */
  retiredReason?: RetiredReason;
  retiredAt?: string;
}

export type RetiredReason = 'stale' | 'contradicted' | 'manual';

export interface SolutionV3 {
  frontmatter: SolutionFrontmatter;
  context: string;
  content: string;
  filePath?: string;
}

export interface SolutionIndexEntry {
  name: string;
  status: SolutionStatus;
  confidence: number;
  type: SolutionType;
  scope: 'me' | 'team' | 'project' | 'universal';
  tags: string[];
  /** 적용 프로젝트 키 (없으면 전역). */
  projects?: string[];
  /**
   * Pre-expanded tag set, computed at index build time via the term normalizer.
   * Contains `tags` plus every related match term from the canonical families
   * they belong to.
   *
   * T2 scope (current): populated as forward-looking metadata for T3's
   * ranking-decision log (which records raw + normalized query/solution
   * terms for offline explainability) and T4's BM25 term-frequency stats.
   * **NOT consumed by the current matcher** — `rankCandidates` and
   * `calculateRelevance` still use raw `tags` for intersection to preserve
   * the Round 3 baseline (bidirectional expansion would inflate recall 5-10×
   * and invalidate fixture metrics). A future PR that uses `normalizedTags`
   * in scoring must update `ROUND3_BASELINE` in the same commit.
   *
   * Not persisted — recomputed on every index build. Safe to regenerate whenever
   * `DEFAULT_MATCH_TERMS` changes.
   */
  normalizedTags: string[];
  identifiers: string[];
  filePath: string;
}

export const DEFAULT_EVIDENCE: SolutionEvidence = {
  injected: 0,
  reflected: 0,
  negative: 0,
  sessions: 0,
  reExtracted: 0,
};

const VALID_STATUSES: SolutionStatus[] = [
  'experiment',
  'candidate',
  'verified',
  'mature',
  'retired',
];
const VALID_TYPES: SolutionType[] = [
  'pattern',
  'solution',
  'decision',
  'troubleshoot',
  'anti-pattern',
  'convention',
];

// ── Helpers ──

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return slug || `untitled-${Date.now()}`;
}

// ── Validation ──

/** Runtime type guard for SolutionFrontmatter */
export function validateFrontmatter(fm: unknown): fm is SolutionFrontmatter {
  return diagnoseFrontmatter(fm).length === 0;
}

/**
 * Return a list of validation errors for a parsed frontmatter object.
 *
 * Empty array = valid. Non-empty = each entry describes one missing/wrong
 * field. Callers that only need a boolean should use `validateFrontmatter`.
 * Slow path (quarantine logging) uses this to produce actionable diagnostics.
 */
export function diagnoseFrontmatter(fm: unknown): string[] {
  const errors: string[] = [];
  if (fm == null || typeof fm !== 'object') {
    errors.push('frontmatter is not an object');
    return errors;
  }
  const o = fm as Record<string, unknown>;

  if (typeof o.name !== 'string') errors.push('name: must be string');
  if (typeof o.version !== 'number' || o.version <= 0) errors.push('version: must be positive number');
  if (typeof o.status !== 'string' || !VALID_STATUSES.includes(o.status as SolutionStatus))
    errors.push(`status: must be one of ${VALID_STATUSES.join('|')}`);
  if (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 1)
    errors.push('confidence: must be number in [0,1]');
  if (typeof o.type !== 'string' || !VALID_TYPES.includes(o.type as SolutionType))
    errors.push(`type: must be one of ${VALID_TYPES.join('|')}`);
  if (o.scope !== 'me' && o.scope !== 'team' && o.scope !== 'project' && o.scope !== 'universal')
    errors.push('scope: must be me|team|project|universal');
  if (!Array.isArray(o.tags) || !o.tags.every((t: unknown) => typeof t === 'string'))
    errors.push('tags: must be string[]');
  if (!Array.isArray(o.identifiers) || !o.identifiers.every((t: unknown) => typeof t === 'string'))
    errors.push('identifiers: must be string[]');
  if (typeof o.created !== 'string') errors.push('created: must be string');
  if (typeof o.updated !== 'string') errors.push('updated: must be string');
  if (o.supersedes !== null && typeof o.supersedes !== 'string')
    errors.push('supersedes: must be string or null');
  if (o.extractedBy !== 'auto' && o.extractedBy !== 'manual')
    errors.push('extractedBy: missing or not auto|manual');

  if (o.evidence == null || typeof o.evidence !== 'object') {
    errors.push('evidence: block missing');
  } else {
    const ev = o.evidence as Record<string, unknown>;
    const evFields = ['injected', 'reflected', 'negative', 'sessions', 'reExtracted'] as const;
    for (const f of evFields) {
      if (typeof ev[f] !== 'number') errors.push(`evidence.${f}: must be number`);
    }
  }
  return errors;
}

// ── Parsing ──

/** Parse YAML frontmatter from solution file content */
export function parseFrontmatterOnly(content: string): SolutionFrontmatter | null {
  try {
    const trimmed = content.trimStart();
    if (!trimmed.startsWith('---')) return null;

    const endIdx = trimmed.indexOf('---', 3);
    if (endIdx === -1) return null;

    const raw = trimmed.slice(3, endIdx);

    // YAML bomb protection: reject oversized frontmatter
    if (raw.length > 5000) return null;

    // YAML anchor abuse protection
    const anchorCount = (raw.match(/(?<=\s|^)&\w+/g) ?? []).length;
    if (anchorCount > 3) return null;

    const parsed = yaml.load(raw, { schema: yaml.CORE_SCHEMA });
    if (!validateFrontmatter(parsed)) return null;

    return parsed;
  } catch {
    return null;
  }
}

/** Parse a full V3 solution file into its components */
export function parseSolutionV3(content: string): SolutionV3 | null {
  try {
    const frontmatter = parseFrontmatterOnly(content);
    if (!frontmatter) return null;

    // Extract body after the closing ---
    const trimmed = content.trimStart();
    const endIdx = trimmed.indexOf('---', 3);
    const body = trimmed.slice(endIdx + 3).trim();

    const contextHeader = '## Context';
    const contentHeader = '## Content';
    const ctxIdx = body.indexOf(contextHeader);
    const cntIdx = body.indexOf(contentHeader);

    let context = '';
    let solutionContent = '';

    if (ctxIdx !== -1 && cntIdx !== -1) {
      context = body.slice(ctxIdx + contextHeader.length, cntIdx).trim();
      solutionContent = body.slice(cntIdx + contentHeader.length).trim();
    } else if (ctxIdx !== -1) {
      context = body.slice(ctxIdx + contextHeader.length).trim();
    } else if (cntIdx !== -1) {
      solutionContent = body.slice(cntIdx + contentHeader.length).trim();
    } else {
      // No headers — treat entire body as content
      solutionContent = body;
    }

    return { frontmatter, context, content: solutionContent };
  } catch {
    return null;
  }
}

// ── Serialization ──

/** Serialize a SolutionV3 to a markdown string with YAML frontmatter */
export function serializeSolutionV3(solution: SolutionV3): string {
  const yamlStr = yaml.dump(solution.frontmatter, {
    lineWidth: -1,
    quoteStyle: 'double',
    schema: yaml.CORE_SCHEMA,
  });
  return `---\n${yamlStr}---\n\n## Context\n${solution.context}\n\n## Content\n${solution.content}\n`;
}

// ── Format Detection ──

/** Check if content is in V1 format (# Title + > Type: pattern) */
export function isV1Format(content: string): boolean {
  const lines = content.split('\n');
  let hasTitle = false;
  let hasType = false;
  for (const line of lines) {
    if (line.startsWith('# ')) hasTitle = true;
    if (line.startsWith('> Type:')) hasType = true;
    if (hasTitle && hasType) return true;
  }
  return false;
}

// ── Tag Extraction ──

/** 한국어 불용어 — 태그로 의미 없는 일반 단어 */
const KO_STOPWORDS = new Set([
  // 일반 불용어
  '적용',
  '패턴',
  '모든',
  '같은',
  '발견',
  '다른',
  '사용',
  '경우',
  '위해',
  '통해',
  '대한',
  '이후',
  '때문',
  '하는',
  '있는',
  '없는',
  '되는',
  '관련',
  '해야',
  '하고',
  '있다',
  '없다',
  '한다',
  '이런',
  '그런',
  '저런',
  '매우',
  '항상',
  '모두',
  '각각',
  '대해',
  '여러',
  '시작',
  '그것',
  '이것',
  '저것',
  '아주',
  '정말',
  '너무',
  '많이',
  '자주',
  '가장',
  '먼저',
  '이미',
  '아직',
  '그냥',
  '바로',
  '다시',
  '함께',
  '위한',
  '따라',
  '부분',
  '전체',
  '방법',
  '내용',
  '결과',
  '문제',
  '시점',
  '설정',
  '작업',
  '확인',
  '수행',
  '처리',
  '기본',
  '추가',
  '변경',
  '제거',
  '포함',
  '생성',
  '실행',
  '완료',
  '필요',
  // 조사/어미/접속사 — Jaccard 분모 희석 방지
  '에서',
  '으로',
  '에게',
  '에는',
  '에도',
  '까지',
  '부터',
  '보다',
  '처럼',
  '만큼',
  '대로',
  '밖에',
  '뿐만',
  '이나',
  '이고',
  '이면',
  '이라',
  '인데',
  '했는데',
  '됐는데',
  '있으면',
  '없으면',
  '하면',
  '되면',
  '하지',
  '되지',
  '하며',
  '되며',
  '에서의',
  '으로의',
  '라는',
  '라고',
  '이라고',
  '때문에',
  '아니라',
  '하지만',
  '그러나',
  '그래서',
  '따라서',
  '그리고',
  '그러면',
  '만약',
  '비록',
  '하여',
  '않고',
  '않은',
  '않는',
  '해서',
  '해도',
  '해야',
  // 일반 동사/형용사 어간 — 의미 없는 고빈도 단어
  '가능',
  '상태',
  '이유',
  '방지',
  '의존',
  '의존성',
  '즉시',
  '원칙',
  '근거',
  '수정',
  '제안',
  '기능',
  '구현',
  '구조',
  '단계',
  '목적',
  '상황',
  '조건',
  '규칙',
  '동작',
  '활성',
  '비활성',
  '원래',
  '현재',
  '이전',
  '다음',
  '최종',
]);

/**
 * 솔루션 태그에서만 빼는 템플릿·메타 단어 (D5). "무엇: … 왜: … 어떻게: …" 형식과 설명문에서 태그로 새어 나오고, 대부분의 솔루션에 있어
 * 변별력이 없다. 룰 클러스터링·룰 관련도 같은 다른 extractTags 소비자는 이 단어를 그대로 쓰므로 `solution: true` 일 때만 적용한다.
 */
export const KO_TEMPLATE_WORDS = new Set([
  '무엇',
  '실제',
  '실제로',
  '파일',
  '왜냐',
  '주의',
  '예시',
  '대신',
  '기존',
  '해당',
  '각각',
  '항상',
  '반드시',
  '때문',
  '위해',
  '통해',
  '경우',
  '사용자에게',
  '않는다',
  '않다',
  '있다',
  '없다',
  '말고',
  '하지',
]);

/** 동사 활용 꼴("나오면", "확인하려면", "반복되면") — 주제어가 아니다. "화면"·"표면" 같은 명사는 걸리지 않는 어미만 쓴다. */
const KO_VERBAL_NOISE_RE = /(?:으면|오면|우면|하면|되면|려면|라면|하거나|는지|은지)$/;

/**
 * 조사 제거가 어간을 자르는 명사 ("고빈도"→"고빈"). 끝 글자가 조사(도·이·가·의·과·와·만·로)와 같은 흔한 명사만 보호한다.
 * 목록은 보수적으로 — 새 항목은 실제로 잘린 사례가 확인될 때만 추가한다.
 */
export const KO_PROTECTED_NOUNS = new Set([
  '고빈도', '저빈도', '빈도', '강도', '속도', '정도', '온도', '밀도', '각도', '난이도', '신뢰도', '완성도', '정확도',
  '중요도', '만족도', '유사도', '관련도', '해상도', '투명도', '적합도', '이해도', '인지도', '선호도', '활용도', '진척도',
  '숙련도', '충실도', '채도', '명도', '습도', '농도', '연도', '제도', '태도', '지도', '정보밀도', '우선도', '가시도',
  '차이', '사이', '아이', '높이', '길이', '깊이', '넓이', '나이', '다이', '라이', '모이', '세이',
  '평가', '고가', '저가', '단가', '물가', '시가', '대가', '원가', '지가', '공과', '성과', '효과', '결과', '교과', '연과',
  '의의', '회의', '합의', '동의', '논의', '심의', '건의', '주의', '계의',
]);

/** 영어 불용어 */
export const EN_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'are',
  'was',
  'were',
  'been',
  'have',
  'has',
  'had',
  'not',
  'but',
  'all',
  'can',
  'will',
  'use',
  'used',
  'using',
  'when',
  'each',
  'which',
  'their',
  'also',
  'into',
  'more',
  'some',
  'than',
  'other',
  'should',
  'would',
  'could',
  'about',
  'after',
  'before',
  'between',
  'does',
  'only',
  'across',
  'just',
  'detected',
  'based',
  'sessions',
  'prompts',
]);

/** 한국어 일반 조사/어미 — strip 대상 (긴 것부터 매칭)
 *
 * term-matcher에서 재사용 가능하도록 export — 매칭 시점과 추출 시점의 stripping
 * 규칙을 단일 source of truth로 유지해 한국어 stem 비교 정합성 보장.
 *
 * 주의: 이 리스트는 **추출 시점에도 적용**되므로 1글자 suffix를 추가할 때
 * `집중`→`집`, `시도`→`시` 같은 한자어 명사가 깨지지 않도록 극도로 보수적으로
 * 유지한다. 동사 활용형(`리팩토링중`, `배포시`)처럼 매칭 전용 suffix가 필요하면
 * term-matcher의 `KO_VERBAL_SUFFIXES`에 따로 둔다.
 */
export const KO_SUFFIXES = [
  '했습니다',
  '있습니다',
  '합니다',
  '입니다',
  '됩니다',
  '에서는',
  '으로는',
  '에게는',
  '에서',
  '까지',
  '으로',
  '이랑',
  '에게',
  '한테',
  '부터',
  '처럼',
  '보다',
  '마다',
  '하는',
  '하고',
  '했다',
  '된다',
  '한다',
  '을',
  '를',
  '이',
  '가',
  '은',
  '는',
  '의',
  '에',
  '와',
  '과',
  '도',
  '만',
  '로',
];

export function stripKoSuffix(word: string): string {
  if (KO_PROTECTED_NOUNS.has(word)) return word;
  for (const suffix of KO_SUFFIXES) {
    if (word.endsWith(suffix) && word.length > suffix.length) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/** 최대 태그 수 — Jaccard 분모 희석 방지 */
const MAX_TAGS = 8;

/**
 * Extract tags from text.
 * Korean 2-char words preserved (e.g. "에러", "배포"), stopwords filtered.
 * English words require 3+ chars, stopwords filtered.
 * Tags capped at MAX_TAGS, ranked by frequency.
 *
 * NOTE on hyphens: this function strips `-` to a space (`api-key` query token
 * becomes `api` and `key` separately). Solution-side compound tags are
 * recovered downstream by `expandCompoundTags`, and query-side bigram
 * recovery is done by `expandQueryBigrams`. Both ship as part of R4-T1
 * (compound-tag tokenizer fix) — see `docs/plans/2026-04-08-t4-bm25-skip-adr.md`
 * "Round 4 candidates" section for the rationale. Changing this regex
 * directly was considered but rejected: it would silently shift the index
 * representation of every existing solution, requiring an index rebuild and
 * a fresh `ROUND3_BASELINE` measurement on every downstream PR.
 */
export function extractTags(text: string, opts: { solution?: boolean } = {}): string[] {
  const cleaned = text.toLowerCase().replace(/[^가-힣a-z0-9\s]/g, ' ');

  const words = cleaned.split(/\s+/).filter(Boolean);
  const freq = new Map<string, number>();

  for (const w of words) {
    const isKorean = /[가-힣]/.test(w);
    if (isKorean && w.length >= 2) {
      const base = normalizeColloquialKo(w);
      if (base === null) continue;
      if (opts.solution && KO_VERBAL_NOISE_RE.test(base) && base.length >= 3) continue;
      const stem = stripKoSuffix(base);
      if (stem.length >= 2 && !KO_STOPWORDS.has(stem) && !(opts.solution && KO_TEMPLATE_WORDS.has(stem))) {
        freq.set(stem, (freq.get(stem) ?? 0) + 1);
      }
    } else if (!isKorean && w.length > 2 && !EN_STOPWORDS.has(w)) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }

  // 빈도 높은 순으로 MAX_TAGS개만 반환
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TAGS)
    .map(([tag]) => tag);
}

/** 솔루션 태그 추출 (저장·질의 공통): extractTags + 템플릿 단어·활용형 제거. */
export function extractSolutionTags(text: string): string[] {
  return extractTags(text, { solution: true });
}

// ── Compound-tag expansion (R4-T1) ──
//
// The matcher's tag intersection step compares solution.tags directly
// against the (expanded) query tag set. Hyphenated solution tags like
// `api-key`, `code-review`, `red-green-refactor` only intersect literal
// query tokens that contain the hyphen — but `extractTags` strips hyphens
// from query input, so a query "api keys" produces ['api', 'keys'] and
// never reaches the compound `api-key` tag via direct intersection. The
// existing `partialMatches` substring rule catches some of these at half
// weight, but the half-weight discount + a Jaccard denominator that doesn't
// know about the compound structure means the right solution still loses
// to a competitor that has a generic single-word match (`api`,
// `code`, `function`).
//
// R4-T1 fixes this from BOTH sides:
//   - solution-side: `expandCompoundTags` returns the raw tags PLUS the
//     hyphen-split parts (≥3 chars each), so `api-key` indexes as
//     {api-key, api, key}. The compound tag stays in the set so existing
//     literal hits keep working.
//   - query-side: `expandQueryBigrams` adds adjacent-token compounds and
//     a singular-stem variant (`api keys` → +{api-key, apikey, api-keys,
//     apikeys}), so the compound tag still wins via direct intersection
//     even after the query lost its hyphen during extraction.
//
// Both helpers are intentionally lossless additions on top of the raw
// tag/token list — callers that pass these into `calculateRelevance` MUST
// keep the RAW tags for the Jaccard union denominator (otherwise the
// expanded set inflates the union and silently shifts the score). The
// `solutionTagsExpanded` option on `calculateRelevance` enforces this
// separation: matching uses expanded, normalization uses raw.

/** Minimum length of a hyphen-split part to be kept as an alternative tag. */
const COMPOUND_PART_MIN_LENGTH = 3;

/**
 * Expand a solution tag list with hyphen-split alternatives.
 *
 * Each input tag is preserved verbatim, and any tag containing `-` also
 * contributes its parts (length ≥ 3 each) as additional tags. The output
 * is deduplicated.
 *
 * Examples:
 *   - `['api-key', 'security']` → `['api-key', 'api', 'key', 'security']`
 *   - `['code-review', 'quality']` → `['code-review', 'code', 'review', 'quality']`
 *   - `['n+1', 'database']` → `['n+1', 'database']` (no hyphen, n+1 unchanged)
 *   - `['red-green-refactor']` → `['red-green-refactor', 'red', 'green', 'refactor']`
 *   - `['typescript']` → `['typescript']` (no hyphen, no expansion)
 *
 * Korean compound tags (`API에러`, `테스트주도개발`) are preserved verbatim
 * because they contain no `-`. The expansion is intentionally English-
 * compound-aware only — Korean compound recovery is not in scope for R4-T1
 * (the existing `term-normalizer` family expansion handles Korean ↔ English
 * cross-mapping).
 *
 * The output ordering is insertion order: original tags first, then split
 * parts in left-to-right order. Stable across runs (Set + Array dedup).
 */
export function expandCompoundTags(tags: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of tags) {
    out.add(t);
    if (t.includes('-')) {
      for (const part of t.split('-')) {
        if (part.length >= COMPOUND_PART_MIN_LENGTH) {
          out.add(part);
        }
      }
    }
  }
  return [...out];
}

/**
 * Expand a query tag list with adjacent-token bigram alternatives.
 *
 * For each adjacent (a, b) pair where both tokens are length ≥ 3, the
 * function adds:
 *   - `a-b`   (hyphen-joined form, e.g. `api-key`)
 *   - `ab`    (concatenated form, e.g. `apikey`)
 *   - `a-b'`  (singular stem of b, only if b ends in `s` and length > 3)
 *   - `ab'`   (concatenated singular stem)
 *
 * Examples:
 *   - `['api', 'keys']` → `['api', 'keys', 'api-key', 'apikey', 'api-keys', 'apikeys']`
 *   - `['code', 'review']` → `['code', 'review', 'code-review', 'codereview']`
 *   - `['red', 'green', 'refactor']` → `[..., 'red-green', 'redgreen', 'green-refactor', 'greenrefactor']`
 *
 * Plural→singular stem is intentionally minimal: only `s`-suffix removal,
 * no `es`/`ies` handling. The cost-benefit is asymmetric — `apis → api`
 * is the highest-value case and is handled correctly; `classes → classe`
 * is wrong but doesn't matter because no solution tag is `classe`.
 *
 * Why both `-` and concatenated forms: solution tag conventions vary
 * across packs (`api-key` vs `apikey`), and this expansion is cheap.
 * The downstream intersection check is O(M) per solution where M = expanded
 * query tag count, so even doubling the query tag count is well within
 * the matcher's hot-path budget for the corpus sizes Forgen targets
 * (N ≤ 200 solutions).
 *
 * Korean tokens (`/[가-힣]/`) are passed through verbatim: bigram
 * concatenation of Korean compound words is meaningless because the
 * boundary is lexical, not whitespace-driven (`디버깅` is one word, not
 * two adjacent tokens). Only ASCII-letter pairs participate.
 */
export function expandQueryBigrams(tags: readonly string[]): string[] {
  const out = new Set<string>(tags);
  for (let i = 0; i < tags.length - 1; i++) {
    const a = tags[i];
    const b = tags[i + 1];
    if (a.length < 3 || b.length < 3) continue;
    // ASCII-only filter — Korean bigrams are not meaningful (see header).
    if (!/^[a-z0-9]+$/.test(a) || !/^[a-z0-9]+$/.test(b)) continue;
    out.add(`${a}-${b}`);
    out.add(`${a}${b}`);
    if (b.endsWith('s') && b.length > 3) {
      const bSing = b.slice(0, -1);
      out.add(`${a}-${bSing}`);
      out.add(`${a}${bSing}`);
    }
  }
  return [...out];
}

/**
 * 한국어 활용형 어간 회복 (매칭 **쿼리 전용** — vec-probe 2026-07-20 실측 갭).
 *
 * `KO_SUFFIXES`(조사)와 term-matcher의 `KO_VERBAL_SUFFIXES`(`중`,`시`)는
 * `검증해줘`·`최적화하자`·`배포하면` 같은 회화체 활용형에 도달하지 못한다 —
 * 자연어 한국어 프롬프트에서 `검증` 계열 솔루션 태그가 영원히 매칭 불가.
 * (match-eval-log 2,371행 기준 한국어 장형 토큰의 지배적 형태가 이 부류.)
 *
 * 규칙: `어간(≥2자) + (했|하|해|됐|되|돼) + 나머지` 형태에서 어간을 **추가**한다
 * — 원본 토큰은 유지(치환 아님)라 오탐은 확장 노이즈에 그치고, ≥2자 어간
 * 요구가 `이해`·`피해`·`유해물질`(하/해가 1번째 위치) 류 명사를 보호한다.
 * 쿼리 사이드만 확장하므로 인덱스 재구축·ROUND3_BASELINE 재측정이 불필요
 * (expandQueryBigrams와 같은 계약).
 */
const KO_CONJUGATION_RE = /^([가-힣]{2,}?)(했|하|해|됐|되|돼|할)[가-힣]*$/;

export function expandQueryKoreanStems(tags: readonly string[]): string[] {
  const out = new Set<string>(tags);
  for (const tag of tags) {
    if (!/^[가-힣]+$/.test(tag)) continue;
    const m = tag.match(KO_CONJUGATION_RE);
    if (m) out.add(m[1]);
  }
  return [...out];
}

// ── Migration ──

const V1_TYPE_MAP: Record<string, SolutionType> = {
  solution: 'pattern',
  rule: 'decision',
  convention: 'decision',
  pattern: 'pattern',
};

/** Migrate a V1-format solution file to V3 format */
export function migrateV1toV3(content: string, filePath: string): string {
  const lines = content.split('\n');

  let title = '';
  let v1Type = '';
  let scope: 'me' | 'project' = 'me';
  let bodyStartIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!title && line.startsWith('# ')) {
      title = line.replace(/^#\s+/, '').trim();
      bodyStartIdx = i + 1;
    }
    if (line.startsWith('> Type:')) {
      v1Type = line.replace('> Type:', '').trim().toLowerCase();
      bodyStartIdx = Math.max(bodyStartIdx, i + 1);
    }
    if (line.startsWith('> Scope:')) {
      const rawScope = line.replace('> Scope:', '').trim().toLowerCase();
      scope = rawScope === 'project' ? 'project' : 'me';
      bodyStartIdx = Math.max(bodyStartIdx, i + 1);
    }
  }

  // Skip remaining metadata lines (> Classification:, > Created:, blank lines right after)
  while (bodyStartIdx < lines.length) {
    const l = lines[bodyStartIdx].trim();
    if (l.startsWith('>') || l === '') {
      bodyStartIdx++;
    } else {
      break;
    }
  }

  const body = lines.slice(bodyStartIdx).join('\n').trim();
  const today = new Date().toISOString().split('T')[0];
  const name = slugify(title || filePath);
  const type = V1_TYPE_MAP[v1Type] ?? 'pattern';
  const tags = extractTags(`${title} ${body}`);

  const solution: SolutionV3 = {
    frontmatter: {
      name,
      version: 1,
      status: 'candidate',
      confidence: 0.5,
      type,
      scope,
      tags,
      identifiers: [],
      evidence: { ...DEFAULT_EVIDENCE },
      created: today,
      updated: today,
      supersedes: null,
      extractedBy: 'auto',
    },
    context: '',
    content: body,
  };

  return serializeSolutionV3(solution);
}
