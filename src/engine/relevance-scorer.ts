/**
 * Tag-based relevance scoring for solution matching.
 *
 * Extracted from solution-matcher.ts — the core scoring logic that computes
 * relevance between a prompt's tags and a solution's tags using a TF-IDF +
 * BM25 + bigram ensemble.
 */

import { bigramSimilarity, bm25Score, tagWeight } from './scoring-algorithms.js';
import { extractTags } from './solution-format.js';
import { defaultNormalizer } from './term-normalizer.js';

/**
 * Optional hints for the v3 `calculateRelevance` path. Used by hot-path
 * callers (matchSolutions, searchSolutions) to avoid re-normalizing the
 * same query tags on every solution.
 */
export interface CalculateRelevanceOptions {
  /**
   * Pre-normalized prompt tags (produced by `defaultNormalizer.normalizeTerms`).
   * If provided, skips the per-call expansion. Callers loop-running against
   * many solutions should compute this once outside the loop and pass it in.
   */
  normalizedPromptTags?: string[];
  /**
   * R4-T1: solution tags expanded with compound-split alternatives
   * (`expandCompoundTags`). When supplied, the intersection/partial-match
   * step uses this set INSTEAD of `solutionTags`, but the Jaccard union
   * denominator still uses `solutionTags` (raw) so the score normalization
   * stays semantically stable. Caller responsibility to pass the matching
   * pair — `solutionTagsExpanded` MUST be a superset of `solutionTags`.
   */
  solutionTagsExpanded?: string[];
  /** Average document (solution) tag count for BM25 normalization. Defaults to 6. */
  avgDocLength?: number;
  /** Meta-learning: dynamic ensemble weights (sum must equal 1.0). Defaults to {tfidf:0.5, bm25:0.3, bigram:0.2}. */
  ensembleWeights?: { tfidf: number; bm25: number; bigram: number };
}

export function calculateRelevance(
  promptTags: string[],
  solutionTags: string[],
  confidence: number,
  options?: CalculateRelevanceOptions,
): { relevance: number; matchedTags: string[] };
/** @deprecated */
export function calculateRelevance(prompt: string, keywords: string[]): number;
export function calculateRelevance(
  promptOrTags: string | string[],
  keywordsOrTags: string[],
  confidence?: number,
  options?: CalculateRelevanceOptions,
): number | { relevance: number; matchedTags: string[] } {
  if (typeof promptOrTags === 'string') {
    // Legacy mode: substring matching for backwards compatibility.
    // Not a hot path — only hit by the (old) solution-matcher.test.ts cases.
    const promptTags = extractTags(promptOrTags);
    const intersection = keywordsOrTags.filter((kw) =>
      promptTags.some(
        (pt) =>
          pt === kw || (pt.length > 3 && kw.length > 3 && (pt.startsWith(kw) || kw.startsWith(pt))),
      ),
    );
    return Math.min(1, intersection.length / Math.max(promptTags.length * 0.5, 1));
  }
  // v3 mode: tag matching with synonym expansion + TF-IDF weighting.
  const expandedPromptTags =
    options?.normalizedPromptTags ?? defaultNormalizer.normalizeTerms(promptOrTags);

  // R4-T1: when the caller supplies a compound-expanded solution tag set,
  // intersection and partial matching run against the expanded set.
  const matchTags = options?.solutionTagsExpanded ?? keywordsOrTags;

  const intersection = matchTags.filter((t) => expandedPromptTags.includes(t));

  // partial/substring matches for longer tags (>3 chars)
  const partialMatches = matchTags.filter(
    (t) =>
      t.length > 3 &&
      !intersection.includes(t) &&
      expandedPromptTags.some((pt) => pt.length > 3 && (pt.includes(t) || t.includes(pt))),
  );

  // Apply TF-IDF weighting: common tags count less
  const weightedMatched =
    intersection.reduce((sum, t) => sum + tagWeight(t), 0) +
    partialMatches.reduce((sum, t) => sum + tagWeight(t) * 0.5, 0);

  // Bigram similarity boost for borderline cases
  if (weightedMatched < 0.5) {
    let bestBigramScore = 0;
    const bigramMatchedTags: string[] = [];
    for (const st of matchTags) {
      for (const pt of expandedPromptTags) {
        const sim = bigramSimilarity(pt, st);
        if (sim > bestBigramScore) {
          bestBigramScore = sim;
        }
        if (sim > 0.4 && !bigramMatchedTags.includes(st)) {
          bigramMatchedTags.push(st);
        }
      }
    }

    if (bestBigramScore > 0.4) {
      const union = new Set([...promptOrTags, ...keywordsOrTags]).size;
      const tfidfScore = weightedMatched / Math.max(union, 1);
      const blendedScore = tfidfScore * 0.8 + bestBigramScore * 0.2;
      return {
        relevance: blendedScore * (confidence ?? 1),
        matchedTags: [
          ...intersection,
          ...partialMatches,
          ...bigramMatchedTags.filter(
            (t) => !intersection.includes(t) && !partialMatches.includes(t),
          ),
        ],
      };
    }

    return { relevance: 0, matchedTags: [] };
  }

  // Ensemble: TF-IDF (Jaccard) 0.5 + BM25 0.3 + bigram 0.2
  const union = new Set([...promptOrTags, ...keywordsOrTags]).size;
  const tfidfScore = weightedMatched / Math.max(union, 1);

  const avgDocLen = options?.avgDocLength ?? 6;
  const bm25 = bm25Score(promptOrTags as string[], keywordsOrTags, avgDocLen);

  let bigramBoost = 0;
  for (const st of matchTags) {
    for (const pt of expandedPromptTags) {
      const sim = bigramSimilarity(pt, st);
      if (sim > bigramBoost) bigramBoost = sim;
    }
  }

  const w = options?.ensembleWeights ?? { tfidf: 0.5, bm25: 0.3, bigram: 0.2 };
  const ensembleScore = tfidfScore * w.tfidf + bm25 * w.bm25 + bigramBoost * w.bigram;
  return {
    relevance: ensembleScore * (confidence ?? 1),
    matchedTags: [...intersection, ...partialMatches],
  };
}
