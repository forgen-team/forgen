/**
 * Solution matcher — thin facade re-exporting from decomposed modules.
 *
 * All public exports are preserved for backward compatibility. Internal
 * callers that import from './solution-matcher.js' continue to work.
 *
 * Module layout (post-decomposition):
 *   scoring-algorithms.ts  — bigramSimilarity, bm25Score, tagWeight, COMMON_TAGS
 *   relevance-scorer.ts    — calculateRelevance, CalculateRelevanceOptions
 *   precision-guards.ts    — shouldRejectByR4T3Rules
 *   ranking-pipeline.ts    — rankCandidates, RankableSolution, RankedCandidate
 *   solution-matcher-eval.ts — EvalSolution/Query/Fixture/Result, ROUND3_BASELINE, evaluateQuery, evaluateSolutionMatcher
 *   meta-learning/matcher-weight-loader.ts — loadTunedMatcherWeights
 */

import * as path from 'node:path';
import { ME_SOLUTIONS, PACKS_DIR } from '../core/paths.js';
import type { ScopeInfo } from '../core/types.js';
import type { SolutionStatus, SolutionType } from './solution-format.js';
import { extractTags } from './solution-format.js';
import type { SolutionDirConfig } from './solution-index.js';
import { getOrBuildIndex } from './solution-index.js';
import { defaultNormalizer } from './term-normalizer.js';
import { rankCandidates } from './ranking-pipeline.js';
import { loadTunedMatcherWeights } from './meta-learning/matcher-weight-loader.js';

// ── Re-exports (backward compatibility) ──

export { bigramSimilarity, bm25Score, COMMON_TAGS, tagWeight } from './scoring-algorithms.js';
export { calculateRelevance } from './relevance-scorer.js';
export type { CalculateRelevanceOptions } from './relevance-scorer.js';
export { shouldRejectByR4T3Rules } from './precision-guards.js';
export {
  ROUND3_BASELINE,
  BASELINE_TOLERANCE,
  evaluateQuery,
  evaluateSolutionMatcher,
} from './solution-matcher-eval.js';
export type {
  EvalSolution,
  EvalQuery,
  EvalFixture,
  BucketMetrics,
  EvalResult,
} from './solution-matcher-eval.js';

// ── Deprecated wrapper (kept for synonym-tfidf.test.ts) ──

/**
 * @deprecated Use `defaultNormalizer.normalizeTerms` from
 * `./term-normalizer.js` directly.
 */
export function expandTagsWithSynonyms(tags: string[]): string[] {
  return defaultNormalizer.normalizeTerms(tags);
}

// ── Types ──

export interface SolutionMatch {
  name: string;
  path: string;
  scope: 'me' | 'team' | 'project' | 'universal';
  relevance: number;
  summary: string;
  status: SolutionStatus;
  confidence: number;
  type: SolutionType;
  tags: string[];
  identifiers: string[];
  matchedTags: string[];
  matchedIdentifiers: string[];
}

/** Internal loaded solution with scope from directory config */
interface LoadedSolution {
  name: string;
  status: SolutionStatus;
  confidence: number;
  type: SolutionType;
  tags: string[];
  identifiers: string[];
  filePath: string;
  scope: 'me' | 'team' | 'project' | 'universal';
}

// ── Candidate exploration bonus ──

const CANDIDATE_EXPLORATION_MULTIPLIER = 1.3;

function applyCandidateExplorationBonus(entries: LoadedSolution[]): LoadedSolution[] {
  return entries.map((e) => {
    if (e.status !== 'candidate') return e;
    return { ...e, confidence: Math.min(1, e.confidence * CANDIDATE_EXPLORATION_MULTIPLIER) };
  });
}

// ── Public API ──

export function matchSolutions(prompt: string, scope: ScopeInfo, cwd: string): SolutionMatch[] {
  const dirs: SolutionDirConfig[] = [{ dir: ME_SOLUTIONS, scope: 'me' }];
  if (scope.team) {
    dirs.push({ dir: path.join(PACKS_DIR, scope.team.name, 'solutions'), scope: 'team' });
  }
  dirs.push({ dir: path.join(cwd, '.compound', 'solutions'), scope: 'project' });

  const index = getOrBuildIndex(dirs);
  const allSolutions: LoadedSolution[] = applyCandidateExplorationBonus(
    index.entries.map((e) => ({ ...e })),
  );

  const promptTags = extractTags(prompt);
  const promptLower = prompt.toLowerCase();

  const tunedWeights = loadTunedMatcherWeights();

  const ranked = rankCandidates(promptTags, promptLower, allSolutions, tunedWeights);

  return ranked.map((c) => ({
    name: c.solution.name,
    path: c.solution.filePath,
    scope: c.solution.scope,
    relevance: c.relevance,
    summary: c.solution.name,
    status: c.solution.status,
    confidence: c.solution.confidence,
    type: c.solution.type,
    tags: c.solution.tags,
    identifiers: c.solution.identifiers,
    matchedTags: [...c.matchedTags, ...c.matchedIdentifiers],
    matchedIdentifiers: c.matchedIdentifiers,
  }));
}
