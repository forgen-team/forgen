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
// P0-2 fix (2026-04-20): rotate를 size gate로 보호. 이전에는 매 hook 완료마다
// full-file read + length split + write까지 실행해 steady-state(500줄 근처)에서
// 매 tool call당 ~40KB의 불필요 I/O가 발생했다. statSync 한 번으로 크기만 보고
// threshold 이하면 read/write 둘 다 skip한다. threshold는 ~80바이트/엔트리 기준
// MAX_LINES × 1.5 여유를 둠.
const ROTATE_SIZE_BYTES = MAX_LINES * 80 * 2; // ~80KB

export function recordHookTiming(hookName: string, durationMs: number, event: string): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const entry = JSON.stringify({ hook: hookName, ms: durationMs, event, at: Date.now() });
    fs.appendFileSync(TIMING_LOG, `${entry}\n`);

    // Rotate if too large — size-gated (statSync only, skip read/write 대부분의 호출)
    try {
      const size = fs.statSync(TIMING_LOG).size;
      if (size < ROTATE_SIZE_BYTES) return;
      const content = fs.readFileSync(TIMING_LOG, 'utf-8');
      const lines = content.trim().split('\n');
      if (lines.length > MAX_LINES) {
        fs.writeFileSync(TIMING_LOG, `${lines.slice(-MAX_LINES).join('\n')}\n`);
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
      byHook.get(e.hook)?.push(e.ms);
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
