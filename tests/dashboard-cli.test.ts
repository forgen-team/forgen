/**
 * dashboard-cli — unit tests (P3)
 * - JSON output schema lock
 * - 빈 데이터 케이스 (error X)
 * - --watch interval 동작 (mock timer)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── isolate FORGEN_HOME ───────────────────────────────────────────────────────
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-dash-test-'));
process.env.FORGEN_HOME = TMP_HOME;

// ── mock dependencies ─────────────────────────────────────────────────────────
vi.mock('../src/core/usage-telemetry.js', () => ({
  getUsageStats: vi.fn(() => ({
    hour5: { claude: 10, codex: 0, total: 10 },
    week: { claude: 100, codex: 0, total: 100 },
  })),
}));

vi.mock('../src/core/lifecycle-classifier.js', () => ({
  classifySolutions: vi.fn(() => []),
}));

const { runDashboard } = await import('../src/core/dashboard-cli.js');

describe('dashboard-cli', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('--json output: valid JSON, schema fields present', async () => {
    let output = '';
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      output += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    };
    try {
      await runDashboard({ json: true });
    } finally {
      process.stdout.write = orig;
    }

    const parsed = JSON.parse(output) as Record<string, unknown>;
    // Schema lock: required top-level keys
    expect(parsed).toHaveProperty('timestamp');
    expect(parsed).toHaveProperty('usage');
    expect(parsed).toHaveProperty('todayExtracted');
    expect(parsed).toHaveProperty('solutions');
    expect(parsed).toHaveProperty('rateLimitMisses7d');

    // usage shape
    const usage = parsed.usage as Record<string, unknown>;
    expect(usage).toHaveProperty('hour5');
    expect(usage).toHaveProperty('week');

    // solutions shape
    const solutions = parsed.solutions as Record<string, unknown>;
    expect(solutions).toHaveProperty('total');
    expect(solutions).toHaveProperty('hot');
    expect(solutions).toHaveProperty('warm');
    expect(solutions).toHaveProperty('cold');
    expect(solutions).toHaveProperty('dead');
    expect(solutions).toHaveProperty('new');
    expect(solutions).toHaveProperty('topHot');

    // classified array is stripped from JSON
    expect(solutions).not.toHaveProperty('classified');
  });

  it('빈 데이터 (events 0건): error 없이 출력', async () => {
    let threw = false;
    let output = '';
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      output += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    };
    try {
      await runDashboard({ json: true });
    } catch {
      threw = true;
    } finally {
      process.stdout.write = orig;
    }
    expect(threw).toBe(false);
    const parsed = JSON.parse(output) as { solutions: { total: number } };
    expect(parsed.solutions.total).toBe(0);
  });

  it('TTY 출력: box top/bottom 포함', async () => {
    let output = '';
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      output += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    };
    try {
      await runDashboard({ json: false });
    } finally {
      process.stdout.write = orig;
    }
    expect(output).toContain('forgen status');
    expect(output).toContain('└');
    expect(output).toContain('┌');
  });

  it('--watch: setInterval 이 intervalSec 마다 redraw 호출', async () => {
    let renderCount = 0;
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => { renderCount++; return true; };

    // mock process.exit to prevent vitest from catching it as an error
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      // noop — prevent actual exit
    }) as typeof process.exit);

    const watchPromise = runDashboard({ watch: true, json: true, intervalSec: 5 });

    // advance timer by 10s → initial render + 2 interval renders
    vi.advanceTimersByTime(10_000);

    // emit SIGINT to trigger clearInterval + process.exit
    process.emit('SIGINT');

    process.stdout.write = origWrite;

    // renderCount > 1 confirms multiple renders happened
    expect(renderCount).toBeGreaterThan(1);
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();

    // watchPromise never resolves (infinite await), so we don't await it
    watchPromise.catch(() => { /* expected */ });
  });
});
