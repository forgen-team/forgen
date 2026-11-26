/**
 * 두 층 주입 (0.9.0, docs/plans/2026-11-25-v1.0-plan.md §8.1 ②, 오너 결정 Q11·Q12 2026-11-26).
 *
 * 1층(세션 시작에 항상): hard · strong · 최근 30일 안에 생기거나 다시 관측된 직접 교정 · 최근 90일 안에 재발(또는 2층 미발동)한 룰 ·
 *   자격 게이트를 못 지난 룰(발동 조건을 정할 수 없음). 그리고 2층 색인 한 줄.
 * 2층(상황이 맞을 때 훅이 한 번): 그 밖의 룰 중 자격 게이트를 지난 것. 프롬프트(UserPromptSubmit)·도구 입력(PreToolUse/PostToolUse)의
 *   낱말이 룰 낱말 집합과 K 개 이상 겹치면 그 세션에 한 번 넣는다(턴당 최대 2개). 모델 호출 없이 결정적.
 *
 * 자격 게이트는 `forgen audit tier2 --replay --apply` 가 대화 기록을 재생해 정하고 `state/tier2-index.json` 에 적는다(audit/tier2-replay.ts).
 * 색인 파일이 없으면 모든 룰이 1층이다(지금과 같음) — 실패는 언제나 1층 쪽이다.
 * 재자격: 2층 미발동·재발로 1층에 올라간 룰은 마지막 재발에서 90일 동안 재발이 없으면 자격 게이트 결과를 다시 따른다.
 *
 * 세션별 상태: 세션 시작 때 그 세션의 2층 후보(룰 ID·낱말·문장)를 `state/tier2-session-<세션>.json` 에 두고(턴마다 룰 파일을 읽지 않게),
 * 넣은 룰은 work-context 의 `tier2_injected`·`rules` 와 세션별 렌더 기록('tier2' 사건)에 남긴다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from './paths.js';
import type { AppliesWhen, Rule } from '../store/types.js';
import { atomicWriteJSON, safeReadJSON } from '../hooks/shared/atomic-write.js';
import { compactRuleText } from '../renderer/rule-renderer.js';

export const TIER2_INDEX_VERSION = 1;
/** Q12: 1층 "최근 직접 교정" 기준. */
export const RECENT_DAYS = 30;
/** 재자격: 마지막 재발(2층 미발동 포함)에서 이 기간 재발 0 이면 자격 게이트를 다시 본다. */
export const REQUALIFY_DAYS = 90;
/** 발동: 룰 낱말 집합과 겹치는 낱말 수 하한(§8.1 표의 "겹침 ≥ 3"). */
export const MATCH_K = 3;
/** 한 번의 훅 응답에 넣는 2층 룰 최대 수. */
export const MAX_PER_TURN = 2;
const DAY = 86_400_000;

export interface Tier2Entry {
  qualified: boolean;
  /** 게이트 결과 까닭: 'fired' | 'no-context' | 'missed' | 'too-frequent' | 'no-words' */
  reason: string;
  /** 발동 낱말 집합(정책·trigger 낱말 + 근거 상황에서 배운 드문 낱말, 흔한 낱말 제외) */
  words: string[];
  /** 색인 줄에 보일 주제 낱말(앞의 몇 개) */
  topics: string[];
  /** 재생한 근거 상황 수 / 그중 발동 수(leave-one-out) */
  contexts: number;
  fired: number;
  /** 대화 기록 사건 중 이 룰이 발동한 비율(너무 자주 뜨는 룰을 거른다) */
  freq?: number;
  /** 근거 교정의 가장 늦은 시각(Q12 "다시 관측된") */
  lastObservedAt?: string;
}

export interface Tier2Recur { lastAt: string; kind: 'recurred' | 'tier2-missed'; count: number; session?: string }

export interface Tier2Index {
  version: number;
  generatedAt: string;
  params: { k: number; turns: number; minFireRate: number; maxFreq: number };
  rules: Record<string, Tier2Entry>;
  /** 재발 이력(재생 결과에서). 2층 미발동이면 그 룰은 다음 세션부터 1층(자동 복귀) */
  recur: Record<string, Tier2Recur>;
}

export const tier2IndexPath = (stateDir = STATE_DIR) => path.join(stateDir, 'tier2-index.json');

export function loadTier2Index(stateDir = STATE_DIR): Tier2Index | null {
  const x = safeReadJSON<Tier2Index | null>(tier2IndexPath(stateDir), null);
  return x && x.version === TIER2_INDEX_VERSION && x.rules && typeof x.rules === 'object' ? { ...x, recur: x.recur ?? {} } : null;
}

export function saveTier2Index(idx: Tier2Index, stateDir = STATE_DIR): void {
  fs.mkdirSync(stateDir, { recursive: true });
  atomicWriteJSON(tier2IndexPath(stateDir), idx, { mode: 0o600 });
}

const age = (iso: string | undefined, now: number) => (iso ? now - Date.parse(iso) : Number.POSITIVE_INFINITY);

export type TierReason = 'hard' | 'strong' | 'safety' | 'session' | 'recent' | 'recurred' | 'tier2-missed' | 'not-qualified' | 'no-index' | 'tier2' | 'approved';

/** 한 룰의 층과 그 까닭. */
/**
 * 안전·보안 룰 — 두 층 주입 어디서도 2층에 가지 않는다(게이트 통과·승인 조건·재자격 모두, fresh-context 비평 2026-11-26).
 * 2층은 "필요한 순간에 안 실릴" 위험을 받아들이는 대신 토큰을 줄이는 장치다. 안 실렸을 때 되돌릴 수 없는 피해(삭제·비밀 노출·강제 푸시)가
 * 나는 룰은 그 위험을 받을 수 없으므로 결정적으로 1층에 둔다. 근거(하나라도 맞으면):
 *   ① enforce_via·enforce_mode 가 있다 — 이미 훅으로 강제하는 룰이다(사다리 3·4칸)
 *   ② strength hard — 렌더에서 Must Not 절에 들어간다
 *   ③ category safety(·security 류 이름)
 *   ④ 정책 문장에 파괴·비밀 패턴(아래 SAFETY_RE, 한국어 포함)
 * 넓게 잡는다 — 잘못 잡으면 1층에 남을 뿐(토큰 절감이 덜 될 뿐)이고, 놓치면 안전 룰이 안 실린다.
 */
export const SAFETY_RE = new RegExp([
  'rm\\s+-[a-z]*[rf]', 'force[\\s-]*push', 'push\\s+(--force|-f\\b)', '--force', 'reset\\s+--hard', 'drop\\s+(table|database|schema)', 'truncate\\s+table', 'delete\\s+from',
  'secret', 'credential', 'password', 'passwd', 'api[\\s_-]?key', 'private[\\s_-]?key', 'token', '\\.env\\b', 'ssh[\\s_-]?key', 'byok',
  'git\\s+clean', 'git\\s+checkout\\s+--\\s', 'git\\s+branch\\s+-D', 'kubectl\\s+delete', 'docker\\s+(rm|rmi)\\s+-f', 'docker\\s+(system|volume)\\s+prune', 'truncate\\b', 'chmod\\s+-R\\s+777', 'mkfs', 'dd\\s+if=', 'shred\\b', 'terraform\\s+destroy', 'dropdb\\b',
  'destructive', 'irreversible', 'production\\s+(data|db|database)', 'sudo\\b', 'chmod\\s+777',
  '비밀', '시크릿', '자격\\s*증명', '인증\\s*정보', '암호', '토큰', '키\\s*(노출|유출|커밋)', '강제\\s*푸시', '강제\\s*push', '위험\\s*명령', '파괴', '되돌릴\\s*수\\s*없', '복구\\s*불가',
  '(데이터|파일|폴더|디렉터리|디렉토리|db|테이블)\\s*(를|을)?\\s*(삭제|지우|날리)', '프로덕션\\s*(데이터|db|배포)', '실\\s*데이터',
].join('|'), 'i');
export function isSafetyRule(rule: Pick<Rule, 'strength' | 'category' | 'policy'> & Partial<Pick<Rule, 'enforce_via' | 'enforce_mode' | 'trigger'>>): boolean {
  if (rule.enforce_via?.length || rule.enforce_mode) return true;
  if (rule.strength === 'hard') return true;
  if (/^(safety|security)/i.test(String(rule.category ?? ''))) return true;
  return SAFETY_RE.test(`${rule.policy ?? ''} ${rule.trigger ?? ''}`);
}

/** 사람이 승인한 발동 조건(forgen fix tier2-condition) — 자격 게이트를 대신한다. 조건이 비어 있으면 승인이 아니다. */
export function approvedCondition(rule: Rule): AppliesWhen | null {
  const a = rule.applies_when;
  if (!a?.approved) return null;
  const n = (a.tools?.length ?? 0) + (a.commands?.length ?? 0) + (a.paths?.length ?? 0) + (a.words?.length ?? 0);
  return n ? a : null;
}

export function tierOf(rule: Rule, idxIn: Tier2Index | null, now = Date.now()): { tier: 1 | 2; reason: TierReason } {
  // 색인이 없어도 승인된 조건은 쓴다(재생을 안 돌렸어도 오너가 직접 정한 조건). 재발 이력은 색인이 있을 때만 있다.
  if (!idxIn && !approvedCondition(rule)) return { tier: 1, reason: 'no-index' };
  const idx: Tier2Index = idxIn ?? { version: TIER2_INDEX_VERSION, generatedAt: '', params: { k: MATCH_K, turns: 3, minFireRate: 0.8, maxFreq: 0.05 }, rules: {}, recur: {} };
  if (rule.strength === 'hard') return { tier: 1, reason: 'hard' };
  if (rule.strength === 'strong') return { tier: 1, reason: 'strong' };
  if (isSafetyRule(rule)) return { tier: 1, reason: 'safety' };
  if (rule.scope === 'session') return { tier: 1, reason: 'session' };
  const rec = idx.recur[rule.rule_id];
  if (rec && age(rec.lastAt, now) < REQUALIFY_DAYS * DAY) return { tier: 1, reason: rec.kind === 'tier2-missed' ? 'tier2-missed' : 'recurred' };
  const e = idx.rules[rule.rule_id];
  if (rule.source === 'explicit_correction') {
    const last = [rule.created_at, e?.lastObservedAt].filter(Boolean).sort().pop();
    if (age(last, now) < RECENT_DAYS * DAY) return { tier: 1, reason: 'recent' };
  }
  if (approvedCondition(rule)) return { tier: 2, reason: 'approved' };
  if (!e?.qualified || !e.words.length) return { tier: 1, reason: 'not-qualified' };
  return { tier: 2, reason: 'tier2' };
}

/** 색인 줄에 보일 주제 낱말: 게이트 결과의 주제, 승인 조건이면 그 낱말·명령 앞부분. */
function topicsOf(r: Rule, idx: Tier2Index | null): string[] {
  const a = approvedCondition(r);
  if (a) return [...(a.words ?? []), ...(a.commands ?? []).map((c) => c.split(/\s+/)[0]), ...(a.tools ?? [])].filter(Boolean).slice(0, 3);
  return idx?.rules[r.rule_id]?.topics ?? [];
}

/** 세션 시작 렌더에 줄 2층 집합(룰 ID → 색인 낱말). 색인이 없으면 빈 맵(전부 1층). */
export function tier2Assignment(rules: Rule[], idx: Tier2Index | null = loadTier2Index(), now = Date.now()): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rules) {
    if (r.status !== 'active' || r.host_copy) continue;
    if (tierOf(r, idx, now).tier === 2) out.set(r.rule_id, topicsOf(r, idx));
  }
  return out;
}

// ── 낱말 ──

const STOP = new Set(('the and for with that this from into not you are when then only also must should use using used can will all any '
  + 'its it\'s was were has have had been but out our your their there here what which who how why than more most such each other '
  + 'about after before over under just like make made does did don doesn didn yes no new one two get got let via per etc '
  + '그리고 그러나 하지만 그래서 그런데 있다 없다 한다 하는 하고 해야 해서 하면 하지 말고 것을 것은 것이 것도 때는 때도 경우 이런 저런 그런 같은 다른 위해 대한 '
  + '먼저 다시 항상 반드시 지금 이제 그냥 진짜 정말 너무 많이 조금 우리 내가 니가 네가 제가 저는 나는 이거 그거 저거 여기 거기 뭐가 어떻게 왜냐 근데').split(/\s+/));
const JOSA: string[] = ['으로써', '으로서', '에서는', '에게서', '이라고', '라고는', '까지는', '부터는', '으로', '에서', '에게', '까지', '부터', '처럼', '보다', '하고', '이나', '이랑', '라고', '이라', '에는', '에도', '은', '는', '이', '가', '을', '를', '에', '의', '도', '로', '와', '과', '만', '랑'];

const JOSA_SET = new Set(JOSA);

/**
 * 결정적 낱말 집합: 영문·숫자 낱말(3자 이상, 경로·명령 조각 포함)과 한글 낱말(조사를 떼고 앞 2자).
 * 한글 앞 2자는 거칠지만(활용형을 같이 잡는다) 흔한 조각은 색인을 만들 때 대화 기록 빈도로 걸러진다.
 */
export function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z0-9_-]{2,}|[가-힣]{2,}/g)) {
    let w = m[0];
    if (w.charCodeAt(0) >= 0xac00) {
      if (JOSA_SET.has(w)) continue;
      for (const j of JOSA) if (w.length - j.length >= 2 && w.endsWith(j)) { w = w.slice(0, -j.length); break; }
      if (STOP.has(w)) continue;
      w = w.slice(0, 2);
    } else {
      w = w.replace(/[-_]+$/, '');
      if (w.length < 3) continue;
      // 명령·경로 조각(storybook-static, rule_renderer)은 이어진 낱말과 그 조각을 같이 쓴다
      if (/[-_]/.test(w)) for (const part of w.split(/[-_]+/)) if (part.length >= 3 && !STOP.has(part)) out.add(part);
    }
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}

/** 사건(프롬프트 한 개, 도구 호출 한 개)의 낱말과 룰 낱말 집합이 겹치는 수. */
export function overlap(eventWords: Set<string>, ruleWords: ReadonlySet<string> | readonly string[]): number {
  let n = 0;
  const rs = ruleWords instanceof Set ? ruleWords : new Set(ruleWords as readonly string[]);
  for (const w of eventWords) if (rs.has(w)) n++;
  return n;
}

/** 도구 입력에서 발동 판정에 쓰는 글: 도구 이름 + 명령 + 경로 + 찾는 패턴 + 설명. */
export function toolSignalText(toolName: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  const parts = [toolName];
  for (const k of ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'description', 'skill', 'url', 'query']) {
    const v = i[k];
    if (typeof v === 'string' && v) parts.push(v.slice(0, 600));
  }
  return parts.join(' ');
}

/** 승인 조건 판정용 도구 신호: 도구 이름·명령·만진 경로. */
export function toolDetail(toolName: string, input: Record<string, unknown> | undefined): SignalDetail {
  const i = input ?? {};
  const paths = ['file_path', 'notebook_path', 'path'].map((k) => i[k]).filter((v): v is string => typeof v === 'string' && !!v);
  return { tool: toolName, ...(typeof i.command === 'string' ? { command: i.command.slice(0, 2000) } : {}), paths };
}

// ── 세션별 2층 후보 ──

/** cond: 승인된 발동 조건(있으면 낱말 겹침 대신 이 조건으로 판정) */
export interface Tier2SessionRule { id: string; text: string; words: string[]; cond?: AppliesWhen }

function sessionRule(r: Rule, projectKey: string | null, idx: Tier2Index | null): Tier2SessionRule | null {
  const a = approvedCondition(r);
  if (a) { const { approved: _a, ...cond } = a; return { id: r.rule_id, text: compactRuleText(r, projectKey), words: [], cond }; }
  const w = idx?.rules[r.rule_id]?.words ?? [];
  return w.length ? { id: r.rule_id, text: compactRuleText(r, projectKey), words: w } : null;
}
export interface Tier2SessionFile { version: 1; session_id: string; at: string; rules: Tier2SessionRule[] }
const SID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function tier2SessionPath(sessionId: string, stateDir = STATE_DIR): string | null {
  return SID_RE.test(sessionId) ? path.join(stateDir, `tier2-session-${sessionId}.json`) : null;
}

/** 세션 시작(또는 압축 뒤 재시작) 때 이 세션의 2층 후보를 적는다. 후보가 없으면 파일을 지운다. */
export function writeTier2Session(sessionId: string | undefined, rules: Rule[], projectKey: string | null, idx: Tier2Index | null = loadTier2Index()): void {
  if (!sessionId) return;
  const p = tier2SessionPath(sessionId);
  if (!p) return;
  try {
    const out = rules.map((r) => sessionRule(r, projectKey, idx)).filter((x): x is Tier2SessionRule => !!x);
    if (!out.length) { fs.rmSync(p, { force: true }); return; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    atomicWriteJSON(p, { version: 1, session_id: sessionId, at: new Date().toISOString(), rules: out } satisfies Tier2SessionFile, { mode: 0o600 });
  } catch { /* 기록 실패 = 이 세션은 2층 주입 없음(1층 색인 줄은 그대로) */ }
}

/** 위치 전환으로 들어온 프로젝트의 2층 룰을 이 세션 후보에 더한다(본문으로는 넣지 않는다 — §8.1 ② 표 첫 줄). */
export function addTier2SessionRules(sessionId: string | undefined, rules: Rule[], projectKey: string | null, idx: Tier2Index | null = loadTier2Index()): void {
  if (!sessionId || !rules.length) return;
  const p = tier2SessionPath(sessionId);
  if (!p) return;
  try {
    const prev = readTier2Session(sessionId);
    const have = new Set((prev?.rules ?? []).map((r) => r.id));
    const add = rules.filter((r) => !have.has(r.rule_id)).map((r) => sessionRule(r, projectKey, idx)).filter((x): x is Tier2SessionRule => !!x);
    if (!add.length) return;
    atomicWriteJSON(p, { version: 1, session_id: sessionId, at: prev?.at ?? new Date().toISOString(), rules: [...(prev?.rules ?? []), ...add] } satisfies Tier2SessionFile, { mode: 0o600 });
  } catch { /* fail-open */ }
}

export function readTier2Session(sessionId: string | undefined): Tier2SessionFile | null {
  if (!sessionId) return null;
  const p = tier2SessionPath(sessionId);
  if (!p) return null;
  const f = safeReadJSON<Tier2SessionFile | null>(p, null);
  return f && f.version === 1 && Array.isArray(f.rules) ? f : null;
}

export interface SignalDetail { tool?: string; command?: string; paths?: string[]; cwd?: string; project?: string | null }

/** 경로 글롭(* = 한 칸, ** = 여러 칸) 또는 조각. */
function pathHit(pattern: string, p: string): boolean {
  const pat = pattern.trim().replace(/^~\//, '');
  if (!pat) return false;
  if (!/[*?]/.test(pat)) return p.includes(pat.replace(/^\.\//, ''));
  const body = pat.replace(/^\.\//, '').split('**').map((part) => part.split('*').map((x) => x.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^/]*')).join('.*');
  const re = new RegExp(`(^|/)${body}$`);
  return re.test(p);
}

/**
 * 승인된 조건 판정(결정적): folders 가 있으면 그 폴더(프로젝트 키·경로 조각)에서만. 도구 신호는 도구 이름(있으면)이 맞고 명령 글·경로가
 * 하나라도 맞으면(명령·경로 조건이 없으면 도구 이름만으로). 프롬프트·도구 글의 낱말은 조건 낱말 2개 이상(하나뿐이면 1개)이 나오면.
 * 점수 = 맞은 조건 수. 0 이면 발동 안 함.
 */
export function conditionScore(c: AppliesWhen, signal: string, where: 'prompt' | 'tool', d: SignalDetail = {}): number {
  const lower = (xs?: string[]) => (xs ?? []).map((x) => x.toLowerCase().trim()).filter(Boolean);
  const folders = lower(c.folders);
  if (folders.length) {
    const cwd = d.cwd ? d.cwd.toLowerCase() : undefined;
    const proj = (d.project ?? '').toLowerCase();
    if (!folders.some((f) => f === proj || cwd?.includes(f))) return 0;
  }
  let score = 0;
  if (where === 'tool') {
    const tools = lower(c.tools);
    const toolOk = !tools.length || tools.includes((d.tool ?? '').toLowerCase());
    const cmd = (d.command ?? '').toLowerCase();
    const cmdHits = lower(c.commands).filter((x) => cmd.includes(x)).length;
    const pHits = (c.paths ?? []).filter((x) => (d.paths ?? []).some((p) => pathHit(x, p))).length;
    if (toolOk && (cmdHits || pHits)) score += cmdHits + pHits + (tools.length ? 1 : 0);
    else if (toolOk && tools.length && !c.commands?.length && !c.paths?.length) score += 1;
  }
  const cw = new Set(lower(c.words).flatMap((w) => [...words(w)]));
  if (cw.size) {
    const n = overlap(words(signal), cw);
    if (n >= Math.min(2, cw.size)) score += n;
  }
  return score;
}

/** 이 신호(프롬프트 또는 도구 입력)에 발동하는 2층 룰 — 점수(겹침·맞은 조건) 많은 순, 같으면 ID 순. */
export function matchTier2(rules: Tier2SessionRule[], signal: string, k = MATCH_K, where: 'prompt' | 'tool' = 'prompt', detail: SignalDetail = {}): Array<{ rule: Tier2SessionRule; score: number }> {
  const ws = words(signal);
  const hits: Array<{ rule: Tier2SessionRule; score: number }> = [];
  for (const r of rules) {
    if (r.cond) { const s = conditionScore(r.cond, signal, where, detail); if (s > 0) hits.push({ rule: r, score: s }); continue; }
    if (ws.size < k) continue;
    const s = overlap(ws, r.words);
    if (s >= k) hits.push({ rule: r, score: s });
  }
  return hits.sort((a, b) => b.score - a.score || (a.rule.id < b.rule.id ? -1 : 1));
}

/**
 * 훅 진입점: 이 세션의 2층 후보 중 신호에 발동하고 아직 안 넣은 룰을 최대 2개 넣는다.
 * 넣은 룰은 work-context(tier2_injected·rules)와 세션별 렌더 기록('tier2')에 남긴다. 넣을 것이 없으면 null.
 */
export async function tier2Context(sessionId: string | undefined, signal: string, where: 'prompt' | 'tool', detail: SignalDetail = {}): Promise<string | null> {
  if (!sessionId || !signal) return null;
  const f = readTier2Session(sessionId);
  if (!f?.rules.length) return null;
  const { readWorkContext, markTier2Injected } = await import('./session-context.js');
  const wc0 = readWorkContext(sessionId);
  const done = new Set(wc0?.tier2_injected ?? []);
  const pending = f.rules.filter((r) => !done.has(r.id));
  if (!pending.length) return null;
  const hits = matchTier2(pending, signal, MATCH_K, where, { cwd: wc0?.cwd, project: wc0?.project ?? null, ...detail }).slice(0, MAX_PER_TURN);
  if (!hits.length) return null;
  const fresh = markTier2Injected(sessionId, hits.map((h) => h.rule.id));
  if (!fresh.length) return null;
  const chosen = hits.filter((h) => fresh.includes(h.rule.id));
  const wc = readWorkContext(sessionId);
  const { appendSessionRender } = await import('./session-renders.js');
  appendSessionRender({ session: sessionId, event: 'tier2', cwd: wc?.cwd ?? '', project: wc?.project ?? null, ruleIds: chosen.map((h) => h.rule.id), via: where });
  const strong = chosen.some((h) => h.rule.text.startsWith('! '));
  return `<forgen-rules tier="2">\nThis user's rules for what you are doing now${strong ? ' (! = strong preference)' : ''}:\n${chosen.map((h) => `- ${h.rule.text}`).join('\n')}\n</forgen-rules>`;
}
