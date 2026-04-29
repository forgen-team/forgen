/**
 * φ (phi) — False Positive Rate. ★ MASTER GATE ★
 * ADR-006 §φ. φ > 0.05 → 즉시 HARD FAIL, 다른 메트릭 무시.
 *
 * Wilson 95% CI 상한이 5%를 넘으면 FAIL.
 */

export interface PhiInput {
  // judge 4-likert: 1-2 = unreasonable block/inject (FP)
  judgements: (1 | 2 | 3 | 4)[];
}

export interface PhiResult {
  rate: number;
  wilsonUpper: number;
  passes: boolean; // wilsonUpper ≤ 0.05
  fpCount: number;
  totalCount: number;
}

/** Wilson score interval upper bound (95% CI). */
function wilsonUpper(p: number, n: number, z = 1.96): number {
  if (n === 0) return 1;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return (center + margin) / denom;
}

export function computePhi(input: PhiInput): PhiResult {
  const total = input.judgements.length;
  const fp = input.judgements.filter((j) => j <= 2).length;
  const rate = total === 0 ? 0 : fp / total;
  const upper = wilsonUpper(rate, total);
  return {
    rate,
    wilsonUpper: upper,
    passes: upper <= 0.05,
    fpCount: fp,
    totalCount: total,
  };
}
