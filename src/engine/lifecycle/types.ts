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
  ts: number;
}
