/**
 * T3 — 사용자 반복 우회 (user_bypass).
 *
 * 트리거 조건 (ADR-002, R6-P1 로 suppress→flag 약화):
 *   7d 내 bypass_7d ≥ 5 → flag (사용자 주의 환기)
 *
 * 입력 (ADR-017 D1, 2026-10-06): bypass_7d 는 violations.jsonl 의 kind:'bypass_confirmed'
 * (FORGEN_USER_CONFIRMED=1 명시 우회) 만 센다. 과거 bypass.jsonl 자연어 휴리스틱(전량 오탐)은 폐기.
 * 의미: "사용자가 같은 룰을 7일에 5번 명시적으로 우회했다 → 룰이 틀렸을 가능성, 검토 요청".
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
        source: 'violations:bypass_confirmed',
        refs: [],
        metrics: { bypass_7d: s.bypass_7d },
      },
      suggested_action: 'flag',
      ts,
    });
  }
  return events;
}
