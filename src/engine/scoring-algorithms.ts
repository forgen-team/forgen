/**
 * Stateless scoring primitives for the solution matcher.
 *
 * Extracted from solution-matcher.ts — these are pure functions with no
 * filesystem or module-level state dependencies.
 */

/** High-frequency tags that should be weighted lower */
export const COMMON_TAGS = new Set([
  'typescript',
  'ts',
  'javascript',
  'js',
  'fix',
  'update',
  'add',
  'change',
  'file',
  'code',
  'function',
  'import',
  'export',
  'error',
  'type',
  'string',
  'number',
  'object',
  'array',
  'return',
  'const',
  'class',
  'module',
  '코드',
  '파일',
  '함수',
  '수정',
  '추가',
  '변경',
  '에러',
  '타입',
]);

/** Apply IDF-like weight: common tags get reduced weight */
export function tagWeight(tag: string): number {
  return COMMON_TAGS.has(tag) ? 0.5 : 1.0;
}

/**
 * Compute the Dice coefficient between two strings using character bigrams.
 *
 * Dice = 2 * |intersection| / (|A| + |B|)
 *
 * Both strings are lowercased and whitespace-stripped before bigram generation.
 * Returns 0 for empty strings or single-character strings (no bigrams possible).
 * Returns 1.0 for identical non-trivial strings.
 *
 * This is used as a lightweight fuzzy matching signal for borderline cases
 * where the TF-IDF tag intersection produces a low score but the query and
 * solution tags are character-similar (e.g., "database" vs "데이터베이스"
 * won't match, but "database" vs "databse" will get a high score).
 */
export function bigramSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/\s+/g, '');
  const nb = b.toLowerCase().replace(/\s+/g, '');

  if (na.length < 2 || nb.length < 2) return 0;
  if (na === nb) return 1.0;

  const bigramsA = new Map<string, number>();
  for (let i = 0; i < na.length - 1; i++) {
    const bg = na.slice(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) ?? 0) + 1);
  }

  const bigramsB = new Map<string, number>();
  for (let i = 0; i < nb.length - 1; i++) {
    const bg = nb.slice(i, i + 2);
    bigramsB.set(bg, (bigramsB.get(bg) ?? 0) + 1);
  }

  let intersectionSize = 0;
  for (const [bg, countA] of bigramsA) {
    const countB = bigramsB.get(bg) ?? 0;
    intersectionSize += Math.min(countA, countB);
  }

  const totalA = na.length - 1;
  const totalB = nb.length - 1;
  return (2 * intersectionSize) / (totalA + totalB);
}

/**
 * Simplified BM25 score for a single query-document pair.
 * Uses tag overlap with term frequency normalization.
 * k1=1.2, b=0.75 (standard BM25 parameters).
 */
export function bm25Score(queryTags: string[], docTags: string[], avgDocLength: number): number {
  const k1 = 1.2;
  const b = 0.75;
  const docLen = docTags.length;
  if (docLen === 0 || queryTags.length === 0 || avgDocLength === 0) return 0;

  let score = 0;
  for (const qt of queryTags) {
    // Term frequency in document
    const tf = docTags.filter(
      (dt) => dt === qt || (dt.length > 3 && qt.length > 3 && (dt.includes(qt) || qt.includes(dt))),
    ).length;
    if (tf === 0) continue;
    // BM25 TF saturation
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * (docLen / avgDocLength));
    score += numerator / denominator;
  }
  // Normalize by query length
  return score / queryTags.length;
}
