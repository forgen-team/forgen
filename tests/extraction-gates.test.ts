import { describe, it, expect } from 'vitest';
import { gate0, gate1, gate2, gateTrivial, evaluateExtractedSolution } from '../src/engine/extraction-gates.js';
import type { ExtractedSolution } from '../src/engine/extraction-gates.js';

describe('extraction-gates (extracted module)', () => {
  const validSolution: ExtractedSolution = {
    name: 'error-handling-pattern',
    type: 'pattern',
    tags: ['error', 'handling', 'try-catch'],
    identifiers: ['handleError', 'ErrorBoundary'],
    context: 'Error handling approach used in this codebase',
    content: 'Consistent error handling with try-catch blocks and custom error classes. Always log error context before rethrowing.',
  };

  describe('gate0 — worth extracting', () => {
    it('rejects zero files', () => {
      expect(gate0({ files: 0, lines: 100, hasCodeFiles: true })).toBe(false);
    });

    it('rejects too few lines', () => {
      expect(gate0({ files: 5, lines: 10, hasCodeFiles: true })).toBe(false);
    });

    it('rejects no code files', () => {
      expect(gate0({ files: 5, lines: 100, hasCodeFiles: false })).toBe(false);
    });

    it('accepts valid stats', () => {
      expect(gate0({ files: 3, lines: 50, hasCodeFiles: true })).toBe(true);
    });
  });

  describe('gate1 — structural validation', () => {
    it('rejects missing name', () => {
      expect(gate1({ ...validSolution, name: '' })).toBe(false);
    });

    it('rejects short name', () => {
      expect(gate1({ ...validSolution, name: 'ab' })).toBe(false);
    });

    it('rejects empty tags', () => {
      expect(gate1({ ...validSolution, tags: [] })).toBe(false);
    });

    it('rejects short content', () => {
      expect(gate1({ ...validSolution, content: 'too short' })).toBe(false);
    });

    it('rejects empty context', () => {
      expect(gate1({ ...validSolution, context: '' })).toBe(false);
    });

    it('accepts valid solution', () => {
      expect(gate1(validSolution)).toBe(true);
    });
  });

  describe('gate2 — toxicity filter', () => {
    it('rejects @ts-ignore', () => {
      expect(gate2({ ...validSolution, content: 'Use @ts-ignore to bypass type checking' })).toBe(false);
    });

    it('rejects --force', () => {
      expect(gate2({ ...validSolution, context: 'Run git push --force' })).toBe(false);
    });

    it('accepts clean content', () => {
      expect(gate2(validSolution)).toBe(true);
    });
  });

  describe('gateTrivial — trivial pattern rejection', () => {
    it('rejects very short content', () => {
      expect(gateTrivial({ ...validSolution, content: 'Short content here.' })).toBe(false);
    });

    it('rejects "주로" patterns', () => {
      expect(gateTrivial({ ...validSolution, content: '주로 TypeScript를 사용합니다.' })).toBe(false);
    });

    it('rejects no identifiers + few tags', () => {
      expect(gateTrivial({ ...validSolution, identifiers: [], tags: ['a', 'b'] })).toBe(false);
    });

    it('accepts valid solution', () => {
      expect(gateTrivial(validSolution)).toBe(true);
    });
  });

  describe('evaluateExtractedSolution — combined gate evaluation', () => {
    it('accepts valid solution', () => {
      const result = evaluateExtractedSolution(validSolution);
      expect(result.action).toBe('accept');
    });

    it('returns skip for structural failure', () => {
      const result = evaluateExtractedSolution({ ...validSolution, name: '' });
      expect(result.action).toBe('skip');
      expect(result.message).toContain('Gate 1');
    });

    it('returns skip for toxicity', () => {
      const result = evaluateExtractedSolution({
        ...validSolution,
        content: 'Use @ts-ignore to suppress the error and move on with the implementation quickly.',
      });
      expect(result.action).toBe('skip');
      expect(result.message).toContain('Gate 2');
    });
  });
});
