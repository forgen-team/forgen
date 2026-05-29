import { describe, it, expect } from 'vitest';
import { shouldRejectByR4T3Rules } from '../src/engine/precision-guards.js';

describe('precision-guards (extracted module)', () => {
  describe('Rule A: single-token query + single-tag match', () => {
    it('rejects single-token + single-tag', () => {
      expect(shouldRejectByR4T3Rules(['validation'], ['validation'])).toBe(true);
    });

    it('allows multi-token + single-tag', () => {
      expect(shouldRejectByR4T3Rules(['error', 'handling'], ['handling'])).toBe(false);
    });
  });

  describe('Rule B: expansion-only single-tag match', () => {
    it('rejects when matched tag has no literal hit in prompt', () => {
      expect(shouldRejectByR4T3Rules(['recovery', 'procedure'], ['handling'])).toBe(true);
    });

    it('allows when matched tag has literal hit', () => {
      expect(shouldRejectByR4T3Rules(['cache', 'strategy'], ['cache'])).toBe(false);
    });

    it('allows morphological stem match (shared prefix >= 4)', () => {
      expect(shouldRejectByR4T3Rules(['caching', 'strategy'], ['cache'])).toBe(false);
    });

    it('allows substring match for long tags', () => {
      expect(shouldRejectByR4T3Rules(['code', 'review'], ['code-review'])).toBe(false);
    });
  });

  describe('multi-tag matches always pass', () => {
    it('two matched tags → no rejection', () => {
      expect(shouldRejectByR4T3Rules(['alpha'], ['beta', 'gamma'])).toBe(false);
    });
  });

  describe('empty inputs', () => {
    it('empty matchedTags → no rejection', () => {
      expect(shouldRejectByR4T3Rules(['query'], [])).toBe(false);
    });
  });
});
