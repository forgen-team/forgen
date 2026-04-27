/**
 * Forgen v1 — Evidence Processor
 *
 * 교정/관찰 → Evidence 생성 + facet 조정 제안 인터페이스.
 * Migration Plan §5.4: 이 모듈의 "해석" 계층은 AI(Claude 세션)가 채운다.
 * 여기서는 구조화된 입출력 인터페이스와 알고리즘 적용 함수만 정의.
 */

import type {
  CorrectionRequest,
  CorrectionResult,
  Rule,
  SessionLearningSummary,
  QualityFacets,
  AutonomyFacets,
} from '../store/types.js';
import { createEvidence, appendEvidence } from '../store/evidence-store.js';
import { createRule, saveRule } from '../store/rule-store.js';
import { classify, applyProposal } from '../engine/enforce-classifier.js';
import { bumpAxisConfidence } from '../store/profile-store.js';

// ── Correction → Evidence + Temporary Rule ──

/**
 * 사용자 교정을 Evidence로 기록하고, 필요 시 temporary rule 생성.
 * axis_hint는 AI(Claude 세션)가 제공하는 것을 전제.
 */
export function processCorrection(req: CorrectionRequest): CorrectionResult {
  // Evidence 기록
  const evidence = createEvidence({
    type: 'explicit_correction',
    session_id: req.session_id,
    source_component: 'Hooks',
    summary: req.message,
    axis_refs: req.axis_hint ? [req.axis_hint] : [],
    confidence: 0.85, // explicit correction은 기본 높은 confidence
    raw_payload: {
      kind: req.kind,
      target: req.target,
      axis_hint: req.axis_hint,
      // avoid-this는 현재 설정과 반대 방향의 교정 → mismatch 감지용
      direction: req.kind === 'avoid-this' ? 'opposite' : 'same',
    },
  });
  appendEvidence(evidence); // T1 lifecycle trigger fires here for explicit_correction

  // D2 fix (2026-04-27): explicit_correction 의 axis_hint 가 axes confidence 에
  // 직접 반영되도록 bump. autonomy 6건이 score 못 움직였던 결함 해결.
  // 회귀 안전: facet 값은 안 건드리고 confidence 만 +0.02 (avoid-this 는 +0.04
  // 로 더 강한 신호). docs/issues/D2-autonomy-facet-stuck.md 참조.
  if (req.axis_hint) {
    const bump = req.kind === 'avoid-this' ? 0.04 : 0.02;
    try { bumpAxisConfidence(req.axis_hint, bump); } catch { /* fail-open */ }
  }

  // fix-now, avoid-this → temporary session rule
  let temporaryRule: Rule | null = null;
  if (req.kind === 'fix-now' || req.kind === 'avoid-this') {
    temporaryRule = createRule({
      category: req.axis_hint === 'quality_safety' ? 'quality'
        : req.axis_hint === 'autonomy' ? 'autonomy'
        : 'workflow',
      scope: 'session',
      trigger: req.target,
      policy: req.message,
      strength: req.kind === 'avoid-this' ? 'strong' : 'default',
      source: 'explicit_correction',
      evidence_refs: [evidence.evidence_id],
      render_key: `${req.axis_hint ?? 'workflow'}.${req.target.toLowerCase().replace(/\s+/g, '-').slice(0, 30)}`,
    });
    // ADR-001 auto-classify on creation — 교정 즉시 enforce_via 가 붙어야 다음 턴부터 Mech-A/B 발화.
    // 기존 `forgen classify-enforce --apply` 수동 경로를 유지하되, 신규 rule 은 창조 시점에 자동 populate.
    try {
      const proposal = classify(temporaryRule);
      temporaryRule = applyProposal(temporaryRule, proposal);
    } catch { /* fail-open: classify 실패는 rule 저장 자체를 막지 않음 */ }
    saveRule(temporaryRule);
  }

  return {
    temporary_rule: temporaryRule,
    evidence_event_id: evidence.evidence_id,
    recompose_required: temporaryRule !== null,
    promotion_candidate: req.kind === 'prefer-from-now' || req.kind === 'avoid-this',
  };
}

// ── Facet Delta 적용 (알고리즘 계층) ──

/**
 * SessionLearningSummary의 profile_delta_suggestion을 현재 facet에 적용.
 * delta 값은 AI가 제안한 것이고, 이 함수는 clamp만 수행.
 */
export function applyFacetDelta(
  currentQuality: QualityFacets,
  currentAutonomy: AutonomyFacets,
  delta: SessionLearningSummary['profile_delta_suggestion'],
): { quality: QualityFacets; autonomy: AutonomyFacets } {
  if (!delta) return { quality: { ...currentQuality }, autonomy: { ...currentAutonomy } };

  const clamp = (v: number) => Math.max(0.0, Math.min(1.0, v));

  const quality: QualityFacets = { ...currentQuality };
  if (delta.quality_safety) {
    if (delta.quality_safety.verification_depth !== undefined)
      quality.verification_depth = clamp(quality.verification_depth + delta.quality_safety.verification_depth);
    if (delta.quality_safety.stop_threshold !== undefined)
      quality.stop_threshold = clamp(quality.stop_threshold + delta.quality_safety.stop_threshold);
    if (delta.quality_safety.change_conservatism !== undefined)
      quality.change_conservatism = clamp(quality.change_conservatism + delta.quality_safety.change_conservatism);
  }

  const autonomy: AutonomyFacets = { ...currentAutonomy };
  if (delta.autonomy) {
    if (delta.autonomy.confirmation_independence !== undefined)
      autonomy.confirmation_independence = clamp(autonomy.confirmation_independence + delta.autonomy.confirmation_independence);
    if (delta.autonomy.assumption_tolerance !== undefined)
      autonomy.assumption_tolerance = clamp(autonomy.assumption_tolerance + delta.autonomy.assumption_tolerance);
    if (delta.autonomy.scope_expansion_tolerance !== undefined)
      autonomy.scope_expansion_tolerance = clamp(autonomy.scope_expansion_tolerance + delta.autonomy.scope_expansion_tolerance);
    if (delta.autonomy.approval_threshold !== undefined)
      autonomy.approval_threshold = clamp(autonomy.approval_threshold + delta.autonomy.approval_threshold);
  }

  return { quality, autonomy };
}
