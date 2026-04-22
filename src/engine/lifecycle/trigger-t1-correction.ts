/**
 * T1 — 사용자 명시 교정 (explicit_correction).
 *
 * 입력: Evidence(type='explicit_correction') + rules[].
 * 로직:
 *   1. evidence.axis_refs 에 rule.category 매칭 OR evidence.summary 에 rule.render_key 토큰 포함 → rule 매칭
 *   2. correction kind 에 따라 suggested_action 결정:
 *      - 'avoid-this' (이 rule 을 따르지 말아라) → retire
 *      - 'fix-now'   (이 rule 을 수정해야 한다) → flag (사용자 후속 편집 대기)
 *      - 'prefer-from-now' (새 선호로 대체) → supersede
 *
 * 출력: LifecycleEvent[]. 순수 — IO 없음.
 */

import type { Evidence, Rule, RuleCategory } from '../../store/types.js';
import type { LifecycleEvent } from './types.js';

export interface T1Input {
  evidence: Evidence;
  /** 교정의 행동 종류 — 있으면 더 정확한 action 결정. */
  correction_kind?: 'avoid-this' | 'fix-now' | 'prefer-from-now';
  rules: Rule[];
  ts?: number;
}

const CATEGORY_AXIS_MAP: Record<RuleCategory, string[]> = {
  quality: ['quality_safety', 'quality'],
  autonomy: ['autonomy'],
  communication: ['communication_style', 'communication'],
  workflow: ['workflow', 'judgment_philosophy'],
  safety: ['quality_safety', 'safety'],
};

function matchesRule(evidence: Evidence, rule: Rule): boolean {
  const axes = CATEGORY_AXIS_MAP[rule.category] ?? [];
  if (axes.some((a) => evidence.axis_refs.includes(a))) return true;

  if (evidence.candidate_rule_refs.includes(rule.rule_id)) return true;

  const keyTokens = rule.render_key.split(/[._-]/).filter((t) => t.length > 2);
  if (keyTokens.length > 0) {
    const summaryLower = evidence.summary.toLowerCase();
    if (keyTokens.some((t) => summaryLower.includes(t.toLowerCase()))) return true;
  }
  return false;
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
