/**
 * T3 — 사용자 반복 우회 (user_bypass).
 *
 * 트리거 조건 (ADR-002):
 *   7d 내 bypass_count ≥ 5 → suppress (일시 비활성 + 7일 후 자동 재활성)
 *
 * bypass 기록은 post-tool-use 측 확장이 bypass.jsonl 에 append (별도 wiring).
 */

import type { Rule } from '../../store/types.js';
import type { LifecycleEvent, RuleSignals } from './types.js';

export interface T3Input {
  rules: Rule[];
  signals: Map<string, RuleSignals>;
  threshold_count?: number;
  ts?: number;
}

export function detect(input: T3Input): LifecycleEvent[] {
  const threshold = input.threshold_count ?? 5;
  const ts = input.ts ?? Date.now();
  const events: LifecycleEvent[] = [];

  for (const rule of input.rules) {
    if (rule.status !== 'active') continue;
    if (rule.lifecycle?.phase === 'flagged' || rule.lifecycle?.phase === 'suppressed') continue; // 이미 주의 환기됨
    const s = input.signals.get(rule.rule_id);
    if (!s) continue;
    if (s.bypass_7d < threshold) continue;
    // R6-P1: PM 지적 — "우회할수록 규칙이 약해진다" 는 Trust Restoration 미션과 역방향.
    // T3 는 이제 자동 suppress 대신 flag 만 (사용자 주의 환기). 실제 suppress 는 사용자가
    // 명시적으로 결정하도록 `forgen inspect rules --conflicts` + 수동 편집 경로 유지.
    events.push({
      kind: 't3_user_bypass',
      rule_id: rule.rule_id,
      evidence: {
        source: 'bypass-log',
        refs: [],
        metrics: { bypass_7d: s.bypass_7d },
      },
      suggested_action: 'flag',
      ts,
    });
  }
  return events;
}
