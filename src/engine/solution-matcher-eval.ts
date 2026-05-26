/**
 * Bootstrap evaluator + IR metrics for the solution matcher.
 *
 * Extracted from solution-matcher.ts — test/CI infrastructure for measuring
 * matcher quality against labeled fixtures. No production side-effects.
 */

import { extractTags } from './solution-format.js';
import { rankCandidates } from './ranking-pipeline.js';

/**
 * In-memory solution shape for the bootstrap evaluator. Mirrors the index
 * entry fields that `matchSolutions` consumes (tags, identifiers, confidence)
 * but without any filesystem dependency.
 */
export interface EvalSolution {
  name: string;
  tags: string[];
  identifiers?: string[];
  confidence: number;
}

export interface EvalQuery {
  query: string;
  /** Names that should appear in the top-5. Empty array = expect no match (negative case). */
  expectAnyOf: string[];
}

export interface EvalFixture {
  solutions: EvalSolution[];
  positive: EvalQuery[];
  /** Bilingual or compound-word variants that exercise synonym expansion. */
  paraphrase: EvalQuery[];
  /** Unrelated queries that should not return a top-1 hit. */
  negative: EvalQuery[];
}

/** Per-bucket metrics. Paraphrase and positive are reported separately so a
 *  bilingual regression (T2 synonym change) can't hide inside the aggregate. */
export interface BucketMetrics {
  /** |{q : ∃i≤5, ranked[i] ∈ q.expectAnyOf}| / |q| */
  recallAt5: number;
  /** Σ (1 / firstMatchRank) / |q|; rank > 5 contributes 0. */
  mrrAt5: number;
  /** |{q : ranked is empty}| / |q| */
  noResultRate: number;
  /** Number of queries in this bucket. */
  total: number;
}

export interface EvalResult {
  /** Combined (positive ∪ paraphrase) metrics — backwards-compatible headline numbers. */
  recallAt5: number;
  mrrAt5: number;
  noResultRate: number;
  /**
   * Fraction of negative queries where the matcher returned ≥ 1 candidate
   * (regardless of rank).
   */
  negativeAnyResultRate: number;
  /** Per-bucket breakdown — use these to catch paraphrase-only regressions. */
  byBucket: {
    positive: BucketMetrics;
    paraphrase: BucketMetrics;
  };
  total: {
    positive: number;
    paraphrase: number;
    negative: number;
  };
}

/**
 * Round 3 baseline metrics, recorded against the current `term-normalizer`
 * + `calculateRelevance` + fixture `solution-match-bootstrap.json`. Used as
 * a relative regression guard in `tests/solution-matcher-eval.test.ts` —
 * downstream PRs must not regress any field by more than `BASELINE_TOLERANCE`.
 *
 * History (chronological ascending — v1 at top, latest at bottom):
 *   - v1 (2026-04-08, fixture v1, 41+10+10 queries): 1.0 / 1.0 / 0.0 / 0.1
 *   - v2 (2026-04-08, fixture v2, 53+16+14 queries): 1.0 / 0.969 / 0.0 / 0.357
 *   - v3 (2026-04-08, fixture v2 + R4-T1 compound-tag fix): 1.0 / 0.986 / 0.0 / 0.357
 *   - v4 (2026-04-08, fixture v2 + R4-T1 + R4-T2 phrase blocklist): 1.0 / 0.986 / 0.0 / 0.143
 *   - v5 (2026-04-08, fixture v2 + R4-T1 + R4-T2 + R4-T3 specificity guards): 1.0 / 0.986 / 0.0 / 0.000
 *
 * If a PR legitimately improves a metric, update this constant in the same
 * commit so future PRs guard against the new floor.
 */
export const ROUND3_BASELINE: EvalResult = {
  recallAt5: 1.0,
  mrrAt5: 0.986,
  noResultRate: 0.0,
  negativeAnyResultRate: 0.0,
  byBucket: {
    positive: { recallAt5: 1.0, mrrAt5: 0.981, noResultRate: 0.0, total: 53 },
    paraphrase: { recallAt5: 1.0, mrrAt5: 1.0, noResultRate: 0.0, total: 16 },
  },
  total: { positive: 53, paraphrase: 16, negative: 14 },
};

/** Maximum allowed absolute regression per metric. */
export const BASELINE_TOLERANCE = 0.05;

/** Run a single bucket through the ranking pipeline and aggregate IR metrics. */
function computeBucketMetrics(queries: EvalQuery[], solutions: EvalSolution[]): BucketMetrics {
  let recallHits = 0;
  let reciprocalSum = 0;
  let noResultCount = 0;

  for (const q of queries) {
    const promptTags = extractTags(q.query);
    const ranked = rankCandidates(promptTags, q.query.toLowerCase(), solutions);
    if (ranked.length === 0) {
      noResultCount++;
      continue;
    }
    for (let i = 0; i < ranked.length; i++) {
      if (q.expectAnyOf.includes(ranked[i].solution.name)) {
        recallHits++;
        reciprocalSum += 1 / (i + 1);
        break;
      }
    }
  }

  const total = queries.length;
  return {
    recallAt5: total > 0 ? recallHits / total : 0,
    mrrAt5: total > 0 ? reciprocalSum / total : 0,
    noResultRate: total > 0 ? noResultCount / total : 0,
    total,
  };
}

/**
 * Test/diagnostic helper: evaluate one query against a fixture solution set
 * and return the top-5 ranked candidates with their relevance + matched tags.
 */
export function evaluateQuery(
  query: string,
  solutions: readonly EvalSolution[],
): Array<{ name: string; relevance: number; matchedTags: string[] }> {
  const promptTags = extractTags(query);
  return rankCandidates(promptTags, query.toLowerCase(), solutions).map((c) => ({
    name: c.solution.name,
    relevance: c.relevance,
    matchedTags: c.matchedTags,
  }));
}

/**
 * Evaluate the current matcher against a labeled fixture and return IR
 * metrics. Uses `rankCandidates` (shared with `matchSolutions`) so the
 * evaluator can't silently drift from production ranking behaviour.
 */
export function evaluateSolutionMatcher(fixture: EvalFixture): EvalResult {
  const positiveM = computeBucketMetrics(fixture.positive, fixture.solutions);
  const paraphraseM = computeBucketMetrics(fixture.paraphrase, fixture.solutions);

  const combinedTotal = positiveM.total + paraphraseM.total;
  const recallAt5 =
    combinedTotal > 0
      ? (positiveM.recallAt5 * positiveM.total + paraphraseM.recallAt5 * paraphraseM.total) /
        combinedTotal
      : 0;
  const mrrAt5 =
    combinedTotal > 0
      ? (positiveM.mrrAt5 * positiveM.total + paraphraseM.mrrAt5 * paraphraseM.total) /
        combinedTotal
      : 0;
  const noResultRate =
    combinedTotal > 0
      ? (positiveM.noResultRate * positiveM.total + paraphraseM.noResultRate * paraphraseM.total) /
        combinedTotal
      : 0;

  let negAnyResult = 0;
  for (const q of fixture.negative) {
    const promptTags = extractTags(q.query);
    const ranked = rankCandidates(promptTags, q.query.toLowerCase(), fixture.solutions);
    if (ranked.length >= 1) negAnyResult++;
  }
  const negTotal = fixture.negative.length;

  return {
    recallAt5,
    mrrAt5,
    noResultRate,
    negativeAnyResultRate: negTotal > 0 ? negAnyResult / negTotal : 0,
    byBucket: {
      positive: positiveM,
      paraphrase: paraphraseM,
    },
    total: {
      positive: fixture.positive.length,
      paraphrase: fixture.paraphrase.length,
      negative: fixture.negative.length,
    },
  };
}
