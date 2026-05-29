import { describe, it, expect } from 'vitest';
import { bigramSimilarity, bm25Score, tagWeight, COMMON_TAGS } from '../src/engine/scoring-algorithms.js';

describe('scoring-algorithms (extracted module)', () => {
  describe('bigramSimilarity', () => {
    it('identical strings → 1.0', () => {
      expect(bigramSimilarity('database', 'database')).toBe(1.0);
    });

    it('empty or single-char → 0', () => {
      expect(bigramSimilarity('', 'abc')).toBe(0);
      expect(bigramSimilarity('a', 'ab')).toBe(0);
    });

    it('similar strings → high score', () => {
      expect(bigramSimilarity('database', 'databse')).toBeGreaterThan(0.7);
    });

    it('unrelated strings → low score', () => {
      expect(bigramSimilarity('database', 'elephant')).toBeLessThan(0.3);
    });

    it('case insensitive', () => {
      expect(bigramSimilarity('Database', 'database')).toBe(1.0);
    });
  });

  describe('bm25Score', () => {
    it('empty inputs → 0', () => {
      expect(bm25Score([], ['tag'], 6)).toBe(0);
      expect(bm25Score(['tag'], [], 6)).toBe(0);
      expect(bm25Score(['tag'], ['tag'], 0)).toBe(0);
    });

    it('exact match → positive score', () => {
      expect(bm25Score(['cache'], ['cache', 'redis'], 6)).toBeGreaterThan(0);
    });

    it('no overlap → 0', () => {
      expect(bm25Score(['alpha'], ['beta', 'gamma'], 6)).toBe(0);
    });

    it('partial substring match for long tags', () => {
      // bm25 uses includes() — 'cache' includes 'cach' but 'cache' does NOT include 'caching'
      // 'performance' includes 'perform' (substring match)
      expect(bm25Score(['perform'], ['performance', 'redis'], 6)).toBeGreaterThan(0);
    });
  });

  describe('tagWeight', () => {
    it('common tags → 0.5', () => {
      expect(tagWeight('typescript')).toBe(0.5);
      expect(tagWeight('error')).toBe(0.5);
      expect(tagWeight('코드')).toBe(0.5);
    });

    it('non-common tags → 1.0', () => {
      expect(tagWeight('caching')).toBe(1.0);
      expect(tagWeight('authentication')).toBe(1.0);
    });
  });

  describe('COMMON_TAGS', () => {
    it('contains expected high-frequency tags', () => {
      expect(COMMON_TAGS.has('typescript')).toBe(true);
      expect(COMMON_TAGS.has('js')).toBe(true);
      expect(COMMON_TAGS.has('에러')).toBe(true);
    });

    it('does not contain domain-specific tags', () => {
      expect(COMMON_TAGS.has('caching')).toBe(false);
      expect(COMMON_TAGS.has('authentication')).toBe(false);
    });
  });
});
