/**
 * Tests for failOpenWithTracking in hook-response.ts
 *
 * Note: failOpenWithTracking writes to the real STATE_DIR (~/.forgen/state/).
 * We test the return value and verify the function doesn't throw.
 * The file write side effect is tested indirectly through the doctor.ts integration.
 */
import { describe, it, expect } from 'vitest';
import { failOpenWithTracking, approve, deny, ask } from '../src/hooks/shared/hook-response.js';

describe('hook-response functions', () => {
  it('failOpenWithTracking returns continue: true JSON', () => {
    const result = JSON.parse(failOpenWithTracking('test-hook'));
    expect(result.continue).toBe(true);
  });

  it('failOpenWithTracking does not throw even with invalid inputs', () => {
    expect(() => failOpenWithTracking('')).not.toThrow();
    expect(() => failOpenWithTracking('hook-with-special/chars')).not.toThrow();
  });

  it('approve returns continue: true', () => {
    const result = JSON.parse(approve());
    expect(result.continue).toBe(true);
  });

  it('deny returns continue: false with deny decision', () => {
    const result = JSON.parse(deny('test reason'));
    expect(result.continue).toBe(false);
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toBe('test reason');
  });

  it('ask returns continue: true with ask decision', () => {
    const result = JSON.parse(ask('confirm reason'));
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput.permissionDecision).toBe('ask');
  });
});
