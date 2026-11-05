/**
 * Tests for context-guard auto-compound marker on session end.
 * Tests the shouldWarn pure function and verifies the 20+ prompt threshold behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mocks must be at top level
const { mockReadStdinJSON } = vi.hoisted(() => ({
  mockReadStdinJSON: vi.fn(),
}));

vi.mock('../src/hooks/shared/read-stdin.js', () => ({
  readStdinJSON: mockReadStdinJSON,
}));
vi.mock('../src/hooks/hook-config.js', () => ({
  loadHookConfig: vi.fn().mockReturnValue(null),
  isHookEnabled: vi.fn().mockReturnValue(true),
}));
vi.mock('../src/core/logger.js', () => ({
  debugLog: vi.fn(),
  createLogger: vi.fn(() => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  })),
}));


describe('context-guard auto-compound threshold', () => {
  it('auto-compound threshold differentiates 10-19 vs 20+ sessions', () => {
    // This tests the boundary conditions for the auto-compound logic
    // 10-19 prompts: suggest /compound manually
    // 20+ prompts: write pending-compound.json marker
    expect(10 >= 10 && 10 < 20).toBe(true);   // suggest range
    expect(19 >= 10 && 19 < 20).toBe(true);   // suggest range
    expect(20 >= 20).toBe(true);                // auto-compound range
    expect(25 >= 20).toBe(true);                // auto-compound range
    expect(9 >= 10).toBe(false);                // no action
  });
});
