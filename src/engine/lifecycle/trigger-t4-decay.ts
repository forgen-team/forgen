/**
 * T4 — 시간 경과 retire (time_decay).
 *
 * 트리거 조건 (ADR-002):
 *   last_inject_at < now - 90d → retire 후보.
 *   inject 추적 인프라 완비 전에는 updated_at 을 proxy 로 사용 (signals 가 이미 폴백).
 *
 * retired 는 파일 삭제가 아니라 phase 변경 — N개월 후 별도 GC.
 */

import type { Rule } from '../../store/types.js';
import type { LifecycleEvent, RuleSignals } from './types.js';

export interface T4Input {
  rules: Rule[];
  signals: Map<string, RuleSignals>;
  decay_days?: number;
  ts?: number;
}

export function detect(input: T4Input): LifecycleEvent[] {
  const decayDays = input.decay_days ?? 90;
  const ts = input.ts ?? Date.now();
  const events: LifecycleEvent[] = [];

  for (const rule of input.rules) {
    if (rule.status !== 'active') continue;
    if (rule.lifecycle?.phase === 'retired') continue;
    const s = input.signals.get(rule.rule_id);
    if (!s) continue;
    if (s.last_inject_days_ago < decayDays) continue;
    events.push({
      kind: 't4_time_decay',
      rule_id: rule.rule_id,
      evidence: {
        source: 'rule-store',
        refs: [],
        metrics: { last_inject_days_ago: s.last_inject_days_ago, threshold: decayDays },
      },
      suggested_action: 'retire',
      ts,
    });
  }
  return events;
}
