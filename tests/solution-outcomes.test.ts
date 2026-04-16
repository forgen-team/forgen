import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-outcomes-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const {
  appendPending,
  flushAccept,
  attributeCorrection,
  attributeError,
  finalizeSession,
  readAllOutcomes,
} = await import('../src/engine/solution-outcomes.js');

describe('solution-outcomes', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  describe('appendPending + flushAccept', () => {
    it('flushes pending as accept when next prompt arrives', () => {
      appendPending('sess-a', [
        { solution: 'sol-x', match_score: 0.8, injected_chars: 100 },
        { solution: 'sol-y', match_score: 0.5, injected_chars: 80 },
      ]);
      const flushed = flushAccept('sess-a');
      expect(flushed).toBe(2);
      const outcomes = readAllOutcomes();
      expect(outcomes.length).toBe(2);
      expect(outcomes.every((o) => o.outcome === 'accept')).toBe(true);
      expect(outcomes.every((o) => o.attribution === 'default')).toBe(true);
    });

    it('no-op when pending is empty', () => {
      expect(flushAccept('sess-empty')).toBe(0);
      expect(readAllOutcomes()).toEqual([]);
    });

    it('accumulates across multiple appendPending calls before flush', () => {
      appendPending('sess-a', [{ solution: 'a', match_score: 0.9, injected_chars: 50 }]);
      appendPending('sess-a', [{ solution: 'b', match_score: 0.7, injected_chars: 70 }]);
      expect(flushAccept('sess-a')).toBe(2);
    });

    it('isolates sessions — one session flush does not affect another', () => {
      appendPending('sess-a', [{ solution: 'a', match_score: 0.9, injected_chars: 50 }]);
      appendPending('sess-b', [{ solution: 'b', match_score: 0.7, injected_chars: 70 }]);
      expect(flushAccept('sess-a')).toBe(1);
      const outcomes = readAllOutcomes();
      expect(outcomes.length).toBe(1);
      expect(outcomes[0].session_id).toBe('sess-a');
    });
  });

  describe('attributeCorrection', () => {
    it('marks all pending solutions as correct and clears pending', () => {
      appendPending('sess-a', [
        { solution: 'sol-x', match_score: 0.8, injected_chars: 100 },
        { solution: 'sol-y', match_score: 0.5, injected_chars: 80 },
      ]);
      const attributed = attributeCorrection('sess-a');
      expect(attributed).toEqual(['sol-x', 'sol-y']);
      const outcomes = readAllOutcomes();
      expect(outcomes.length).toBe(2);
      expect(outcomes.every((o) => o.outcome === 'correct')).toBe(true);
      expect(outcomes.every((o) => o.attribution === 'explicit')).toBe(true);
      // Subsequent flushAccept must be no-op (pending was cleared)
      expect(flushAccept('sess-a')).toBe(0);
    });
  });

  describe('attributeError', () => {
    it('marks pending as error but keeps them pending', () => {
      appendPending('sess-a', [{ solution: 'sol-x', match_score: 0.8, injected_chars: 100 }]);
      attributeError('sess-a');
      const afterError = readAllOutcomes();
      expect(afterError.length).toBe(1);
      expect(afterError[0].outcome).toBe('error');
      // flushAccept can still fire — error does not clear pending
      const flushed = flushAccept('sess-a');
      expect(flushed).toBe(1);
    });

    it('dedupes repeated error calls for the same pending batch', () => {
      appendPending('sess-a', [{ solution: 'sol-x', match_score: 0.8, injected_chars: 100 }]);
      attributeError('sess-a');
      attributeError('sess-a');
      attributeError('sess-a');
      const outcomes = readAllOutcomes();
      const errors = outcomes.filter((o) => o.outcome === 'error');
      expect(errors.length).toBe(1);
    });
  });

  describe('finalizeSession', () => {
    it('logs still-pending as unknown and removes pending file', () => {
      appendPending('sess-a', [{ solution: 'sol-x', match_score: 0.8, injected_chars: 100 }]);
      expect(finalizeSession('sess-a')).toBe(1);
      const outcomes = readAllOutcomes();
      expect(outcomes.length).toBe(1);
      expect(outcomes[0].outcome).toBe('unknown');
      expect(outcomes[0].attribution).toBe('session_end');
    });

    it('returns 0 when nothing pending', () => {
      expect(finalizeSession('never-existed')).toBe(0);
    });
  });

  describe('readAllOutcomes', () => {
    it('returns events sorted by ts ascending across sessions', () => {
      appendPending('sess-a', [{ solution: 'a', match_score: 0.9, injected_chars: 50 }]);
      flushAccept('sess-a');
      appendPending('sess-b', [{ solution: 'b', match_score: 0.7, injected_chars: 70 }]);
      flushAccept('sess-b');
      const outcomes = readAllOutcomes();
      expect(outcomes.length).toBe(2);
      expect(outcomes[0].ts).toBeLessThanOrEqual(outcomes[1].ts);
    });

    it('returns [] when outcomes dir does not exist', () => {
      expect(readAllOutcomes()).toEqual([]);
    });
  });

  describe('integration scenarios', () => {
    it('scenario: inject → correct removes from pending, next inject not double-counted', () => {
      appendPending('sess-a', [{ solution: 'x', match_score: 0.8, injected_chars: 100 }]);
      attributeCorrection('sess-a'); // clears pending
      appendPending('sess-a', [{ solution: 'y', match_score: 0.7, injected_chars: 80 }]);
      flushAccept('sess-a');
      const outcomes = readAllOutcomes();
      expect(outcomes.filter((o) => o.solution === 'x' && o.outcome === 'correct').length).toBe(1);
      expect(outcomes.filter((o) => o.solution === 'y' && o.outcome === 'accept').length).toBe(1);
      expect(outcomes.filter((o) => o.solution === 'x' && o.outcome === 'accept').length).toBe(0);
    });

    it('scenario: inject → error → next prompt still yields accept (error is weak signal)', () => {
      appendPending('sess-a', [{ solution: 'x', match_score: 0.8, injected_chars: 100 }]);
      attributeError('sess-a');
      flushAccept('sess-a');
      const outcomes = readAllOutcomes();
      expect(outcomes.length).toBe(2);
      expect(outcomes.map((o) => o.outcome).sort()).toEqual(['accept', 'error']);
    });
  });
});
