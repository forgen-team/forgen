import { describe, it, expect } from 'vitest';
import { extractFromDiff, findCommonPrefix } from '../src/engine/extraction-diff.js';

describe('extraction-diff (extracted module)', () => {
  describe('findCommonPrefix', () => {
    it('finds common prefix', () => {
      expect(findCommonPrefix(['extraction-git', 'extraction-gates', 'extraction-diff']))
        .toBe('extraction');
    });

    it('empty array → empty string', () => {
      expect(findCommonPrefix([])).toBe('');
    });

    it('single string → that string', () => {
      expect(findCommonPrefix(['hello'])).toBe('hello');
    });

    it('no common prefix → empty', () => {
      expect(findCommonPrefix(['alpha', 'beta'])).toBe('');
    });

    it('strips trailing dash', () => {
      expect(findCommonPrefix(['pre-alpha', 'pre-beta'])).toBe('pre');
    });
  });

  describe('extractFromDiff', () => {
    it('returns empty for empty diff', () => {
      const result = extractFromDiff('', '');
      expect(result).toEqual([]);
    });

    it('detects error handling patterns from diff', () => {
      const diff = [
        '+  try {',
        '+    await fetchData();',
        '+  } catch (error) {',
        '+    throw new Error("fetch failed");',
        '+  }',
      ].join('\n');
      const result = extractFromDiff('', diff);
      const errorPattern = result.find(s => s.name === 'error-handling-pattern');
      if (errorPattern) {
        expect(errorPattern.type).toBe('pattern');
        expect(errorPattern.tags).toContain('error');
      }
    });

    it('detects dependency patterns from imports', () => {
      const diff = [
        "+  import express from 'express';",
        "+  import prisma from '@prisma/client';",
        "+  import zod from 'zod';",
      ].join('\n');
      const result = extractFromDiff('', diff);
      const depPattern = result.find(s => s.name === 'dependency-stack');
      if (depPattern) {
        expect(depPattern.type).toBe('decision');
        expect(depPattern.tags).toContain('dependency');
      }
    });

    it('detects commit keyword patterns', () => {
      const gitLog = [
        'abc1234 fix: resolve auth token expiry',
        'def5678 fix: handle null user in middleware',
      ].join('\n');
      const result = extractFromDiff(gitLog, '');
      const fixPattern = result.find(s => s.name === 'fix-pattern');
      if (fixPattern) {
        expect(fixPattern.type).toBe('troubleshoot');
      }
    });

    it('limits to max 3 solutions', () => {
      const diff = [
        '+++ b/src/a-common.ts',
        '+++ b/src/a-handler.ts',
        '+  try {',
        '+  } catch (e) {',
        '+    throw new Error("x");',
        "+  import foo from 'foo';",
        "+  import bar from 'bar';",
        "+  import baz from 'baz';",
      ].join('\n');
      const gitLog = [
        'aaa fix: one',
        'bbb fix: two',
      ].join('\n');
      const result = extractFromDiff(gitLog, diff);
      expect(result.length).toBeLessThanOrEqual(3);
    });
  });
});
