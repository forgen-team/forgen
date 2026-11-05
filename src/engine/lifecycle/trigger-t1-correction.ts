/**
 * T1 — 사용자 명시 교정 (explicit_correction).
 *
 * 입력: Evidence(type='explicit_correction') + rules[].
 * 로직:
 *   1. candidate_rule_refs 또는 raw_payload.target_rule_id 가 rule 을 지목 → rule 매칭. 그 외 전이 없음.
 *   2. correction kind 에 따라 suggested_action 결정:
 *      - 'avoid-this' (이 rule 을 따르지 말아라) → retire
 *      - 'fix-now'   (이 rule 을 수정해야 한다) → flag (사용자 후속 편집 대기)
 *      - 'prefer-from-now' (새 선호로 대체) → supersede
 *
 * 출력: LifecycleEvent[]. 순수 — IO 없음.
 */

import type { Evidence, Rule } from '../../store/types.js';
import type { LifecycleEvent } from './types.js';

export interface T1Input {
  evidence: Evidence;
  /** 교정의 행동 종류 — 있으면 더 정확한 action 결정. */
  correction_kind?: 'avoid-this' | 'fix-now' | 'prefer-from-now';
  rules: Rule[];
  ts?: number;
}

/**
 * 교정이 이 룰을 **rule_id 로 명시 지목**했는가.
 *
 * 추측 매칭은 하지 않는다. 축 + 토큰 겹침은 실데이터 전이 9건 중 8건이 오탐이었고(드리블 교정의
 * "사용자" 토큰으로 한국어 답변 룰이 retire), target 슬러그 일치는 같은 교정을 반복하면 그 교정으로
 * 만든 룰을 스스로 폐기한다. 지목은 correction-record 의 rule_id 인자로만 한다.
 */
function matchesRule(evidence: Evidence, rule: Rule): boolean {
  if (evidence.candidate_rule_refs.includes(rule.rule_id)) return true;
  return (evidence.raw_payload as Record<string, unknown> | undefined)?.target_rule_id === rule.rule_id;
}

export function detect(input: T1Input): LifecycleEvent[] {
  const { evidence, rules } = input;
  if (evidence.type !== 'explicit_correction') return [];
  const ts = input.ts ?? Date.now();

  const action = input.correction_kind === 'avoid-this'
    ? 'retire'
    : input.correction_kind === 'prefer-from-now'
    ? 'supersede'
    : 'flag';

  const events: LifecycleEvent[] = [];
  for (const rule of rules) {
    if (rule.status !== 'active') continue;
    if (!matchesRule(evidence, rule)) continue;
    // C2: hard rule 은 retire/supersede 불변. fix-now(flag) 만 허용 — 관찰을 위한 소프트 신호.
    if (rule.strength === 'hard' && action !== 'flag') continue;
    events.push({
      kind: 't1_explicit_correction',
      rule_id: rule.rule_id,
      session_id: evidence.session_id,
      evidence: {
        source: 'evidence-store',
        refs: [evidence.evidence_id],
        metrics: { confidence: evidence.confidence },
      },
      suggested_action: action,
      ts,
    });
  }
  return events;
}
