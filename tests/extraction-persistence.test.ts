import { describe, it, expect } from 'vitest';
import { loadLastExtraction, saveLastExtraction } from '../src/engine/extraction-persistence.js';
import type { LastExtraction } from '../src/engine/extraction-persistence.js';

describe('extraction-persistence (extracted module)', () => {
  describe('loadLastExtraction', () => {
    it('returns default state when no file exists', () => {
      const result = loadLastExtraction();
      expect(result).toHaveProperty('lastCommitSha');
      expect(result).toHaveProperty('lastExtractedAt');
      expect(result).toHaveProperty('extractionsToday');
      expect(result).toHaveProperty('todayDate');
      expect(typeof result.extractionsToday).toBe('number');
    });

    it('returns consistent shape on repeated calls', () => {
      const r1 = loadLastExtraction();
      const r2 = loadLastExtraction();
      expect(Object.keys(r1).sort()).toEqual(Object.keys(r2).sort());
    });
  });

  describe('saveLastExtraction', () => {
    it('does not throw when saving valid state', () => {
      const state: LastExtraction = {
        lastCommitSha: 'abc1234',
        lastExtractedAt: new Date().toISOString(),
        extractionsToday: 1,
        todayDate: '2026-05-27',
      };
      expect(() => saveLastExtraction(state)).not.toThrow();
    });

    it('roundtrips: save then load returns same data', () => {
      const state: LastExtraction = {
        lastCommitSha: 'def5678',
        lastExtractedAt: '2026-05-27T10:00:00Z',
        extractionsToday: 3,
        todayDate: '2026-05-27',
      };
      saveLastExtraction(state);
      const loaded = loadLastExtraction();
      expect(loaded.lastCommitSha).toBe('def5678');
      expect(loaded.extractionsToday).toBe(3);
    });
  });
});
