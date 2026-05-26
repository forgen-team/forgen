/**
 * Query-side specificity guards for the solution matcher (R4-T3).
 *
 * Extracted from solution-matcher.ts — orchestration-layer precision rules
 * applied AFTER calculateRelevance returns. These fix false positives from
 * ambiguous single-tag matches without regressing legitimate results.
 *
 * Rule A: single-token query AND single-tag match → reject.
 * Rule B: all matched tags came via synonym expansion (none literal in prompt)
 *         AND match is single-tag → reject.
 *
 * Returns true = reject the candidate, false = keep it.
 */

export function shouldRejectByR4T3Rules(
  promptTags: readonly string[],
  matchedTags: readonly string[],
): boolean {
  // Rule A
  if (promptTags.length === 1 && matchedTags.length === 1) {
    return true;
  }
  // Rule B
  if (matchedTags.length === 1) {
    const tag = matchedTags[0];
    const literalHit =
      promptTags.includes(tag) ||
      promptTags.some((pt) => {
        if (pt.length <= 3 || tag.length <= 3) return false;
        if (pt.includes(tag) || tag.includes(pt)) return true;
        // Morphological stem: shared prefix of length ≥ 4
        let i = 0;
        const limit = Math.min(pt.length, tag.length);
        while (i < limit && pt[i] === tag[i]) i++;
        return i >= 4;
      });
    if (!literalHit) return true;
  }
  return false;
}
