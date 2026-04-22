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
    if (rule.lifecycle?.phase === 'suppressed') continue; // 이미 suppressed
    const s = input.signals.get(rule.rule_id);
    if (!s) continue;
    if (s.bypass_7d < threshold) continue;
    events.push({
      kind: 't3_user_bypass',
      rule_id: rule.rule_id,
      evidence: {
        source: 'bypass-log',
        refs: [],
        metrics: { bypass_7d: s.bypass_7d },
      },
      suggested_action: 'suppress',
      ts,
    });
  }
  return events;
}
