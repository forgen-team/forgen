import { describe, it, expect } from 'vitest';
import { isValidSha, getNewCommits, getDiffStats } from '../src/engine/extraction-git.js';

describe('extraction-git (extracted module)', () => {
  describe('isValidSha', () => {
    it('accepts 7-char short sha', () => {
      expect(isValidSha('abc1234')).toBe(true);
    });

    it('accepts 40-char full sha', () => {
      expect(isValidSha('a'.repeat(40))).toBe(true);
    });

    it('rejects too short', () => {
      expect(isValidSha('abc')).toBe(false);
    });

    it('rejects non-hex', () => {
      expect(isValidSha('xyz1234')).toBe(false);
    });

    it('rejects empty', () => {
      expect(isValidSha('')).toBe(false);
    });
  });

  describe('getNewCommits', () => {
    it('returns commits for current repo', () => {
      const result = getNewCommits(process.cwd(), '');
      expect(typeof result).toBe('string');
    });

    it('returns empty for invalid cwd', () => {
      const result = getNewCommits('/nonexistent/path', '');
      expect(result).toBe('');
    });
  });

  describe('getDiffStats', () => {
    it('returns stats object for current repo', () => {
      const result = getDiffStats(process.cwd(), '');
      expect(result).toHaveProperty('files');
      expect(result).toHaveProperty('lines');
      expect(result).toHaveProperty('hasCodeFiles');
      expect(typeof result.files).toBe('number');
    });

    it('returns zeros for invalid cwd', () => {
      const result = getDiffStats('/nonexistent/path', '');
      expect(result).toEqual({ files: 0, lines: 0, hasCodeFiles: false });
    });
  });
});
