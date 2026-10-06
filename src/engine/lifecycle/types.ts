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
  source: 'stop-guard' | 'subagent-stop-guard' | 'pre-tool-guard' | 'post-tool-guard' | 'evidence-store' | 'manual';
  /**
   * block/deny = 실제 차단. correction = 메타가드 advise(기록만). bypass_confirmed = 사용자가
   * FORGEN_USER_CONFIRMED=1 로 명시 우회(ADR-017 D1 — T3 의 유일한 입력).
   */
  kind: 'block' | 'deny' | 'correction' | 'bypass_confirmed';
  message_preview?: string;
  // ── ADR-017 D1 영수증 필드 (전부 optional — 구 리더 호환) ──
  /** 영수증 식별자. `forgen block <id> --ok|--fp` 와 verdicts.jsonl 조인 키. */
  violation_id?: string;
  /** 어느 패턴/프래그먼트가 매칭됐는가 (최대 160자). */
  matched?: string;
  target_kind?: 'command' | 'response' | 'file';
  /** 전문 sha256 앞 16자 — 전문은 receipts/<id>.txt 에 24h TTL 로만 보관. */
  target_hash?: string;
}

export type Verdict = 'correct' | 'false_positive' | 'unsure';

export interface VerdictEntry {
  at: string;
  violation_id: string;
  rule_id: string;
  verdict: Verdict;
  /** 사람 > 모델. user 판정은 auto 를 덮어쓴다. */
  by: 'auto' | 'user';
  reason?: string;
}

/** D2: Stop 에서 실제 평가된 룰의 결과 (통과/위반). violations.jsonl 과 분리 — T2·explain 오염 방지. */
export interface CheckEntry {
  at: string;
  session_id: string;
  rule_id: string;
  result: 'pass' | 'violation';
}

export interface BypassEntry {
  at: string;
  rule_id: string;
  session_id: string;
  tool: string;
  pattern_preview: string;
}
