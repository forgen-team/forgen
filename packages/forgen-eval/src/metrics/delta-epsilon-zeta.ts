/**
 * δ (block rate), ε (inject rate), ζ (persistence) — derived from event traces.
 * ADR-006 §δ/ε/ζ.
 */

export interface RatePassResult {
  rate: number;
  passes: boolean;
  threshold: number;
}

/** δ — Mech-A block effectiveness: blocks_caught / blocks_attempted. */
export function computeDelta(blocksCaught: number, blocksAttempted: number): RatePassResult {
  const rate = blocksAttempted === 0 ? 0 : blocksCaught / blocksAttempted;
  return { rate, passes: rate >= 0.9, threshold: 0.9 };
}

/** ε — Mech-B self-check inject rate: inject_triggered / violations_seeded. */
export function computeEpsilon(
  injectTriggered: number,
  violationsSeeded: number,
): RatePassResult {
  const rate = violationsSeeded === 0 ? 0 : injectTriggered / violationsSeeded;
  return { rate, passes: rate >= 0.85, threshold: 0.85 };
}

/** ζ — Profile persistence: rules_still_applied_at_R52 / rules_corrected_at_R1. */
export function computeZeta(stillApplied: number, originallyCorrected: number): RatePassResult {
  const rate =
    originallyCorrected === 0 ? 0 : stillApplied / originallyCorrected;
  return { rate, passes: rate >= 0.85, threshold: 0.85 };
}
