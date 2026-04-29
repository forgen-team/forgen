/**
 * γ (gamma) — 시간축 행동 변화
 * ADR-006 §γ. N=1 제외, N=5,10 슬로프의 paired diff.
 */

export interface GammaInput {
  // per case: forgen-on / forgen-off scores at depths 5 and 10
  pairs: { onN5: number; onN10: number; offN5: number; offN10: number }[];
}

export interface GammaResult {
  cohenD: number;
  wilcoxonR: number;
  pValue: number;
  effectiveN: number;
  passes: boolean;
}

/** Slope from N=5 to N=10 (per-case). */
function slope(s5: number, s10: number): number {
  return (s10 - s5) / (10 - 5);
}

/** Cohen's d for paired samples = mean(diff) / sd(diff). */
function cohenD(diffs: number[]): number {
  if (diffs.length < 2) return 0;
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const variance =
    diffs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (diffs.length - 1);
  const sd = Math.sqrt(variance);
  return sd === 0 ? 0 : mean / sd;
}

/** Wilcoxon signed-rank (paired). Returns Z and effect r = Z / √N. */
function wilcoxonSignedRank(diffs: number[]): { z: number; r: number; p: number } {
  const nonZero = diffs.filter((d) => d !== 0);
  const n = nonZero.length;
  if (n < 5) return { z: 0, r: 0, p: 1 };

  const ranked = nonZero
    .map((d) => ({ abs: Math.abs(d), sign: Math.sign(d) }))
    .sort((a, b) => a.abs - b.abs);

  // assign ranks (handle ties via average ranks)
  const ranks: number[] = new Array(ranked.length);
  let i = 0;
  while (i < ranked.length) {
    let j = i;
    while (j + 1 < ranked.length && ranked[j + 1].abs === ranked[i].abs) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }

  const wPlus = ranked.reduce(
    (acc, r, idx) => (r.sign > 0 ? acc + ranks[idx] : acc),
    0,
  );
  const expected = (n * (n + 1)) / 4;
  const variance = (n * (n + 1) * (2 * n + 1)) / 24;
  const z = (wPlus - expected) / Math.sqrt(variance);
  // Two-tailed p-value via standard normal approximation
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, r: Math.abs(z) / Math.sqrt(n), p };
}

function normalCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26 approximation
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989423 * Math.exp(-(x * x) / 2);
  const prob =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 1 - prob;
}

export function computeGamma(input: GammaInput): GammaResult {
  // diff_i = (slope_on_i - slope_off_i) — paired
  const diffs = input.pairs.map((p) => slope(p.onN5, p.onN10) - slope(p.offN5, p.offN10));
  const d = cohenD(diffs);
  const w = wilcoxonSignedRank(diffs);
  return {
    cohenD: d,
    wilcoxonR: w.r,
    pValue: w.p,
    effectiveN: diffs.filter((x) => x !== 0).length,
    passes: d >= 0.8 && w.r >= 0.3,
  };
}
