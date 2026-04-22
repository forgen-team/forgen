/**
 * T2 — 반복 Mech 위반.
 *
 * 트리거 조건 (ADR-002):
 *   violations_30d ≥ 3 AND violation_rate_30d > 0.3 → flag (재검토 대기)
 *
 * rolling 30d 는 collectSignals 가 계산. 여기는 임계 체크와 event 생성만.
 */

import type { Rule } from '../../store/types.js';
import type { LifecycleEvent, RuleSignals } from './types.js';

export interface T2Input {
  rules: Rule[];
  signals: Map<string, RuleSignals>;
  threshold_count?: number;
  threshold_rate?: number;
  ts?: number;
}

export function detect(input: T2Input): LifecycleEvent[] {
  const thresholdCount = input.threshold_count ?? 3;
  const thresholdRate = input.threshold_rate ?? 0.3;
  const ts = input.ts ?? Date.now();
  const events: LifecycleEvent[] = [];

  for (const rule of input.rules) {
    if (rule.status !== 'active') continue;
    if (rule.lifecycle?.phase === 'flagged') continue; // 이미 flagged — 중복 이벤트 방지
    const s = input.signals.get(rule.rule_id);
    if (!s) continue;
    if (s.violations_30d < thresholdCount) continue;
    if (s.violation_rate_30d <= thresholdRate) continue;
    events.push({
      kind: 't2_repeated_violation',
      rule_id: rule.rule_id,
      evidence: {
        source: 'violations-log',
        refs: [],
        metrics: {
          violations_30d: s.violations_30d,
          violation_rate_30d: Number(s.violation_rate_30d.toFixed(3)),
        },
      },
      suggested_action: 'flag',
      ts,
    });
  }
  return events;
}
