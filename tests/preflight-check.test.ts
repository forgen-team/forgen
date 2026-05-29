import { describe, it, expect } from 'vitest';
import { checkForgenInitialized, hasPreflightWarned, markPreflightWarned } from '../src/hooks/shared/preflight-check.js';

describe('preflight-check (extracted module)', () => {
  it('returns a result with initialized boolean', () => {
    const result = checkForgenInitialized();
    expect(typeof result.initialized).toBe('boolean');
    if (!result.initialized) {
      expect(typeof result.message).toBe('string');
      expect(result.message!.length).toBeGreaterThan(0);
    }
  });

  it('hasPreflightWarned returns false for nonexistent session', () => {
    expect(hasPreflightWarned(`nonexistent-session-${Date.now()}`)).toBe(false);
  });

  it('markPreflightWarned + hasPreflightWarned roundtrip', () => {
    const sid = `test-preflight-${Date.now()}`;
    markPreflightWarned(sid);
    expect(hasPreflightWarned(sid)).toBe(true);
  });

  it('checkForgenInitialized is fail-open (never throws)', () => {
    expect(() => checkForgenInitialized()).not.toThrow();
  });
});
