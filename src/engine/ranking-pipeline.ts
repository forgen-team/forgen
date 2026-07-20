/**
 * Shared ranking core for solution matching.
 *
 * Extracted from solution-matcher.ts — the ranking pipeline used by both
 * production (matchSolutions) and the bootstrap evaluator
 * (evaluateSolutionMatcher). Single source of truth for ranking behaviour.
 */

import { maskBlockedTokens } from './phrase-blocklist.js';
import { calculateRelevance } from './relevance-scorer.js';
import { expandCompoundTags, expandQueryBigrams, expandQueryKoreanStems } from './solution-format.js';
import { shouldRejectByR4T3Rules } from './precision-guards.js';
import { defaultNormalizer } from './term-normalizer.js';

/**
 * Narrow input shape for the shared ranking pipeline. `matchSolutions` and the
 * bootstrap evaluator both reduce to this contract — `LoadedSolution` is
 * structurally compatible (it has more fields), and `EvalSolution` mirrors it
 * exactly. Keeping the input narrow prevents the evaluator from leaking onto
 * prod types and vice versa.
 */
export interface RankableSolution {
  name: string;
  tags: string[];
  identifiers?: string[];
  confidence: number;
}

/**
 * Intermediate ranked candidate. Generic over the source solution type so the
 * caller can get back the exact object they passed in.
 */
export interface RankedCandidate<T extends RankableSolution = RankableSolution> {
  solution: T;
  relevance: number;
  matchedTags: string[];
  matchedIdentifiers: string[];
}

/**
 * Shared ranking core: tag-based relevance + identifier boost + top-5 sort.
 *
 * Contract:
 *   - identifier boost requires `id.length >= 4` and substring presence in
 *     the prompt (case-insensitive).
 *   - candidates with zero matched tags AND zero matched identifiers are dropped.
 *   - top-5 by `relevance` descending.
 *   - duplicate names are NOT deduplicated.
 */
export function rankCandidates<T extends RankableSolution>(
  promptTags: string[],
  promptLower: string,
  solutions: readonly T[],
  ensembleWeights?: { tfidf: number; bm25: number; bigram: number },
): RankedCandidate<T>[] {
  // R4-T2: mask blocked tokens before expansion/normalization
  const maskedPromptTags = maskBlockedTokens(promptLower, promptTags);
  if (maskedPromptTags.length === 0) return [];

  // R4-T1: expand prompt tags with adjacent-token bigrams
  // R5(vec-probe): 한국어 활용형 어간 회복 — `검증해줘` 류 회화체 쿼리가
  // `검증` 계열 솔루션 태그에 도달하게 한다 (쿼리 사이드 전용, 인덱스 불변).
  const promptTagsWithBigrams = expandQueryKoreanStems(expandQueryBigrams(maskedPromptTags));
  const normalizedPromptTags = defaultNormalizer.normalizeTerms(promptTagsWithBigrams);

  return solutions
    .map((sol) => {
      const solTagsExpanded = expandCompoundTags(sol.tags);

      const result = calculateRelevance(maskedPromptTags, sol.tags, sol.confidence, {
        normalizedPromptTags,
        solutionTagsExpanded: solTagsExpanded,
        ensembleWeights,
      }) as { relevance: number; matchedTags: string[] };

      let identifierBoost = 0;
      const matchedIdentifiers: string[] = [];
      for (const id of sol.identifiers ?? []) {
        if (id.length >= 4 && promptLower.includes(id.toLowerCase())) {
          identifierBoost += 0.15;
          matchedIdentifiers.push(id);
        }
      }

      // R4-T3: orchestration-layer specificity guards
      let tagRelevance = result.relevance;
      let tagMatches = result.matchedTags;
      if (
        matchedIdentifiers.length === 0 &&
        tagMatches.length > 0 &&
        shouldRejectByR4T3Rules(maskedPromptTags, tagMatches)
      ) {
        tagRelevance = 0;
        tagMatches = [];
      }

      return {
        solution: sol,
        relevance: tagRelevance + identifierBoost,
        matchedTags: tagMatches,
        matchedIdentifiers,
      };
    })
    .filter((c) => c.matchedTags.length + c.matchedIdentifiers.length >= 1)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 5);
}
