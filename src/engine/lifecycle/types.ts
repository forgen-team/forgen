/**
 * ADR-002 Lifecycle event model.
 *
 * 오케스트레이터가 발행하는 이벤트 — rule 상태 전이의 단위.
 * 이 파일은 타입만 정의. 실제 이벤트 발행/소비 로직은 각 trigger-*.ts 참조.
 */

export type LifecycleEventKind =
  | 't1_explicit_correction'
  | 't2_repeated_violation'
  | 't3_user_bypass'
  | 't4_time_decay'
  | 't5_conflict_detected'
  | 'meta_promote_to_a'
  | 'meta_demote_to_b';

export type LifecycleSuggestedAction =
  | 'flag'
  | 'suppress'
  | 'retire'
  | 'merge'
  | 'supersede'
  | 'promote_mech'
  | 'demote_mech';

export interface LifecycleEvent {
  kind: LifecycleEventKind;
  rule_id: string;
  session_id?: string;
  evidence?: {
    source: string;
    refs: string[];
    metrics?: Record<string, number>;
  };
  suggested_action: LifecycleSuggestedAction;
  /** T5 merge 전용: 흡수 대상 rule_id */
  merged_into?: string;
  /** T1 supersede 전용: 교체 rule_id */
  superseded_by?: string;
  ts: number;
}

/**
 * 트리거들이 공유하는 rule-level 시그널 집계.
 * RuleState 는 Rule + signals (pure data). 각 detect() 는 이 상태 배열을 입력으로 받는다.
 */
export interface RuleSignals {
  violations_30d: number;
  violation_rate_30d: number;
  bypass_7d: number;
  last_inject_days_ago: number;
  injects_rolling_n: number;
  violations_rolling_n: number;
  last_updated_days_ago: number;
}

export interface ViolationEntry {
  at: string;
  rule_id: string;
  session_id: string;
  source: 'stop-guard' | 'pre-tool-guard' | 'post-tool-guard' | 'evidence-store' | 'manual';
  kind: 'block' | 'deny' | 'correction';
  message_preview?: string;
}

export interface BypassEntry {
  at: string;
  rule_id: string;
  session_id: string;
  tool: string;
  pattern_preview: string;
}
