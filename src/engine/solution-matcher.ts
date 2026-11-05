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

import { projectKeyFor } from '../store/rule-scope.js';
import { solutionInScope, solutionProjectWeight } from './solution-scope.js';
import type { ScopeInfo } from '../core/types.js';
import type { SolutionStatus, SolutionType } from './solution-format.js';
import { extractSolutionTags } from './solution-format.js';
import type { SolutionDirConfig } from './solution-index.js';
import { getOrBuildIndex, defaultSolutionDirs } from './solution-index.js';
import { defaultNormalizer } from './term-normalizer.js';
import { rankCandidates } from './ranking-pipeline.js';
import { loadTunedMatcherWeights } from './meta-learning/matcher-weight-loader.js';
import { applyRoiDemotions, loadRoiDemotions } from './roi-demotion.js';

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
  /** 맥락 토큰(cwd/최근 편집 파일)으로만 겹친 태그 — 순위 가산에만, 게이트·단독 주입 불가. */
  contextMatchedTags?: string[];
  /** relevance 에 포함된 맥락 가산분 (게이트 비교에서 제외). */
  contextBonus?: number;
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
  projects?: string[];
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

export function matchSolutions(
  prompt: string,
  scope: ScopeInfo,
  cwd: string,
  contextTokens: readonly string[] = [],
): SolutionMatch[] {
  // hook 과 MCP 가 같은 디렉터리 목록(me + 설치된 팩 + cwd project)을 쓴다.
  const dirs: SolutionDirConfig[] = defaultSolutionDirs(cwd);
  void scope;
  const projectKey = projectKeyFor(cwd);

  const index = getOrBuildIndex(dirs);
  const allSolutions: LoadedSolution[] = applyCandidateExplorationBonus(
    index.entries.filter((e) => solutionInScope(e.projects, projectKey)).map((e) => ({ ...e })),
  );

  // 맨 앞 슬래시 명령 이름(`/plugin install x`)은 호출이지 주제가 아니다 — 이름이 주제 태그로 매치되어
  // 명령어 프롬프트에 무관한 솔루션이 붙던 것을 막는다(실측: /plugin 프롬프트가 plugin 솔루션 2건 오주입).
  const topicText = prompt.replace(/^\s*\/[A-Za-z][\w:.-]*/, ' ');
  const promptTags = extractSolutionTags(topicText);
  const promptLower = topicText.toLowerCase();

  const tunedWeights = loadTunedMatcherWeights();

  const ranked = rankCandidates(promptTags, promptLower, allSolutions, tunedWeights, contextTokens);

  // ADR-010 W3-1 (F2): 저 ROI 강등 — ranking-pipeline 은 순수 유지, 여기서
  // 후처리. surfaced≫acted_on 솔루션은 ×0.5, 2윈도 연속이면 주입 제외.
  const matches = ranked.map((c) => ({
    name: c.solution.name,
    path: c.solution.filePath,
    scope: c.solution.scope,
    relevance: c.relevance * solutionProjectWeight(c.solution.projects, projectKey),
    summary: c.solution.name,
    status: c.solution.status,
    confidence: c.solution.confidence,
    type: c.solution.type,
    tags: c.solution.tags,
    identifiers: c.solution.identifiers,
    matchedTags: [...c.matchedTags, ...c.matchedIdentifiers],
    matchedIdentifiers: c.matchedIdentifiers,
    contextMatchedTags: c.contextMatchedTags,
    contextBonus: c.contextBonus,
  }));

  try {
    return applyRoiDemotions(matches, loadRoiDemotions());
  } catch {
    return matches; // fail-open — 강등 실패가 주입을 막지 않는다
  }
}
