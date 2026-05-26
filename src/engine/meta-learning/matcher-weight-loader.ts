/**
 * Dynamic ensemble weight loader for the solution matcher.
 *
 * Extracted from solution-matcher.ts — loads tuned weights from meta-learning
 * state with a 1-minute in-process TTL cache.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { META_LEARNING_DIR } from '../../core/paths.js';

let _cachedWeights: { tfidf: number; bm25: number; bigram: number } | undefined | null;
let _weightsCacheTime = 0;
const WEIGHTS_CACHE_TTL = 60_000; // 1 minute cache

/**
 * Load tuned matcher weights from meta-learning state.
 * Returns undefined (use defaults) if no tuned weights exist.
 * Cached for 1 minute to avoid re-reading per matchSolutions call.
 */
export function loadTunedMatcherWeights(): { tfidf: number; bm25: number; bigram: number } | undefined {
  const now = Date.now();
  if (_cachedWeights !== undefined && now - _weightsCacheTime < WEIGHTS_CACHE_TTL) {
    return _cachedWeights ?? undefined;
  }
  try {
    const weightsPath = path.join(META_LEARNING_DIR, 'matcher-weights.json');
    if (!fs.existsSync(weightsPath)) {
      _cachedWeights = null;
      _weightsCacheTime = now;
      return undefined;
    }
    const data = JSON.parse(fs.readFileSync(weightsPath, 'utf-8')) as {
      tfidf?: number;
      bm25?: number;
      bigram?: number;
    };
    if (
      typeof data.tfidf === 'number' &&
      typeof data.bm25 === 'number' &&
      typeof data.bigram === 'number'
    ) {
      _cachedWeights = { tfidf: data.tfidf, bm25: data.bm25, bigram: data.bigram };
      _weightsCacheTime = now;
      return _cachedWeights;
    }
  } catch {
    /* fail-open: use defaults */
  }
  _cachedWeights = null;
  _weightsCacheTime = now;
  return undefined;
}
