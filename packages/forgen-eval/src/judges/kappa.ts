/**
 * κ (kappa) — Judge Agreement.
 * ADR-006 §κ. DEV: Fleiss' κ ≥ 0.8. PUBLIC: Cohen's κ ≥ 0.7.
 */

/** raw exact-agreement 비율 (두 rater가 같은 점수를 준 항목의 분율). */
export function rawAgreement(rater1: number[], rater2: number[]): number {
  if (rater1.length !== rater2.length || rater1.length === 0) return 0;
  let same = 0;
  for (let i = 0; i < rater1.length; i++) if (rater1[i] === rater2[i]) same++;
  return same / rater1.length;
}

/**
 * 한 rater의 점수 분산이 천장/바닥에 붙어 사실상 상수인지 판정.
 *
 * Cohen's κ 는 한 rater가 (거의) 상수면 P_e→P_o 라 κ→0 으로 퇴화한다
 * (prevalence/κ paradox). 이때 낮은 κ 는 "불일치"가 아니라 "분산 없음"이다.
 * 판정: 서로 다른 범주가 1개뿐이거나, 한 범주가 전체의 (n-1)/n 이상.
 */
export function hasVarianceCollapse(rater: number[]): boolean {
  const n = rater.length;
  if (n === 0) return true;
  const counts = new Map<number, number>();
  for (const v of rater) counts.set(v, (counts.get(v) ?? 0) + 1);
  if (counts.size < 2) return true;
  const maxCount = Math.max(...counts.values());
  return maxCount >= n - 1; // 최대 1개 항목만 빼고 전부 한 범주
}

export interface KappaGateResult {
  pass: boolean;
  kappa: number;
  rawAgreement: number;
  varianceCollapse: boolean;
  /** 어떤 기준으로 판정했는지 — 'kappa'(정상) | 'agreement'(퇴화 폴백) */
  criterion: 'kappa' | 'agreement';
  detail: string;
}

/**
 * κ 게이트 (v0.5.0 R2 재정의).
 *
 * 정상 케이스: Cohen's κ ≥ threshold(기본 0.5) 이면 통과.
 * 분산 퇴화 케이스(한 rater가 천장/바닥 상수 → κ 무의미): raw exact-agreement
 * ≥ agreementFloor(기본 0.8) 로 폴백 판정. 프론티어 모델이 교정 의도를
 * baseline 에서 지켜 점수가 near-all-4 로 붙는 blocks=0 발견과 같은 뿌리 —
 * "저지가 못 맞춰서"가 아니라 "잴 분산이 없어서" κ 가 0 이 된다.
 *
 * 어떤 기준으로 통과/실패했는지 criterion 으로 명시 보고한다 (숨은 완화 금지).
 */
export function kappaGate(
  rater1: number[],
  rater2: number[],
  opts: { threshold?: number; agreementFloor?: number } = {},
): KappaGateResult {
  const threshold = opts.threshold ?? 0.5;
  const agreementFloor = opts.agreementFloor ?? 0.8;
  const kappa = cohensKappa(rater1, rater2);
  const agreement = rawAgreement(rater1, rater2);
  const collapse = hasVarianceCollapse(rater1) || hasVarianceCollapse(rater2);

  if (!collapse) {
    return {
      pass: kappa >= threshold,
      kappa,
      rawAgreement: agreement,
      varianceCollapse: false,
      criterion: 'kappa',
      detail: `κ=${kappa.toFixed(3)} ${kappa >= threshold ? '≥' : '<'} ${threshold}`,
    };
  }
  // 분산 퇴화 → agreement 폴백
  return {
    pass: agreement >= agreementFloor,
    kappa,
    rawAgreement: agreement,
    varianceCollapse: true,
    criterion: 'agreement',
    detail:
      `variance collapse (κ=${kappa.toFixed(3)} degenerate) → raw agreement=` +
      `${(agreement * 100).toFixed(0)}% ${agreement >= agreementFloor ? '≥' : '<'} ${(agreementFloor * 100).toFixed(0)}%`,
  };
}

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
