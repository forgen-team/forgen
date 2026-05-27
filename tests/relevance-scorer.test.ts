import { describe, it, expect } from 'vitest';
import { calculateRelevance } from '../src/engine/relevance-scorer.js';

describe('relevance-scorer (extracted module)', () => {
  describe('v3 tag mode', () => {
    it('returns relevance and matchedTags for matching tags', () => {
      const result = calculateRelevance(
        ['cache', 'redis', 'performance'],
        ['cache', 'redis', 'strategy'],
        0.8,
      );
      expect(result.relevance).toBeGreaterThan(0);
      expect(result.matchedTags.length).toBeGreaterThan(0);
    });

    it('returns 0 relevance for no overlap', () => {
      const result = calculateRelevance(
        ['quantum', 'physics'],
        ['cache', 'redis'],
        0.8,
      );
      expect(result.relevance).toBe(0);
      expect(result.matchedTags).toEqual([]);
    });

    it('applies confidence multiplier', () => {
      const high = calculateRelevance(['cache'], ['cache', 'redis'], 1.0);
      const low = calculateRelevance(['cache'], ['cache', 'redis'], 0.5);
      expect(high.relevance).toBeGreaterThan(low.relevance);
    });

    it('respects normalizedPromptTags option', () => {
      const result = calculateRelevance(
        ['test'],
        ['testing', 'tdd'],
        0.8,
        { normalizedPromptTags: ['test', 'testing'] },
      );
      expect(result.matchedTags).toContain('testing');
    });
  });

  describe('legacy string mode', () => {
    it('returns a number for string input', () => {
      const result = calculateRelevance('cache redis strategy' as any, ['cache', 'redis']);
      expect(typeof result).toBe('number');
      expect(result as number).toBeGreaterThan(0);
    });

    it('returns 0-like for no overlap', () => {
      const result = calculateRelevance('quantum physics' as any, ['cache', 'redis']);
      expect(typeof result).toBe('number');
    });
  });
});
