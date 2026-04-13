/**
 * Forgen — Drift Score (Session Drift Detection)
 *
 * 세션 내 수정 패턴을 추적하여 drift(산만/반복 수정)를 감지.
 * EWMA(Exponentially Weighted Moving Average) 기반 이동평균으로
 * 최근 수정 강도를 측정하고, 임계값 초과 시 경고.
 *
 * Codex 합의: DriftState + evaluateDrift 2개만. 최소 인터페이스.
 */

/** Drift 상태 (세션 단위, STATE_DIR에 저장) */
export interface DriftState {
  sessionId: string;
  totalEdits: number;
  totalReverts: number;
  /** EWMA edit rate (0~1, 높을수록 최근 수정 빈도 높음) */
  ewmaEditRate: number;
  /** EWMA revert rate (0~1) */
  ewmaRevertRate: number;
  /** 최근 경고 timestamp (쿨다운용) */
  lastWarningAt: number;
  lastCriticalAt: number;
  hardCapReached: boolean;
}

export interface DriftResult {
  level: 'normal' | 'warning' | 'critical' | 'hardcap';
  score: number; // 0~100
  message: string | null;
}

// ── Thresholds (hook-config.json에서 오버라이드 가능) ──

export interface DriftThresholds {
  alpha?: number;           // EWMA smoothing, default 0.35
  warningEdits?: number;    // default 15
  criticalEdits?: number;   // default 30
  criticalReverts?: number; // default 2
  hardCapEdits?: number;    // default 50
  warningCooldownMs?: number;  // default 5분
  criticalCooldownMs?: number; // default 10분
}

const DEFAULTS = {
  alpha: 0.35,
  warningEdits: 15,
  criticalEdits: 30,
  criticalReverts: 2,
  hardCapEdits: 50,
  warningCooldownMs: 5 * 60 * 1000,
  criticalCooldownMs: 10 * 60 * 1000,
} as const;

/** EWMA 업데이트 (순수 함수) */
export function updateEwma(prev: number, sample: number, alpha: number): number {
  return alpha * sample + (1 - alpha) * prev;
}

/** 새 DriftState 생성 */
export function createDriftState(sessionId: string): DriftState {
  return {
    sessionId,
    totalEdits: 0,
    totalReverts: 0,
    ewmaEditRate: 0,
    ewmaRevertRate: 0,
    lastWarningAt: 0,
    lastCriticalAt: 0,
    hardCapReached: false,
  };
}

/**
 * 도구 호출 이벤트로 drift 상태를 갱신하고 평가 결과를 반환.
 * @param state 현재 상태 (mutate됨)
 * @param isEdit Write/Edit 도구 호출 여부
 * @param isRevert revert 감지 여부
 * @param thresholds 커스텀 임계치 (hook-config에서 로드)
 */
export function evaluateDrift(
  state: DriftState,
  isEdit: boolean,
  isRevert: boolean,
  thresholds: DriftThresholds = {},
): DriftResult {
  const t = { ...DEFAULTS, ...thresholds };
  const now = Date.now();

  // Update counters
  if (isEdit) state.totalEdits++;
  if (isRevert) state.totalReverts++;

  // Update EWMA
  state.ewmaEditRate = updateEwma(state.ewmaEditRate, isEdit ? 1 : 0, t.alpha);
  state.ewmaRevertRate = updateEwma(state.ewmaRevertRate, isRevert ? 1 : 0, t.alpha);

  // Calculate drift score: edit rate 65% + revert rate 35%
  const rawScore = (state.ewmaEditRate * 65) + (state.ewmaRevertRate * 35);
  const score = Math.min(100, Math.max(0, Math.round(rawScore)));

  // Hard cap
  if (state.totalEdits >= t.hardCapEdits) {
    state.hardCapReached = true;
    return {
      level: 'hardcap',
      score: 100,
      message: `[Forgen] ⛔ Session drift hard cap reached (${state.totalEdits} edits). Stop and reassess the approach before continuing.`,
    };
  }

  // Critical: 2+ reverts OR 30+ edits OR score >= 78
  if (
    (state.totalReverts >= t.criticalReverts || state.totalEdits >= t.criticalEdits || score >= 78) &&
    (now - state.lastCriticalAt > t.criticalCooldownMs)
  ) {
    state.lastCriticalAt = now;
    return {
      level: 'critical',
      score,
      message: `[Forgen] ⚠ High drift detected (score: ${score}, edits: ${state.totalEdits}, reverts: ${state.totalReverts}). Consider stopping to redesign the approach.`,
    };
  }

  // Warning: 15+ edits OR score >= 52
  if (
    (state.totalEdits >= t.warningEdits || score >= 52) &&
    (now - state.lastWarningAt > t.warningCooldownMs)
  ) {
    state.lastWarningAt = now;
    return {
      level: 'warning',
      score,
      message: `[Forgen] Drift building up (score: ${score}, edits: ${state.totalEdits}). Review your approach if changes feel repetitive.`,
    };
  }

  return { level: 'normal', score, message: null };
}
