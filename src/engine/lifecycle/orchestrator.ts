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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Rule,
  LifecycleState,
  LifecyclePhase,
  RuleStatus,
} from '../../store/types.js';
import type { LifecycleEvent } from './types.js';

/**
 * R5-B1: rule 이 inactive 상태로 전이될 때 block-count 디렉터리의 잔여 파일 정리.
 * phantom stuck-loop (retired 된 rule 이 다시 GC 전까지 counter 에 반영되는 문제) 차단.
 */
function sweepBlockCountsForRule(ruleId: string): void {
  try {
    const dir = path.join(os.homedir(), '.forgen', 'state', 'enforcement', 'block-count');
    if (!fs.existsSync(dir)) return;
    const safeRuleId = String(ruleId).replace(/[^a-zA-Z0-9_.-]/g, '_');
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(`__${safeRuleId}.json`)) {
        try { fs.unlinkSync(path.join(dir, file)); } catch { /* best-effort */ }
      }
    }
  } catch { /* fail-open */ }
}

const INACTIVE_STATUSES = new Set<RuleStatus>(['removed', 'suppressed', 'superseded']);

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

  // R5-B2: phase 전이 시 상호 배타적 포인터 정리.
  if (event.suggested_action === 'merge' && event.merged_into) {
    updatedLifecycle.merged_into = event.merged_into;
    delete updatedLifecycle.superseded_by;
  }
  if (event.suggested_action === 'supersede' && event.superseded_by) {
    updatedLifecycle.superseded_by = event.superseded_by;
    delete updatedLifecycle.merged_into;
  }
  if (event.kind === 't5_conflict_detected' && event.evidence?.refs) {
    const refs = event.evidence.refs.filter((r) => r !== rule.rule_id);
    updatedLifecycle.conflict_refs = [
      ...new Set([...lifecycle.conflict_refs, ...refs]),
    ];
  }
  // retired rule 은 더 이상 의미 있는 conflict 가 없으므로 정리.
  if (event.suggested_action === 'retire') {
    updatedLifecycle.conflict_refs = [];
  }

  const nextStatusValue = nextStatus ?? rule.status;
  // R5-B1: inactive 전이 시 block-count orphan 파일 정리.
  if (INACTIVE_STATUSES.has(nextStatusValue) && !INACTIVE_STATUSES.has(rule.status)) {
    sweepBlockCountsForRule(rule.rule_id);
  }

  return {
    ...rule,
    status: nextStatusValue,
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
