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
// H13: 500줄 회전은 hook 호출이 잦으면 몇 시간치뿐이라 30일 p95 집계가 불가능했다.
// 엔트리는 ~80바이트 — 30일 × 일 5,000회 ≈ 150,000줄 ≈ 12MB. 상한을 200,000줄로 두고 오래된 쪽부터 버린다.
const MAX_LINES = 200_000;
// P0-2 fix (2026-04-20): rotate를 size gate로 보호. 이전에는 매 hook 완료마다
// full-file read + length split + write까지 실행해 steady-state(500줄 근처)에서
// 매 tool call당 ~40KB의 불필요 I/O가 발생했다. statSync 한 번으로 크기만 보고
// threshold 이하면 read/write 둘 다 skip한다. threshold는 ~80바이트/엔트리 기준
// MAX_LINES × 1.5 여유를 둠.
const ROTATE_SIZE_BYTES = MAX_LINES * 90; // ~18MB 를 넘을 때만 회전 검사(대부분 호출은 stat 한 번)

export function recordHookTiming(hookName: string, durationMs: number, event: string): void {
  // ADR-015 C-G1 (critic #2): 중첩 추출 run 의 빠른 early-approve 타이밍이 p95 를 왜곡하지 않도록 기록 생략.
  if (process.env.FORGEN_NESTED_RUN === '1') return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // ADR-014 D5 — host 별 발화 구분 (codex-adapter 가 FORGEN_RUNTIME=codex 주입).
    const rt = process.env.FORGEN_RUNTIME === 'codex' ? 'codex' : 'claude';
    const entry = JSON.stringify({ hook: hookName, ms: durationMs, event, at: Date.now(), rt });
    fs.appendFileSync(TIMING_LOG, `${entry}\n`);

    // Rotate if too large — size-gated (statSync only, skip read/write 대부분의 호출)
    try {
      const size = fs.statSync(TIMING_LOG).size;
      if (size < ROTATE_SIZE_BYTES) return;
      const content = fs.readFileSync(TIMING_LOG, 'utf-8');
      const lines = content.trim().split('\n');
      if (lines.length > MAX_LINES) {
        // 목표의 90% 로 줄여 매 호출마다 재회전하지 않게 한다. tmp + rename 으로 동시 append 와의 충돌 최소화.
        const keep = lines.slice(-Math.floor(MAX_LINES * 0.9));
        const tmp = `${TIMING_LOG}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${keep.join('\n')}\n`);
        fs.renameSync(tmp, TIMING_LOG);
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
