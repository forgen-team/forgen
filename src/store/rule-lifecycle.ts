/**
 * Rule lifecycle factory + helpers — single source of truth for defaults/normalization.
 *
 * R6-F1 (2026-04-22): 이전에는 `rule.lifecycle ?? { phase: 'active', inject_count: 0, ... }`
 * 리터럴이 rule-store, orchestrator, meta-reclassifier 등 5곳에 복제되어 필드 추가 시 동시
 * 수정 필수였다. 한 곳에서 불변식을 걸고 모든 호출자가 이 함수를 통해 lifecycle 을 얻도록 통합.
 *
 * root-cause-analyst (R6) 분석: "Rule 이 data file + state machine 이중 정체성을 가지면서
 * 기본값 재합성이 N 군데에 분산" 이 R4-B2(음수 corruption)/R5-B1(orphan)/R5-B2(mutex)/api-H1
 * 등 버그 클러스터의 공통 뿌리. 이 factory 가 그 뿌리를 차단.
 */

import type { Rule, LifecycleState, MetaPromotion } from './types.js';

/** safe non-negative integer normalization — 파일 corruption / 다중 writer race 방어. */
export function safeCount(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Rule 에 대해 정규화된 LifecycleState 반환 (pure — rule 을 변경하지 않음).
 * 기존 lifecycle 이 있으면 카운터를 safeCount 로 정규화한 사본, 없으면 초기 상태.
 */
export function initLifecycle(rule: Rule): LifecycleState {
  const existing = rule.lifecycle;
  if (existing) {
    return {
      phase: existing.phase,
      first_active_at: existing.first_active_at,
      last_inject_at: existing.last_inject_at,
      last_violation_at: existing.last_violation_at,
      inject_count: safeCount(existing.inject_count),
      accept_count: safeCount(existing.accept_count),
      violation_count: safeCount(existing.violation_count),
      bypass_count: safeCount(existing.bypass_count),
      conflict_refs: Array.isArray(existing.conflict_refs) ? [...existing.conflict_refs] : [],
      merged_into: existing.merged_into,
      superseded_by: existing.superseded_by,
      meta_promotions: Array.isArray(existing.meta_promotions) ? [...existing.meta_promotions] : [],
    };
  }
  return {
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

/** inject count + last_inject_at 을 한 단계 증가 — markRulesInjected 의 공통 로직. */
export function bumpInject(lifecycle: LifecycleState, nowIso: string): LifecycleState {
  return {
    ...lifecycle,
    inject_count: lifecycle.inject_count + 1,
    last_inject_at: nowIso,
  };
}

/** meta_promotions 에 새 entry append (immutable). */
export function appendMetaPromotion(lifecycle: LifecycleState, promotion: MetaPromotion): LifecycleState {
  return {
    ...lifecycle,
    meta_promotions: [...lifecycle.meta_promotions, promotion],
  };
}
