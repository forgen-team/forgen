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
import { tagWeight } from './scoring-algorithms.js';
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
  /** 맥락 토큰(cwd/최근 편집 파일)으로만 겹친 태그. matchedTags 와 분리 — 순위 가산(태그당 0.1, 상한 0.2)에만 쓰고 게이트엔 안 씀. */
  contextMatchedTags: string[];
  /** relevance 에 포함된 맥락 가산분. 주입 게이트는 relevance − contextBonus 로 비교한다(critic v0.6.6 SEV-2). */
  contextBonus: number;
}

/** 맥락 태그 1개당 relevance 가산(프롬프트 태그 1개 ≈ 0.2 의 절반). */
export const CONTEXT_TAG_BONUS = 0.1;
/** 맥락 가산 총상한 — 맥락이 점수를 지배하지 못하게. */
export const CONTEXT_BONUS_CAP = 0.2;

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
  contextTokens: readonly string[] = [],
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

      // 맥락 신호: 프롬프트로 이미 1개 이상 매칭된 후보에만 적용(맥락 단독 후보 생성 금지).
      // 프롬프트 매칭 태그와 겹치는 맥락 토큰은 중복 가산하지 않는다.
      const contextMatchedTags: string[] = [];
      let contextBonus = 0;
      if (contextTokens.length > 0 && tagMatches.length + matchedIdentifiers.length >= 1) {
        const ctx = new Set(contextTokens);
        const already = new Set([...tagMatches, ...maskedPromptTags]);
        for (const t of solTagsExpanded) {
          if (ctx.has(t) && !already.has(t) && !contextMatchedTags.includes(t)) {
            contextMatchedTags.push(t);
            contextBonus += CONTEXT_TAG_BONUS * tagWeight(t);
          }
        }
        contextBonus = Math.min(contextBonus, CONTEXT_BONUS_CAP);
      }

      return {
        solution: sol,
        relevance: tagRelevance + identifierBoost + contextBonus,
        matchedTags: tagMatches,
        matchedIdentifiers,
        contextMatchedTags,
        contextBonus,
      };
    })
    .filter((c) => c.matchedTags.length + c.matchedIdentifiers.length >= 1)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 5);
}
