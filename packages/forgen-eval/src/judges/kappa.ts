/**
 * κ (kappa) — Judge Agreement.
 * ADR-006 §κ. DEV: Fleiss' κ ≥ 0.8. PUBLIC: Cohen's κ ≥ 0.7.
 */

/** Cohen's kappa for 2 raters, K categories. */
export function cohensKappa(rater1: number[], rater2: number[]): number {
  if (rater1.length !== rater2.length || rater1.length === 0) return 0;
  const n = rater1.length;
  const categories = Array.from(new Set([...rater1, ...rater2]));
  let observed = 0;
  for (let i = 0; i < n; i++) if (rater1[i] === rater2[i]) observed++;
  const pO = observed / n;

  let pE = 0;
  for (const cat of categories) {
    const p1 = rater1.filter((x) => x === cat).length / n;
    const p2 = rater2.filter((x) => x === cat).length / n;
    pE += p1 * p2;
  }
  return pE === 1 ? 1 : (pO - pE) / (1 - pE);
}

/** Fleiss' kappa for M raters, N items, K categories. raters[i][j] = rating by judge j of item i. */
export function fleissKappa(raters: number[][]): number {
  if (raters.length === 0 || raters[0].length === 0) return 0;
  const N = raters.length;
  const M = raters[0].length;
  const categories = Array.from(new Set(raters.flat()));
  const K = categories.length;
  if (K < 2) return 1;

  // pj — proportion of all assignments to category j
  const pj: Record<number, number> = {};
  for (const cat of categories) {
    let count = 0;
    for (const row of raters) for (const r of row) if (r === cat) count++;
    pj[cat] = count / (N * M);
  }

  // Pi — extent of rater agreement on item i
  let sumPi = 0;
  for (const row of raters) {
    const counts: Record<number, number> = {};
    for (const r of row) counts[r] = (counts[r] ?? 0) + 1;
    let sumSq = 0;
    for (const c of Object.values(counts)) sumSq += c * c;
    sumPi += (sumSq - M) / (M * (M - 1));
  }
  const pBar = sumPi / N;
  const pBarE = Object.values(pj).reduce((acc, p) => acc + p * p, 0);
  return pBarE === 1 ? 1 : (pBar - pBarE) / (1 - pBarE);
}
