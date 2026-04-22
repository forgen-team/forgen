/**
 * Forgen v1 — Data Model Types
 *
 * Authoritative source: docs/plans/2026-04-03-forgen-data-model-storage-spec.md
 * Runtime contracts: docs/plans/2026-04-03-forgen-component-interface-design.md
 */

// ── Quality packs ──

export type QualityPack = '보수형' | '균형형' | '속도형';

// ── Autonomy packs ──

export type AutonomyPack = '확인 우선형' | '균형형' | '자율 실행형';

// ── Judgment packs ──

export type JudgmentPack = '최소변경형' | '균형형' | '구조적접근형';

// ── Communication packs ──

export type CommunicationPack = '간결형' | '균형형' | '상세형';

// ── Trust policy ──

export type TrustPolicy = '가드레일 우선' | '승인 완화' | '완전 신뢰 실행';

// ── Rule ──

export type RuleCategory = 'quality' | 'autonomy' | 'communication' | 'workflow' | 'safety';
export type RuleScope = 'me' | 'session';
export type RuleStrength = 'soft' | 'default' | 'strong' | 'hard';
export type RuleSource = 'onboarding' | 'explicit_correction' | 'behavior_inference' | 'pack_overlay';
export type RuleStatus = 'active' | 'suppressed' | 'removed' | 'superseded';

// ── Enforcement axis (ADR-001) ──────────────────────────────────────────────
// Rule 이 어떻게 강제되는가. 직교 축: strength(중요도) × mech(검증 방식).
// 하나의 Rule 은 복수 mech 를 가질 수 있다 (예: 완료 선언 키워드 감지로 A, 문체로 B 둘 다).

export type EnforcementMech = 'A' | 'B' | 'C';
export type HookPoint = 'PreToolUse' | 'PostToolUse' | 'Stop' | 'UserPromptSubmit';

export type VerifierKind =
  | 'file_exists'
  | 'pattern_match'
  | 'tool_arg_regex'
  | 'artifact_check'
  | 'self_check_prompt';

export interface VerifierSpec {
  kind: VerifierKind;
  /** 각 kind 별로 의미가 다름 — 예: self_check_prompt 는 `question`, artifact_check 는 `path`+`max_age_s`. */
  params: Record<string, string | number | boolean>;
}

export interface EnforceSpec {
  mech: EnforcementMech;
  hook: HookPoint;
  /** Mech-A/B 에서 필수, Mech-C 에서는 미사용. */
  verifier?: VerifierSpec;
  /** Mech-A BLOCK / Mech-B self-check 시 Claude 에게 전달할 reason. */
  block_message?: string;
  /** Mech-C drift-score.ts 키 — 정량 판정 불가 규칙의 장기 누적 편향 축. */
  drift_key?: string;
  /**
   * Stop hook 전용: 어시스턴트 응답 텍스트에서 이 규칙을 발화시킬 정규식.
   * 미지정 시 shared default (완료 선언 키워드 regex) 사용.
   */
  trigger_keywords_regex?: string;
  /**
   * Stop hook 전용: trigger 가 매칭되더라도 이 regex 가 매칭되면 발화 안 함.
   * retraction/meta/테스트-맥락 등 false-positive 컨텍스트 차단용.
   */
  trigger_exclude_regex?: string;
  /**
   * UI 표시용 한 줄 태그 (Stop hook 의 `systemMessage` 로 전달).
   * 예: "rule:R-B1 — e2e-before-done"
   */
  system_tag?: string;
}

// ── Rule lifecycle (ADR-002) ────────────────────────────────────────────────
// Rule 은 영구 규범이 아니라 현재 유효한 가설. 상태 전이로 관리한다.
// phase 와 별개로 mech 는 meta_promotions 이력으로 추적 (A↔B 재분류).

export type LifecyclePhase =
  | 'active'
  | 'flagged'
  | 'suppressed'
  | 'retired'
  | 'merged'
  | 'superseded';

export interface MetaPromotion {
  at: string;
  from_mech: EnforcementMech;
  to_mech: EnforcementMech;
  reason: 'consistent_adherence' | 'repeated_violation' | 'user_override' | 'stuck_loop_force_approve';
  trigger_stats: { window_n: number; adherence_rate?: number; violation_count?: number };
}

export interface LifecycleState {
  phase: LifecyclePhase;
  first_active_at: string;
  last_inject_at?: string;
  last_violation_at?: string;
  inject_count: number;
  accept_count: number;
  violation_count: number;
  /** T3: 사용자가 rule 과 반대로 행동한 횟수 */
  bypass_count: number;
  /** T5: 충돌하는 rule_id 목록 */
  conflict_refs: string[];
  /** T5: 이 rule 이 흡수된 대상 rule_id */
  merged_into?: string;
  /** T1: 이 rule 을 교체한 rule_id */
  superseded_by?: string;
  /** Meta: mech 변경 이력 */
  meta_promotions: MetaPromotion[];
}

// ── Rule ────────────────────────────────────────────────────────────────────

/**
 * Rule JSON schema version. v0.4.0 introduces `enforce_via` + `lifecycle` — 이들을
 * 포함하는 schema 의 공식 버전은 1. 누락된 rule 파일은 pre-v0.4.0 으로 취급 (optional fields
 * 만 비어있을 뿐 로드 가능). 미래 breaking change 시 이 값을 증가시키고 `migrate()` 체인으로 흡수.
 */
export const CURRENT_RULE_SCHEMA_VERSION = 1;

export interface Rule {
  /** R5-B3: 미래 breaking schema change 를 위한 version 필드. 없으면 v0 (pre-0.4.0) 으로 취급. */
  schema_version?: number;
  rule_id: string;
  category: RuleCategory;
  scope: RuleScope;
  trigger: string;
  policy: string;
  strength: RuleStrength;
  source: RuleSource;
  status: RuleStatus;
  evidence_refs: string[];
  render_key: string;
  created_at: string;
  updated_at: string;
  /**
   * 이 rule 이 어떤 hook/verifier 로 강제되는가. optional — 기존 rule 은 null.
   * `forgen classify-enforce` 명령이 기존 rule 을 자동 분류하여 채운다.
   * ADR-001 §Data Model.
   */
  enforce_via?: EnforceSpec[];
  /**
   * Lifecycle 상태. optional — 기존 rule 은 load 시 phase='active' 로 auto-initialize.
   * ADR-002 §Data Model.
   */
  lifecycle?: LifecycleState;
}

// ── Evidence ──

export type EvidenceType = 'explicit_correction' | 'behavior_observation' | 'session_summary';

export interface Evidence {
  evidence_id: string;
  type: EvidenceType;
  session_id: string;
  timestamp: string;
  source_component: string;
  summary: string;
  axis_refs: string[];
  candidate_rule_refs: string[];
  confidence: number;
  raw_payload: Record<string, unknown>;
}

// ── Facets ──

export interface QualityFacets {
  verification_depth: number;
  stop_threshold: number;
  change_conservatism: number;
}

export interface AutonomyFacets {
  confirmation_independence: number;
  assumption_tolerance: number;
  scope_expansion_tolerance: number;
  approval_threshold: number;
}

export interface JudgmentFacets {
  minimal_change_bias: number;
  abstraction_bias: number;
  evidence_first_bias: number;
}

export interface CommunicationFacets {
  verbosity: number;
  structure: number;
  teaching_bias: number;
}

// ── Axis ──

export interface Axis<F> {
  score: number;
  facets: F;
  confidence: number;
}

// ── Profile ──

export interface Profile {
  user_id: string;
  model_version: string;
  axes: {
    quality_safety: Axis<QualityFacets>;
    autonomy: Axis<AutonomyFacets>;
    judgment_philosophy: Axis<JudgmentFacets>;
    communication_style: Axis<CommunicationFacets>;
  };
  base_packs: {
    quality_pack: QualityPack;
    autonomy_pack: AutonomyPack;
    judgment_pack: JudgmentPack;
    communication_pack: CommunicationPack;
  };
  trust_preferences: {
    desired_policy: TrustPolicy;
    source: 'onboarding' | 'user_override' | 'mismatch_recommendation';
  };
  metadata: {
    created_at: string;
    updated_at: string;
    last_onboarding_at: string;
    last_reclassification_at: string | null;
  };
}

// ── Pack Recommendation ──

export type RecommendationSource = 'onboarding' | 'mismatch_recommendation';
export type RecommendationStatus = 'proposed' | 'accepted' | 'archived';

export interface PackRecommendation {
  recommendation_id: string;
  source: RecommendationSource;
  quality_pack: QualityPack;
  autonomy_pack: AutonomyPack;
  judgment_pack: JudgmentPack;
  communication_pack: CommunicationPack;
  suggested_trust_policy: TrustPolicy;
  confidence: number;
  reason_summary: string;
  status: RecommendationStatus;
  created_at: string;
}

// ── Session Effective State ──

export type PermissionMode = 'guarded' | 'relaxed' | 'bypassed';

export interface RuntimeCapabilityState {
  permission_mode: PermissionMode;
  dangerous_skip_permissions: boolean;
  auto_accept_scope: string[];
  detected_from: string;
}

export interface SessionEffectiveState {
  session_id: string;
  profile_version: string;
  quality_pack: QualityPack;
  autonomy_pack: AutonomyPack;
  judgment_pack: JudgmentPack;
  communication_pack: CommunicationPack;
  effective_trust_policy: TrustPolicy;
  active_rule_ids: string[];
  temporary_overlays: Rule[];
  runtime_capability_state: RuntimeCapabilityState;
  warnings: string[];
  started_at: string;
  ended_at: string | null;
}

// ── Correction ──

export type CorrectionKind = 'fix-now' | 'prefer-from-now' | 'avoid-this';

export interface CorrectionRequest {
  session_id: string;
  kind: CorrectionKind;
  message: string;
  target: string;
  axis_hint: 'quality_safety' | 'autonomy' | 'judgment_philosophy' | 'communication_style' | null;
}

export interface CorrectionResult {
  temporary_rule: Rule | null;
  evidence_event_id: string;
  recompose_required: boolean;
  promotion_candidate: boolean;
}

// ── Session Learning Summary ──

export interface SessionLearningSummary {
  session_id: string;
  explicit_corrections: Evidence[];
  behavior_observations: Evidence[];
  session_summary_evidence: Evidence | null;
  rule_candidates: string[];
  knowledge_candidates: string[];
  profile_delta_suggestion: Partial<{
    quality_safety: Partial<QualityFacets>;
    autonomy: Partial<AutonomyFacets>;
  }> | null;
  pack_mismatch_candidate: boolean;
}
