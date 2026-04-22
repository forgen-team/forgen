/**
 * Lifecycle Orchestrator — 트리거 이벤트 수신 → rule 상태 전이 적용.
 *
 * 데이터 플로우:
 *   [T1~T5 + Meta] ─detect(state)→ LifecycleEvent[]
 *                                          │
 *          applyEvent(rule, event) ← ──────┘  (pure)
 *                  │
 *         ┌────────┴────────┐
 *    saveRule(rule)    persistEvent(event)
 *   (rule-store.ts)   (~/.forgen/state/lifecycle/{date}.jsonl)
 *
 * applyEvent 는 pure — rule → rule'. 부수효과는 saveRule / appendLifecycleEvents 에서만.
 *
 * 상태 전이 규칙 (ADR-002 §State transitions):
 *   flag        → phase='flagged'
 *   suppress    → phase='suppressed'  (+ status='suppressed')
 *   retire      → phase='retired'     (+ status='removed')
 *   merge       → phase='merged'      (+ merged_into)
 *   supersede   → phase='superseded'  (+ superseded_by)
 *   promote/demote_mech → phase 유지, meta_promotions 는 meta-reclassifier 가 직접 기록
 */

import type {
  Rule,
  LifecycleState,
  LifecyclePhase,
  RuleStatus,
} from '../../store/types.js';
import type { LifecycleEvent } from './types.js';

export function ensureLifecycle(rule: Rule): LifecycleState {
  return rule.lifecycle ?? {
    phase: 'active',
    first_active_at: rule.created_at,
    inject_count: 0,
    accept_count: 0,
    violation_count: 0,
    bypass_count: 0,
    conflict_refs: [],
    meta_promotions: [],
  };
}

const ACTION_TO_PHASE: Record<string, LifecyclePhase> = {
  flag: 'flagged',
  suppress: 'suppressed',
  retire: 'retired',
  merge: 'merged',
  supersede: 'superseded',
};

const ACTION_TO_STATUS: Partial<Record<string, RuleStatus>> = {
  suppress: 'suppressed',
  retire: 'removed',
  supersede: 'superseded',
};

/** 순수: rule + event → rule'. Mech 변경은 meta-reclassifier 가 처리하므로 여기서는 제외. */
export function applyEvent(rule: Rule, event: LifecycleEvent, now: number = Date.now()): Rule {
  if (event.suggested_action === 'promote_mech' || event.suggested_action === 'demote_mech') {
    // meta-reclassifier 가 rule 을 직접 변경. orchestrator 는 meta_promotions 이력만 유지.
    return rule;
  }

  const lifecycle = ensureLifecycle(rule);
  const nextPhase = ACTION_TO_PHASE[event.suggested_action];
  const nextStatus = ACTION_TO_STATUS[event.suggested_action];

  const updatedLifecycle: LifecycleState = {
    ...lifecycle,
    phase: nextPhase ?? lifecycle.phase,
  };

  // T5 merge: merged_into
  if (event.suggested_action === 'merge' && event.merged_into) {
    updatedLifecycle.merged_into = event.merged_into;
  }
  // T1 supersede: superseded_by
  if (event.suggested_action === 'supersede' && event.superseded_by) {
    updatedLifecycle.superseded_by = event.superseded_by;
  }
  // T5 conflict 탐지만 된 단계 (flag) — conflict_refs 추가
  if (event.kind === 't5_conflict_detected' && event.evidence?.refs) {
    const refs = event.evidence.refs.filter((r) => r !== rule.rule_id);
    updatedLifecycle.conflict_refs = [
      ...new Set([...lifecycle.conflict_refs, ...refs]),
    ];
  }

  return {
    ...rule,
    status: nextStatus ?? rule.status,
    lifecycle: updatedLifecycle,
    updated_at: new Date(now).toISOString(),
  };
}

/**
 * 여러 이벤트를 rule 단위로 그룹핑 후 applyEvent 로 순차 접기.
 * 순수 — 호출자가 저장을 담당.
 */
export function foldEvents(rules: Rule[], events: LifecycleEvent[], now: number = Date.now()): Map<string, Rule> {
  const byId = new Map<string, Rule>();
  for (const r of rules) byId.set(r.rule_id, r);

  for (const ev of events) {
    const current = byId.get(ev.rule_id);
    if (!current) continue;
    byId.set(ev.rule_id, applyEvent(current, ev, now));
  }
  return byId;
}
