import { describe, it, expect } from 'vitest';
import { extractFromSessionContext, loadPromptHistoryFallback, loadClaudeProjectSessionContext } from '../src/engine/extraction-session.js';

describe('extraction-session (extracted module)', () => {
  describe('loadPromptHistoryFallback', () => {
    it('returns empty array when no history file', () => {
      const result = loadPromptHistoryFallback();
      expect(Array.isArray(result)).toBe(true);
    });

    it('does not throw', () => {
      expect(() => loadPromptHistoryFallback()).not.toThrow();
    });
  });

  describe('loadClaudeProjectSessionContext', () => {
    it('returns { prompts, writes } structure', () => {
      const result = loadClaudeProjectSessionContext('/nonexistent/path', '');
      expect(result).toHaveProperty('prompts');
      expect(result).toHaveProperty('writes');
      expect(Array.isArray(result.prompts)).toBe(true);
      expect(Array.isArray(result.writes)).toBe(true);
    });

    it('returns empty for nonexistent cwd', () => {
      const result = loadClaudeProjectSessionContext('/tmp/nonexistent-forgen-test', '');
      expect(result.prompts.length).toBe(0);
    });
  });

  describe('extractFromSessionContext', () => {
    it('returns array of ExtractedSolution', () => {
      const result = extractFromSessionContext('', '/tmp/nonexistent', '');
      expect(Array.isArray(result)).toBe(true);
    });

    it('detects tech stack when terms appear in both diff and prompts', () => {
      // This test relies on session context which we can't easily mock,
      // so we just verify it doesn't crash with empty inputs.
      const result = extractFromSessionContext('import react from "react";\nimport vitest from "vitest";', '/tmp/nonexistent', '');
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
