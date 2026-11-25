/**
 * 교정 원장의 같은 뜻 판정 (0.9.0, docs/plans/2026-11-25-v1.0-plan.md §3.3·§9 0.9.0).
 *
 * 훅·MCP 는 확정 일치가 없는 교정을 pending(후보 룰 + 전달 여부)으로만 적는다. 이 함수가 감사관의 쌍 판정기
 * (Sonnet 1회 비대칭, 캐시)로 "이 룰이 이 교정이 고치려는 행동을 이미 지시하고 있었나"를 물어 해결 줄을 덧붙인다.
 * 부르는 곳: 백그라운드 러너(auto-compound-runner, 세션 학습 동의 켜짐) · `forgen audit recurrence`(동의와 무관 — 사용자가 직접 돌림).
 *   예 → 같은 뜻 / 모름 → 같은 뜻으로 세지 않음(보수적) / 판정 실패 → pending 그대로(다음 실행에 다시)
 */
import { Judge, PAIR_MODEL, PAIR_PROMPT_VERSION } from '../audit/judge.js';
import { loadAllRules } from '../store/rule-store.js';
import { pendingEntries, recordCorrectionClass, resolvePendingEntry } from './correction-ledger.js';

export const LEDGER_RESOLVE_COMMAND = 'forgen audit recurrence';

export async function resolvePendingCorrections(opts: { judge?: Judge; max?: number } = {}): Promise<{ resolved: number; left: number; stopped?: string }> {
  const pending = pendingEntries().slice(0, opts.max ?? 50);
  if (pending.length === 0) return { resolved: 0, left: 0 };
  const policyOf = new Map(loadAllRules().map((r) => [r.rule_id, r.policy]));
  const pairs: Array<{ id: string; gist: string; memory: string }> = [];
  for (const e of pending) {
    for (const c of e.candidates ?? []) {
      const memory = policyOf.get(c.rule_id);
      if (e.text && memory) pairs.push({ id: `${e.evidence}|${c.rule_id}`, gist: e.text, memory });
    }
  }
  const judge = opts.judge ?? new Judge({ model: true, concurrency: 2 });
  const verdicts = await judge.pairs(pairs);
  let resolved = 0;
  for (const e of pending) {
    const ids = (e.candidates ?? []).filter((c) => policyOf.has(c.rule_id)).map((c) => c.rule_id);
    const vs = ids.map((id) => verdicts.get(`${e.evidence}|${id}`) ?? null);
    if (vs.some((v) => v === null)) continue; // 못 물은 쌍이 있으면 다음 실행에 다시
    const same = ids.filter((_, i) => vs[i] === 'yes');
    const unknown = ids.filter((_, i) => vs[i] === 'unknown');
    recordCorrectionClass(resolvePendingEntry(e, same, { model: PAIR_MODEL, version: PAIR_PROMPT_VERSION, ...(unknown.length ? { unknown } : {}) }));
    resolved++;
  }
  return { resolved, left: pendingEntries().length, ...(judge.stats.stopped ? { stopped: judge.stats.stopped } : {}) };
}
