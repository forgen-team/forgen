/**
 * Forgen — Dashboard CLI (P3)
 *
 * `fgx status [--watch] [--json] [--interval N]`
 * ANSI box-drawing 기반 상태 대시보드. TUI 라이브러리 없음.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getUsageStats } from './usage-telemetry.js';
import { classifySolutions } from './lifecycle-classifier.js';
import type { LifecycleClass } from './lifecycle-classifier.js';
import { STATE_DIR } from './paths.js';
import { FORGEN_HOME } from './paths.js';

export interface DashboardOptions {
  watch?: boolean;
  json?: boolean;
  intervalSec?: number;
}

// ── ANSI ──────────────────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const C = {
  reset: isTTY ? '\x1b[0m' : '',
  bold:  isTTY ? '\x1b[1m' : '',
  dim:   isTTY ? '\x1b[2m' : '',
  cyan:  isTTY ? '\x1b[36m' : '',
  yellow:isTTY ? '\x1b[33m' : '',
  green: isTTY ? '\x1b[32m' : '',
  red:   isTTY ? '\x1b[31m' : '',
};

const BOX_WIDTH = 66;

function bar(pct: number, width = 10): string {
  const filled = Math.round(pct * width);
  const empty = width - filled;
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));
}

function boxLine(content: string): string {
  const plain = content.replace(/\x1b\[[0-9;]*m/g, '');
  const padding = BOX_WIDTH - 2 - plain.length;
  return `│ ${content}${' '.repeat(Math.max(0, padding))} │`;
}

function boxEmpty(): string {
  return `│${' '.repeat(BOX_WIDTH - 2)}│`;
}

function boxTop(): string {
  return `┌─ ${C.bold}${C.cyan}forgen status${C.reset}` +
    ' ' + '─'.repeat(BOX_WIDTH - 17) + '┐';
}

function boxBottom(): string {
  return `└${'─'.repeat(BOX_WIDTH - 2)}┘`;
}

// ── Data collectors ───────────────────────────────────────────────────────────

interface DashboardData {
  timestamp: string;
  usage: {
    hour5: { claude: number; codex: number; total: number };
    week: { claude: number; codex: number; total: number };
  };
  todayExtracted: number;
  solutions: {
    total: number;
    hot: number;
    warm: number;
    cold: number;
    dead: number;
    new: number;
    topHot: Array<{ id: string; surfaced: number; acted: number; rate: number }>;
    classified: LifecycleClass[];
  };
  rateLimitMisses7d: number;
}

function collectData(): DashboardData {
  const now = new Date();

  // usage
  const usage = (() => {
    try { return getUsageStats(); }
    catch { return { hour5: { claude: 0, codex: 0, total: 0 }, week: { claude: 0, codex: 0, total: 0 } }; }
  })();

  // today extracted: me/solutions/*.md mtime이 오늘인 것 (또는 last-extraction.json)
  const todayExtracted = (() => {
    try {
      const lastExtPath = path.join(STATE_DIR, 'last-extraction.json');
      if (fs.existsSync(lastExtPath)) {
        const data = JSON.parse(fs.readFileSync(lastExtPath, 'utf-8')) as { count?: number; ts?: number };
        const ts = data.ts ?? 0;
        const isToday = new Date(ts).toDateString() === now.toDateString();
        if (isToday && typeof data.count === 'number') return data.count;
      }
    } catch { /* ignore */ }
    // fallback: count solutions modified today
    try {
      const solutionsDir = path.join(FORGEN_HOME, 'me', 'solutions');
      if (!fs.existsSync(solutionsDir)) return 0;
      const files = fs.readdirSync(solutionsDir).filter(f => f.endsWith('.md'));
      const todayStr = now.toDateString();
      return files.filter(f => {
        try {
          const stat = fs.statSync(path.join(solutionsDir, f));
          return new Date(stat.mtimeMs).toDateString() === todayStr;
        } catch { return false; }
      }).length;
    } catch { return 0; }
  })();

  // lifecycle
  const classified = (() => {
    try { return classifySolutions(); }
    catch { return []; }
  })();

  const counts = { hot: 0, warm: 0, cold: 0, dead: 0, new: 0 };
  for (const c of classified) counts[c.lifecycle]++;

  const topHot = classified
    .filter(c => c.lifecycle === 'hot')
    .sort((a, b) => b.acted_90d - a.acted_90d)
    .slice(0, 5)
    .map(c => ({
      id: c.solutionId,
      surfaced: c.surfaced_90d,
      acted: c.acted_90d,
      rate: c.hitRate ?? 0,
    }));

  // rate-limit misses (7d)
  const rateLimitMisses7d = (() => {
    try {
      const missPath = path.join(STATE_DIR, 'rate-limit-misses.jsonl');
      if (!fs.existsSync(missPath)) return 0;
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const lines = fs.readFileSync(missPath, 'utf-8').split('\n').filter(Boolean);
      return lines.filter(l => {
        try {
          const obj = JSON.parse(l) as { ts?: number };
          return typeof obj.ts === 'number' && obj.ts >= cutoff;
        } catch { return false; }
      }).length;
    } catch { return 0; }
  })();

  return {
    timestamp: now.toISOString(),
    usage,
    todayExtracted,
    solutions: {
      total: classified.length,
      ...counts,
      topHot,
      classified,
    },
    rateLimitMisses7d,
  };
}

// ── Render ─────────────────────────────────────────────────────────────────────

function renderTTY(data: DashboardData): string {
  const lines: string[] = [];

  lines.push(boxTop());
  lines.push(boxEmpty());

  // Usage
  lines.push(boxLine(`${C.bold}Usage${C.reset}`));

  const h5total = data.usage.hour5.total;
  const h5pct = Math.min(1, h5total / Math.max(h5total + 10, 50));
  const h5bar = bar(h5pct);
  lines.push(boxLine(`  5h window:    ${C.yellow}${h5bar}${C.reset}  (${h5total} tool calls)`));

  const wktotal = data.usage.week.total;
  const wkpct = Math.min(1, wktotal / Math.max(wktotal + 10, 100));
  const wkbar = bar(wkpct);
  lines.push(boxLine(`  weekly:       ${C.yellow}${wkbar}${C.reset}  (${wktotal} tool calls)`));

  lines.push(boxEmpty());

  // Today compound
  lines.push(boxLine(`${C.bold}Today's compound${C.reset}`));
  lines.push(boxLine(`  extracted:    ${data.todayExtracted} solutions`));

  lines.push(boxEmpty());

  // Solutions
  lines.push(boxLine(`${C.bold}Solutions${C.reset} (${data.solutions.total} total)`));
  const lifecycleLine =
    `  ${C.red}🔥 hot:${C.reset}  ${data.solutions.hot}` +
    `   ${C.yellow}🟡 warm:${C.reset} ${data.solutions.warm}` +
    `   ${C.cyan}🥶 cold:${C.reset} ${data.solutions.cold}` +
    `   ${C.dim}💀 dead:${C.reset} ${data.solutions.dead}` +
    `   ${C.green}🌱 new:${C.reset}  ${data.solutions.new}`;
  lines.push(boxLine(lifecycleLine));

  lines.push(boxEmpty());

  // Top 5 hot
  if (data.solutions.topHot.length > 0) {
    lines.push(boxLine(`${C.bold}Top ${data.solutions.topHot.length} hot (90d)${C.reset}`));
    for (const h of data.solutions.topHot) {
      const pctStr = `${Math.round(h.rate * 100)}%`;
      const idShort = h.id.length > 36 ? h.id.slice(0, 33) + '...' : h.id;
      lines.push(boxLine(`  · ${C.yellow}${idShort}${C.reset}  surf=${h.surfaced} acted=${h.acted} (${pctStr})`));
    }
    lines.push(boxEmpty());
  }

  // Rate-limit
  lines.push(boxLine(`${C.bold}Rate-limit${C.reset}`));
  lines.push(boxLine(`  misses (7d):  ${data.rateLimitMisses7d}`));

  lines.push(boxEmpty());

  // Last update
  lines.push(boxLine(`${C.dim}Last update:    ${data.timestamp}${C.reset}`));

  lines.push(boxBottom());

  return lines.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runDashboard(opts: DashboardOptions): Promise<void> {
  const intervalSec = opts.intervalSec ?? 5;

  const render = () => {
    const data = collectData();

    if (opts.json) {
      // Strip classified array (verbose) from JSON output for cleaner schema
      const { solutions: { classified: _c, ...solutionStats }, ...rest } = data;
      process.stdout.write(JSON.stringify({ ...rest, solutions: solutionStats }, null, 2) + '\n');
      return;
    }

    const output = renderTTY(data);
    if (opts.watch) {
      process.stdout.write('\x1b[2J\x1b[H'); // clear screen
    }
    process.stdout.write(output + '\n');
  };

  render();

  if (opts.watch) {
    const interval = setInterval(render, intervalSec * 1000);
    process.on('SIGINT', () => {
      clearInterval(interval);
      process.stdout.write('\n');
      process.exit(0);
    });
    // Keep process alive
    await new Promise<never>(() => { /* intentionally never resolves */ });
  }
}
