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

  it('H13: 30일치 집계가 가능한 크기를 보존하고, 상한을 넘으면 오래된 쪽부터 회전', () => {
    const logPath = path.join(tmpDir, 'hook-timing.jsonl');
    // 기존 500줄 회전이면 하루도 못 가던 규모: 5만 줄(30일 × 일 ~1,700회)이 그대로 남아야 한다.
    const day = 24 * 3600 * 1000; const now = Date.now();
    const mk = (i: number, n: number) => JSON.stringify({ hook: 'h', ms: 5, event: 'E', at: now - (n - i) * (30 * day / n) });
    const N = 50_000;
    fs.writeFileSync(logPath, Array.from({ length: N }, (_, i) => mk(i, N)).join('\n') + '\n');
    recordHookTiming('h', 7, 'E');
    const kept = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(kept.length).toBeGreaterThan(N);
    const oldest = JSON.parse(kept[0]).at;
    expect(now - oldest).toBeGreaterThan(29 * day);

    // 상한(200,000줄)을 넘으면 회전: 90% 로 줄고 최신 엔트리는 유지
    const big = 200_100;
    fs.writeFileSync(logPath, Array.from({ length: big }, (_, i) => JSON.stringify({ hook: 'h', ms: i, event: 'E'.repeat(60), at: i })).join('\n') + '\n');
    recordHookTiming('h', 1, 'E');
    const after = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(after.length).toBeLessThanOrEqual(200_000);
    expect(JSON.parse(after[after.length - 2]).ms).toBe(big - 1);
  });
});

describe('hook-timing rt field (ADR-014 D5)', () => {
  it('FORGEN_RUNTIME=codex 면 rt:"codex", 아니면 "claude"', () => {
    const prev = process.env.FORGEN_RUNTIME;
    try {
      process.env.FORGEN_RUNTIME = 'codex';
      recordHookTiming('x', 1, 'PreToolUse');
      delete process.env.FORGEN_RUNTIME;
      recordHookTiming('y', 2, 'PreToolUse');
      const lines = fs.readFileSync(path.join(tmpDir, 'hook-timing.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines.map((l) => l.rt)).toEqual(['codex', 'claude']);
    } finally {
      if (prev === undefined) delete process.env.FORGEN_RUNTIME; else process.env.FORGEN_RUNTIME = prev;
    }
  });
});
