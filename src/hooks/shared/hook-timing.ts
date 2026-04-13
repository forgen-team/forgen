/**
 * Forgen — Hook Timing Profiler
 *
 * Records hook execution durations and provides timing statistics
 * for visibility into which hooks are slow.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from '../../core/paths.js';

const TIMING_LOG = path.join(STATE_DIR, 'hook-timing.jsonl');
const MAX_LINES = 500;

export function recordHookTiming(hookName: string, durationMs: number, event: string): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const entry = JSON.stringify({ hook: hookName, ms: durationMs, event, at: Date.now() });
    fs.appendFileSync(TIMING_LOG, entry + '\n');

    // Rotate if too large
    try {
      const content = fs.readFileSync(TIMING_LOG, 'utf-8');
      const lines = content.trim().split('\n');
      if (lines.length > MAX_LINES) {
        fs.writeFileSync(TIMING_LOG, lines.slice(-MAX_LINES).join('\n') + '\n');
      }
    } catch { /* skip rotation on error */ }
  } catch { /* fail-open */ }
}

export interface TimingStats {
  hook: string;
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export function getTimingStats(): TimingStats[] {
  try {
    if (!fs.existsSync(TIMING_LOG)) return [];
    const content = fs.readFileSync(TIMING_LOG, 'utf-8');
    const entries = content.trim().split('\n')
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);

    const byHook = new Map<string, number[]>();
    for (const e of entries) {
      if (!byHook.has(e.hook)) byHook.set(e.hook, []);
      byHook.get(e.hook)!.push(e.ms);
    }

    const stats: TimingStats[] = [];
    for (const [hook, times] of byHook) {
      times.sort((a, b) => a - b);
      stats.push({
        hook,
        count: times.length,
        p50: times[Math.floor(times.length * 0.5)] ?? 0,
        p95: times[Math.floor(times.length * 0.95)] ?? 0,
        max: times[times.length - 1] ?? 0,
      });
    }
    return stats.sort((a, b) => b.p95 - a.p95);
  } catch { return []; }
}
