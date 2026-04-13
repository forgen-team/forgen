/**
 * Tests for hook-timing profiler (getTimingStats, recordHookTiming)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock STATE_DIR to use a temp directory
const tmpDir = path.join(os.tmpdir(), `forgen-timing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

vi.mock('../src/core/paths.js', () => ({
  STATE_DIR: tmpDir,
  FORGEN_HOME: path.join(tmpDir, '..'),
}));

// Must import AFTER mock setup
const { recordHookTiming, getTimingStats } = await import('../src/hooks/shared/hook-timing.js');

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('hook-timing', () => {
  it('getTimingStats returns empty array when no log file exists', () => {
    const stats = getTimingStats();
    expect(stats).toEqual([]);
  });

  it('recordHookTiming creates the timing log file', () => {
    recordHookTiming('test-hook', 42, 'PreToolUse');
    const logPath = path.join(tmpDir, 'hook-timing.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.hook).toBe('test-hook');
    expect(entry.ms).toBe(42);
    expect(entry.event).toBe('PreToolUse');
    expect(typeof entry.at).toBe('number');
  });

  it('getTimingStats returns correct statistics', () => {
    // Write multiple timing entries
    recordHookTiming('fast-hook', 10, 'PreToolUse');
    recordHookTiming('fast-hook', 20, 'PreToolUse');
    recordHookTiming('fast-hook', 30, 'PreToolUse');
    recordHookTiming('slow-hook', 100, 'PostToolUse');
    recordHookTiming('slow-hook', 200, 'PostToolUse');

    const stats = getTimingStats();
    expect(stats.length).toBe(2);

    // Sorted by p95 descending, so slow-hook first
    expect(stats[0].hook).toBe('slow-hook');
    expect(stats[0].count).toBe(2);
    expect(stats[0].max).toBe(200);

    expect(stats[1].hook).toBe('fast-hook');
    expect(stats[1].count).toBe(3);
    expect(stats[1].p50).toBe(20);
    expect(stats[1].max).toBe(30);
  });

  it('getTimingStats handles corrupted lines gracefully', () => {
    const logPath = path.join(tmpDir, 'hook-timing.jsonl');
    fs.writeFileSync(logPath, 'not-json\n{"hook":"ok","ms":5,"event":"X","at":1}\n');
    const stats = getTimingStats();
    expect(stats.length).toBe(1);
    expect(stats[0].hook).toBe('ok');
  });

  it('recordHookTiming rotates when exceeding MAX_LINES', () => {
    const logPath = path.join(tmpDir, 'hook-timing.jsonl');
    // Write 510 entries
    const lines: string[] = [];
    for (let i = 0; i < 510; i++) {
      lines.push(JSON.stringify({ hook: 'test', ms: i, event: 'X', at: Date.now() }));
    }
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    // This call should trigger rotation
    recordHookTiming('test', 999, 'X');

    const content = fs.readFileSync(logPath, 'utf-8');
    const remaining = content.trim().split('\n');
    expect(remaining.length).toBeLessThanOrEqual(500);
  });
});
