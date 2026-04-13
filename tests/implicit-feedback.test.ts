/**
 * Tests for implicit feedback capture in post-tool-use
 * Tests the pure functions: simpleHash, trackModifiedFile (with recentWrites)
 */
import { describe, it, expect } from 'vitest';
import { trackModifiedFile } from '../src/hooks/post-tool-use.js';

describe('trackModifiedFile with implicit feedback', () => {
  it('increments file count on each call', () => {
    const state = { sessionId: 'test', files: {}, toolCallCount: 0 };
    const r1 = trackModifiedFile(state, '/tmp/foo.ts', 'Edit');
    expect(r1.count).toBe(1);
    const r2 = trackModifiedFile(r1.state, '/tmp/foo.ts', 'Edit');
    expect(r2.count).toBe(2);
  });

  it('tracks different files independently', () => {
    const state = { sessionId: 'test', files: {}, toolCallCount: 0 };
    const r1 = trackModifiedFile(state, '/tmp/a.ts', 'Write');
    const r2 = trackModifiedFile(r1.state, '/tmp/b.ts', 'Write');
    expect(r1.count).toBe(1);
    expect(r2.count).toBe(1);
    expect(Object.keys(r2.state.files).length).toBe(2);
  });

  it('returns count >= 5 on repeated edits', () => {
    let state = { sessionId: 'test', files: {}, toolCallCount: 0 };
    for (let i = 0; i < 5; i++) {
      const r = trackModifiedFile(state, '/tmp/repeated.ts', 'Edit');
      state = r.state;
      if (i === 4) {
        expect(r.count).toBe(5);
      }
    }
  });
});
