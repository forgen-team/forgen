/**
 * Rule relevance — "이번 턴에 어떤 룰이 관련 있는가" (ADR-017 D2, 턴 단위 룰 관련도)
 *
 * UserPromptSubmit 에서 프롬프트를 활성 룰의 `trigger`/`policy` 용어와 매칭해
 * `state/turn-rules-<session>.json` 에 기록한다. statusline 이 이 파일을 읽어 "관련 룰 N" 을 보여주고
 * `forgen status --turn` 이 각 룰의 원 교정(날짜·종류·사용자 발화)을 함께 보여준다.
 *
 * 정직성 원칙:
 *   - "관련" 이지 "적용" 이 아니다. 모델이 룰을 따랐는지는 여기서 알 수 없다(ADR-017 §5 — 인용 태그는 보류).
 *   - 프롬프트 원문은 저장하지 않는다. sha256 앞 16자만 남긴다(어느 프롬프트의 결과인지 대조용).
 *   - 프롬프트 주입에는 아무것도 보태지 않는다 — 토큰 비용 0.
 *
 * 매칭 (solution-matcher 와 같은 term 매칭 재사용):
 *   - 룰 용어: `extractTags`(solution-format) 를 trigger + policy 의 8단어 창마다 돌려 합친다. extractTags 는
 *     빈도순 8개 cap 이 있어 긴 policy 를 통째로 넣으면 핵심 명사가 잘린다 — 8단어 창이면 cap 이 안 걸린다.
 *   - 프롬프트 매칭: `classifyMatch`(term-matcher) 를 **전체 룰 용어 합집합에 대해 한 번** 호출한다 —
 *     프롬프트 NFC 정규화·한글 stem Set 계산이 룰 수와 무관하게 1회. 영문은 단어 경계, 한글은 조사 제거 후 비교.
 *   - 공통어 제외: term-matcher NEGATIVE_TERM_BLOCKLIST(코드/파일/테스트 …) + scoring-algorithms COMMON_TAGS
 *     (수정/추가/함수 …) + 룰 문장에 흔한 메타어(RULE_COMMON_TERMS: 사용자/작업/먼저/금지 …).
 *
 * 임계 (보수적 — 거짓 양성이 신뢰를 깎는다):
 *   용어마다 가중치: 식별자급 1.0, 일반 0.5. 합 ≥ 1.0 이면 관련.
 *   즉 **일반 용어 2개 이상, 또는 식별자급 용어 1개**.
 *   식별자급 = 영문/숫자 6자 이상(`statusline`, `codex-cli`) 또는 한글 3음절 이상(`한국어`, `에이전트`, `리서치`).
 *   한글은 음절당 정보량이 라틴 문자의 약 2배라 3음절을 영문 6자에 대응시켰다 — 2음절어(설계·검증·병렬)는
 *   단독으로는 잡지 않는다. ("한국어로 답해" 가 '사용자 응답 언어' 룰을 잡아야 한다는 ADR-017 §검증 기준.)
 *
 * 비용: 룰 100개 × 프롬프트 1개 5ms 이내(테스트로 고정). 프롬프트는 앞 32KB 만 본다.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from '../core/paths.js';
import { atomicWriteJSON, safeReadJSON } from '../hooks/shared/atomic-write.js';
import { sanitizeId } from '../hooks/shared/sanitize-id.js';
import type { Rule } from '../store/types.js';
import { COMMON_TAGS } from './scoring-algorithms.js';
import { extractTags } from './solution-format.js';
import { classifyMatch, filterMatchableTerms } from './term-matcher.js';

export interface RuleRelevance {
  rule_id: string;
  /** 매칭 용어 가중치 합(식별자급 1.0 · 일반 0.5). 임계 RELEVANCE_THRESHOLD 이상만 반환. */
  score: number;
  matchedTerms: string[];
}

export interface TurnRulesFile {
  at: string;
  session_id: string;
  /** sha256(prompt) 앞 16자 — 원문 저장 금지. */
  prompt_hash: string;
  rules: RuleRelevance[];
}

export const RELEVANCE_THRESHOLD = 1.0;
const SPECIFIC_WEIGHT = 1.0;
const GENERIC_WEIGHT = 0.5;
const SPECIFIC_LATIN_MIN = 6;
const SPECIFIC_HANGUL_MIN = 3;
/** 프롬프트 매칭 상한 — 붙여넣기 대용량 프롬프트가 훅 지연을 만들지 않게. */
const PROMPT_MAX_CHARS = 32_000;
export const PROMPT_HASH_LENGTH = 16;

/**
 * 룰 문장에 흔히 등장하지만 "이 턴과 관련" 의 근거가 못 되는 메타어.
 * NEGATIVE_TERM_BLOCKLIST(코드/파일/테스트/에러) · COMMON_TAGS(수정/추가/함수) 와 합쳐 제외한다.
 */
export const RULE_COMMON_TERMS = new Set<string>([
  // 한국어 — 룰 policy 의 상투어
  '사용자', '오너', '작업', '기능', '요청', '방식', '방법', '단계', '진행', '시작', '완료', '상황', '전체', '필요',
  '이전', '앞으로', '반드시', '명시', '지시', '먼저', '금지', '가능', '결과', '내용', '정리', '확인', '처리',
  '규칙', '정책', '기준', '순서', '상태', '경우', '대상', '포함', '제외', '실제', '실행', '유지', '우선',
  '새로운', '기존', '현재', '이후', '이렇게', '그렇게', '하지', '말것', '않는다', '한다', '해야', '해라', '하라',
  // 영어 — 프로젝트/도구 이름 등 어느 프롬프트에나 나오는 것
  'forgen', 'claude', 'user', 'users', 'rule', 'rules', 'work', 'task', 'tasks', 'session', 'sessions',
  'project', 'make', 'need', 'needs', 'always', 'never', 'must', 'please', 'help', 'want',
]);

/** 영문/숫자 6자 이상 또는 한글 3음절 이상 — 단독으로도 관련 근거가 되는 용어. */
export function isSpecificTerm(term: string): boolean {
  if (/[가-힣]/.test(term)) return term.length >= SPECIFIC_HANGUL_MIN;
  return term.length >= SPECIFIC_LATIN_MIN;
}

function isCommonTerm(term: string): boolean {
  const t = term.toLowerCase();
  return RULE_COMMON_TERMS.has(t) || COMMON_TAGS.has(t);
}

/**
 * extractTags 는 호출당 최대 8개(빈도순)만 돌려준다. 단어 8개짜리 창으로 잘라 호출하면 창마다 후보가 8개
 * 이하라 cap 이 절대 걸리지 않는다 — 실 룰 45개 중 43개가 문장 단위 호출에서는 용어를 잃었다(실측).
 */
const TERM_WINDOW_WORDS = 8;

/**
 * 룰 한 개의 매칭 용어. trigger + policy 를 8단어 창으로 extractTags 해 합친다(손실 없음).
 * 반환은 중복 제거·필터(길이/블록리스트/공통어) 완료 상태.
 */
export function ruleTerms(rule: Pick<Rule, 'trigger' | 'policy'>): string[] {
  const words = `${rule.trigger ?? ''} ${rule.policy ?? ''}`.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  for (let i = 0; i < words.length; i += TERM_WINDOW_WORDS) {
    for (const tag of extractTags(words.slice(i, i + TERM_WINDOW_WORDS).join(' '))) seen.add(tag);
  }
  return filterMatchableTerms([...seen]).filter((t) => !isCommonTerm(t));
}

function scoreTerms(terms: readonly string[]): number {
  let s = 0;
  for (const t of terms) s += isSpecificTerm(t) ? SPECIFIC_WEIGHT : GENERIC_WEIGHT;
  return Math.round(s * 100) / 100;
}

/**
 * 프롬프트와 관련된 룰. 순수 함수 — IO 없음. 임계 이상만, score 내림차순(동점은 rule_id 순).
 */
export function relevantRules(prompt: string, rules: readonly Rule[]): RuleRelevance[] {
  if (!prompt || rules.length === 0) return [];
  const text = prompt.length > PROMPT_MAX_CHARS ? prompt.slice(0, PROMPT_MAX_CHARS) : prompt;

  const termsByRule: Array<{ rule_id: string; terms: string[] }> = [];
  const union = new Set<string>();
  for (const rule of rules) {
    const terms = ruleTerms(rule);
    if (terms.length === 0) continue;
    termsByRule.push({ rule_id: rule.rule_id, terms });
    for (const t of terms) union.add(t);
  }
  if (union.size === 0) return [];

  // 프롬프트 정규화·한글 stem 은 이 한 번의 호출 안에서만 계산된다.
  const matched = new Set(classifyMatch(text, [], [...union]).matchedTags);
  if (matched.size === 0) return [];

  const out: RuleRelevance[] = [];
  for (const { rule_id, terms } of termsByRule) {
    const hits = terms.filter((t) => matched.has(t));
    if (hits.length === 0) continue;
    const score = scoreTerms(hits);
    if (score < RELEVANCE_THRESHOLD) continue;
    out.push({ rule_id, score, matchedTerms: hits });
  }
  return out.sort((a, b) => b.score - a.score || a.rule_id.localeCompare(b.rule_id));
}

// ── turn-rules 파일 IO (훅이 쓰고 statusline / status --turn 이 읽는다) ──

export function promptHash(prompt: string): string {
  return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, PROMPT_HASH_LENGTH);
}

export function turnRulesPath(sessionId: string): string {
  return path.join(STATE_DIR, `turn-rules-${sanitizeId(sessionId)}.json`);
}

/** 덮어쓰기(세션당 최신 턴 하나). 디렉터리 0700 · 파일 0600 — 다른 세션 캐시와 같은 정책. */
export function writeTurnRules(sessionId: string, prompt: string, rules: RuleRelevance[]): TurnRulesFile {
  const data: TurnRulesFile = {
    at: new Date().toISOString(),
    session_id: sessionId,
    prompt_hash: promptHash(prompt),
    rules,
  };
  atomicWriteJSON(turnRulesPath(sessionId), data, { mode: 0o600, dirMode: 0o700 });
  return data;
}

/** 부재·손상이면 null (fail-open). */
export function readTurnRules(sessionId: string): TurnRulesFile | null {
  const data = safeReadJSON<Partial<TurnRulesFile> | null>(turnRulesPath(sessionId), null);
  if (!data || typeof data !== 'object' || !Array.isArray(data.rules)) return null;
  const rules = data.rules.filter(
    (r): r is RuleRelevance => !!r && typeof r === 'object' && typeof r.rule_id === 'string' && typeof r.score === 'number',
  ).map((r) => ({ rule_id: r.rule_id, score: r.score, matchedTerms: Array.isArray(r.matchedTerms) ? r.matchedTerms.filter((t) => typeof t === 'string') : [] }));
  return {
    at: typeof data.at === 'string' ? data.at : '',
    session_id: typeof data.session_id === 'string' ? data.session_id : sessionId,
    prompt_hash: typeof data.prompt_hash === 'string' ? data.prompt_hash : '',
    rules,
  };
}

/**
 * `forgen status --turn` 의 세션 결정: 지정 세션의 파일이 있으면 그것, 없으면 가장 최근 turn-rules 파일.
 * 반환은 원래 session_id 가 아니라 파일명에서 복원한 sanitized id — 읽기에는 충분하다.
 */
export function resolveTurnRulesSession(preferred?: string): string | null {
  try {
    if (preferred && fs.existsSync(turnRulesPath(preferred))) return preferred;
    let best: { id: string; mtime: number } | null = null;
    for (const name of fs.readdirSync(STATE_DIR)) {
      const m = /^turn-rules-(.+)\.json$/.exec(name);
      if (!m) continue;
      const mtime = fs.statSync(path.join(STATE_DIR, name)).mtimeMs;
      if (!best || mtime > best.mtime) best = { id: m[1], mtime };
    }
    return best?.id ?? null;
  } catch {
    return null;
  }
}
