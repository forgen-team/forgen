/**
 * β (beta) — Persona 부합도
 * ADR-006 §β. Wilcoxon signed-rank (ordinal robust). r ≥ 0.3 + diff ≥ +0.5.
 */

export interface BetaInput {
  pairs: { on: number; off: number }[]; // judge 4-likert per case (paired)
}

export interface BetaResult {
  pairedDiff: number;
  wilcoxonR: number;
  pValue: number;
  passes: boolean;
}

import { computeGamma } from './gamma.js';

export function computeBeta(input: BetaInput): BetaResult {
  const diffs = input.pairs.map((p) => p.on - p.off);
  const mean = diffs.reduce((a, b) => a + b, 0) / Math.max(diffs.length, 1);
  // reuse gamma's wilcoxon by faking an N-pair with zero off-slope
  const proxy = computeGamma({
    pairs: diffs.map((d) => ({ onN5: 0, onN10: d, offN5: 0, offN10: 0 })),
  });
  return {
    pairedDiff: mean,
    wilcoxonR: proxy.wilcoxonR,
    pValue: proxy.pValue,
    passes: mean >= 0.5 && proxy.wilcoxonR >= 0.3,
  };
}
