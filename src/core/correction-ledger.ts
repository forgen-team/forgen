/**
 * 교정 3분류 원장 (0.8.0 M2) — 복리의 주 지표. 기록만 하고 아무것도 자동으로 결정하지 않는다.
 *
 * 직접 교정이 들어올 때마다 `state/metrics/corrections.jsonl` 에 한 줄:
 *   recurrence        같은 뜻의 활성 룰이 이미 있고 이 세션에 들어가 있었다 → 룰이 있어도 안 먹힘
 *   delivery-failure  같은 뜻의 활성 룰이 있는데 이 세션에 들어가지 않았다 → 범위·예산 문제
 *   new               같은 뜻의 룰이 없다
 *   unknown-delivery  같은 뜻의 룰은 있지만 이 세션에 무엇이 들어갔는지 기록이 없다(세션 위치 파일 없음)
 * "같은 뜻"은 기존 판정(render_key 일치 → 정규화 문장 일치 → 군집 유사도)을 쓰고 근거와 점수를 남긴다.
 * 판정 품질은 오너 표본 검수 전까지 "참고"다(계획 §6.3-4).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from './paths.js';
import { loadActiveRules } from '../store/rule-store.js';
import { normalizePolicy } from '../store/rule-normalize.js';
import { findMostSimilarRule } from '../engine/correction-clustering.js';
import { appliesForContext } from '../store/rule-scope.js';
import { readWorkContext } from './session-context.js';
import type { Rule } from '../store/types.js';

export const LEDGER_PATH = path.join(STATE_DIR, 'metrics', 'corrections.jsonl');
export type CorrectionClass = 'recurrence' | 'delivery-failure' | 'new' | 'unknown-delivery';

export interface LedgerEntry {
  at: string;
  session: string;
  evidence: string;
  class: CorrectionClass;
  match?: { rule_id: string; via: 'render_key' | 'normalized' | 'similarity'; score?: number; source: Rule['source'] };
  /** delivery-failure 일 때: 현재 위치 범위 밖이라 안 들어갔는지(scope), 범위 안인데 빠졌는지(budget-or-other) */
  reason?: 'scope' | 'budget-or-other';
  project?: string | null;
}

export function classifyCorrection(input: { sessionId: string; evidenceId: string; policy: string; renderKey: string; project: string | null; rules?: Rule[] }): LedgerEntry {
  const pool = (input.rules ?? loadActiveRules()).filter((r) => r.scope === 'me' && !r.evidence_refs.includes(input.evidenceId));
  const norm = normalizePolicy(input.policy);
  // 같은 뜻의 룰은 여럿일 수 있다(같은 교정이 승급돼 생긴 룰 등). 모두 모은 뒤 이 세션에 들어간 것을 먼저 본다.
  const matches: NonNullable<LedgerEntry['match']>[] = [];
  const add = (r: Rule, via: NonNullable<LedgerEntry['match']>['via'], score?: number) => {
    if (!matches.some((m) => m.rule_id === r.rule_id)) matches.push({ rule_id: r.rule_id, via, ...(score !== undefined ? { score } : {}), source: r.source });
  };
  for (const r of pool) if (r.render_key === input.renderKey) add(r, 'render_key');
  for (const r of pool) if (normalizePolicy(r.policy) === norm) add(r, 'normalized');
  const sim = findMostSimilarRule(input.policy, pool);
  if (sim) add(sim.rule, 'similarity', Number(sim.similarity.toFixed(3)));
  const base = { at: new Date().toISOString(), session: input.sessionId, evidence: input.evidenceId, project: input.project };
  if (matches.length === 0) return { ...base, class: 'new' };
  const wc = readWorkContext(input.sessionId);
  if (!wc?.rules) return { ...base, class: 'unknown-delivery', match: matches[0] };
  const delivered = matches.find((m) => wc.rules?.includes(m.rule_id));
  if (delivered) return { ...base, class: 'recurrence', match: delivered };
  const match = matches[0];
  const rule = pool.find((r) => r.rule_id === match?.rule_id);
  const inScope = rule ? appliesForContext(rule, input.project) : true;
  return { ...base, class: 'delivery-failure', match, reason: inScope ? 'budget-or-other' : 'scope' };
}

export function recordCorrectionClass(entry: LedgerEntry): void {
  try {
    fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
    fs.appendFileSync(LEDGER_PATH, `${JSON.stringify(entry)}\n`);
  } catch { /* 기록 실패는 교정 기록을 막지 않는다 */ }
}

export function readLedger(sinceMs = 0): LedgerEntry[] {
  try {
    return fs.readFileSync(LEDGER_PATH, 'utf-8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as LedgerEntry; } catch { return null; } })
      .filter((e): e is LedgerEntry => !!e && Date.parse(e.at) >= sinceMs);
  } catch { return []; }
}

export function summarizeLedger(sinceMs = 0): Record<CorrectionClass, number> {
  const out: Record<CorrectionClass, number> = { recurrence: 0, 'delivery-failure': 0, new: 0, 'unknown-delivery': 0 };
  for (const e of readLedger(sinceMs)) out[e.class] = (out[e.class] ?? 0) + 1;
  return out;
}
