/**
 * 교정 3분류 원장 (0.8.0 M2) — 복리의 주 지표. 기록만 하고 아무것도 자동으로 결정하지 않는다.
 *
 * 직접 교정이 들어올 때마다 `state/metrics/corrections.jsonl` 에 한 줄:
 *   recurrence        같은 뜻의 활성 룰이 이미 있고 이 세션에 들어가 있었다 → 룰이 있어도 안 먹힘
 *   delivery-failure  같은 뜻의 활성 룰이 있는데 이 세션에 들어가지 않았다 → 범위·예산 문제
 *   new               같은 뜻의 룰이 없다
 *   unknown-delivery  같은 뜻의 룰은 있지만 이 세션에 무엇이 들어갔는지 기록이 없다(세션 위치 파일 없음)
 *   pending           (0.9.0) 문장이 비슷한 룰은 있는데 같은 뜻인지 아직 판정 전
 *
 * "같은 뜻"(0.9.0): render_key 일치·정규화 문장 일치는 그 자리에서 확정한다. 그 밖에는 예전처럼 유사도 0.3 으로
 * 정하지 않는다(거짓 재발의 원인이었다, 0.8.0 Known limits). 어휘가 비슷한 룰을 후보로만 적고(pending, 전달 여부도 같이),
 * 백그라운드 러너가 감사관의 쌍 판정기(src/audit/judge.ts — 순서 바꿔 두 번, 캐시)로 판정해 해결 줄을 덧붙인다
 * (correction-ledger-judge.ts). 훅·MCP 경로에서는 모델을 부르지 않는다.
 * 판정 품질은 오너 표본 검수 전까지 "참고"다(계획 §6.3-4).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from './paths.js';
import { loadActiveRules } from '../store/rule-store.js';
import { normalizePolicy } from '../store/rule-normalize.js';
import { appliesForContext } from '../store/rule-scope.js';
import { readWorkContext } from './session-context.js';
import { bigrams, topK } from '../audit/lexical.js';
import type { Rule } from '../store/types.js';

export const LEDGER_PATH = path.join(STATE_DIR, 'metrics', 'corrections.jsonl');
export type CorrectionClass = 'recurrence' | 'delivery-failure' | 'new' | 'unknown-delivery' | 'pending';
/** 판정 후보로 적는 어휘 유사도 하한·개수 — 판정이 아니라 쌍 판정에 보낼 룰을 고르는 거름. */
export const CANDIDATE_MIN_SIM = 0.25;
export const MAX_CANDIDATES = 3;

export interface LedgerCandidate { rule_id: string; score: number; source: Rule['source']; delivered: boolean; inScope: boolean }

export interface LedgerEntry {
  at: string;
  session: string;
  evidence: string;
  class: CorrectionClass;
  /** via 'similarity' 는 0.8.x 기록(유사도 0.3), 'judge' 는 0.9.0 쌍 판정 */
  match?: { rule_id: string; via: 'render_key' | 'normalized' | 'similarity' | 'judge'; score?: number; source: Rule['source'] };
  /** delivery-failure 일 때: 현재 위치 범위 밖이라 안 들어갔는지(scope), 범위 안인데 빠졌는지(budget-or-other) */
  reason?: 'scope' | 'budget-or-other';
  project?: string | null;
  /** pending: 쌍 판정에 보낼 교정 문장과 후보 룰(전달 여부는 기록 시점 값) */
  text?: string;
  candidates?: LedgerCandidate[];
  /** pending: 이 세션에 무엇이 들어갔는지 기록이 있었나 */
  deliveryKnown?: boolean;
  /** 해결된 줄: 판정자·판본, 순서를 바꾸면 갈린 후보 */
  judge?: { model: string; version: string; splits?: string[] };
}

/** 러너가 덧붙이는 해결 줄 — 같은 evidence 의 pending 을 이 분류로 바꾼다. */
export interface LedgerResolution {
  at: string;
  resolves: string;
  session: string;
  class: Exclude<CorrectionClass, 'pending'>;
  match?: LedgerEntry['match'];
  reason?: LedgerEntry['reason'];
  judge: { model: string; version: string; splits?: string[] };
}

export function classifyCorrection(input: { sessionId: string; evidenceId: string; policy: string; renderKey: string; project: string | null; rules?: Rule[] }): LedgerEntry {
  // 같은 세션의 임시 룰(scope 'session')도 "이미 있는 룰"이다 — 같은 세션에서 같은 교정을 되풀이하면 재발.
  const pool = (input.rules ?? loadActiveRules()).filter((r) => (r.scope === 'me' || (r.scope === 'session' && r.session_id === input.sessionId))
    && !r.evidence_refs.includes(input.evidenceId));
  const norm = normalizePolicy(input.policy);
  // 같은 뜻의 룰은 여럿일 수 있다(같은 교정이 승급돼 생긴 룰 등). 모두 모은 뒤 이 세션에 들어간 것을 먼저 본다.
  const matches: NonNullable<LedgerEntry['match']>[] = [];
  const add = (r: Rule, via: NonNullable<LedgerEntry['match']>['via'], score?: number) => {
    if (!matches.some((m) => m.rule_id === r.rule_id)) matches.push({ rule_id: r.rule_id, via, ...(score !== undefined ? { score } : {}), source: r.source });
  };
  for (const r of pool) if (r.render_key === input.renderKey) add(r, 'render_key');
  for (const r of pool) if (normalizePolicy(r.policy) === norm) add(r, 'normalized');
  const base = { at: new Date().toISOString(), session: input.sessionId, evidence: input.evidenceId, project: input.project };
  const wc = readWorkContext(input.sessionId);
  const sessionRule = (id: string) => pool.some((r) => r.rule_id === id && r.scope === 'session');
  const isDelivered = (id: string) => !!wc?.rules?.includes(id) || sessionRule(id);
  const inScope = (r: Rule | undefined) => (r ? appliesForContext(r, input.project) : true);
  if (matches.length === 0) {
    // 확정 일치가 없으면 어휘가 비슷한 룰을 후보로만 적는다 — 같은 뜻인지는 러너의 쌍 판정이 정한다.
    const q = bigrams(input.policy);
    const near = topK(q, pool, MAX_CANDIDATES, (r) => bigrams(r.policy), (r) => r.rule_id).filter((x) => x.score >= CANDIDATE_MIN_SIM);
    if (near.length === 0) return { ...base, class: 'new' };
    return {
      ...base, class: 'pending', text: input.policy.slice(0, 400), deliveryKnown: !!wc?.rules,
      candidates: near.map(({ item: r, score }) => ({ rule_id: r.rule_id, score, source: r.source, delivered: isDelivered(r.rule_id), inScope: inScope(r) })),
    };
  }
  if (!wc?.rules) return { ...base, class: 'unknown-delivery', match: matches[0] };
  const delivered = matches.find((m) => isDelivered(m.rule_id));
  if (delivered) return { ...base, class: 'recurrence', match: delivered };
  const match = matches[0];
  const rule = pool.find((r) => r.rule_id === match?.rule_id);
  return { ...base, class: 'delivery-failure', match, reason: inScope(rule) ? 'budget-or-other' : 'scope' };
}

/** pending 하나를 쌍 판정 결과로 분류한다(순수 함수). same = 같은 뜻으로 확정된 후보 ID. */
export function resolvePendingEntry(e: LedgerEntry, same: string[], judge: LedgerResolution['judge']): LedgerResolution {
  const out = { at: new Date().toISOString(), resolves: e.evidence, session: e.session, judge };
  const hits = (e.candidates ?? []).filter((c) => same.includes(c.rule_id));
  if (hits.length === 0) return { ...out, class: 'new' };
  const matchOf = (c: LedgerCandidate) => ({ rule_id: c.rule_id, via: 'judge' as const, score: c.score, source: c.source });
  if (!e.deliveryKnown) return { ...out, class: 'unknown-delivery', match: matchOf(hits[0]) };
  const delivered = hits.find((c) => c.delivered);
  if (delivered) return { ...out, class: 'recurrence', match: matchOf(delivered) };
  return { ...out, class: 'delivery-failure', match: matchOf(hits[0]), reason: hits[0].inScope ? 'budget-or-other' : 'scope' };
}

export function recordCorrectionClass(entry: LedgerEntry | LedgerResolution): void {
  try {
    fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
    fs.appendFileSync(LEDGER_PATH, `${JSON.stringify(entry)}\n`);
  } catch { /* 기록 실패는 교정 기록을 막지 않는다 */ }
}

function readLines(): Array<LedgerEntry | LedgerResolution> {
  try {
    return fs.readFileSync(LEDGER_PATH, 'utf-8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as LedgerEntry | LedgerResolution; } catch { return null; } })
      .filter((e): e is LedgerEntry | LedgerResolution => !!e);
  } catch { return []; }
}

/** 원장(해결 줄을 접어 넣은 모습). 해결 줄이 있는 pending 은 그 분류로, 없으면 pending 그대로. */
export function readLedger(sinceMs = 0): LedgerEntry[] {
  const lines = readLines();
  const res = new Map<string, LedgerResolution>();
  for (const l of lines) if ('resolves' in l && l.resolves && !res.has(l.resolves)) res.set(l.resolves, l);
  const out: LedgerEntry[] = [];
  for (const l of lines) {
    if ('resolves' in l) continue;
    const e = l as LedgerEntry;
    if (!(Date.parse(e.at) >= sinceMs)) continue;
    const r = e.class === 'pending' ? res.get(e.evidence) : undefined;
    if (!r) { out.push(e); continue; }
    const { candidates: _c, text: _t, deliveryKnown: _d, ...rest } = e;
    out.push({ ...rest, class: r.class, ...(r.match ? { match: r.match } : {}), ...(r.reason ? { reason: r.reason } : {}), judge: r.judge });
  }
  return out;
}

/** 아직 판정되지 않은 pending(러너가 판정할 것). */
export function pendingEntries(): LedgerEntry[] {
  return readLedger().filter((e) => e.class === 'pending');
}

export function summarizeLedger(sinceMs = 0): Record<CorrectionClass, number> {
  const out: Record<CorrectionClass, number> = { recurrence: 0, 'delivery-failure': 0, new: 0, 'unknown-delivery': 0, pending: 0 };
  for (const e of readLedger(sinceMs)) out[e.class] = (out[e.class] ?? 0) + 1;
  return out;
}
