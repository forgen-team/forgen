/**
 * forgen watch — real-time hook event stream.
 *
 * Tails hook-timing.jsonl, enforcement/violations.jsonl, and
 * match-eval-log.jsonl to show live forgen activity in a terminal pane.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from './paths.js';

const isTTY = process.stdout.isTTY;
const C = {
  reset: isTTY ? '\x1b[0m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  green: isTTY ? '\x1b[32m' : '',
  red: isTTY ? '\x1b[31m' : '',
  magenta: isTTY ? '\x1b[35m' : '',
};

interface WatchSource {
  label: string;
  path: string;
  format: (entry: Record<string, unknown>) => string | null;
}

function formatTimestamp(isoOrMs: string | number): string {
  try {
    const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '??:??:??';
  }
}

function formatHookTiming(e: Record<string, unknown>): string | null {
  const hook = String(e.hook ?? '');
  const ms = Number(e.ms ?? 0);
  const event = String(e.event ?? '');
  const ts = formatTimestamp(e.at as number);
  const speedColor = ms > 500 ? C.yellow : ms > 1000 ? C.red : C.dim;
  return `${C.dim}${ts}${C.reset} ${C.cyan}hook${C.reset} ${hook} ${C.dim}(${event})${C.reset} ${speedColor}${ms}ms${C.reset}`;
}

function formatViolation(e: Record<string, unknown>): string | null {
  const rule = String(e.rule ?? e.guard ?? e.source ?? 'unknown');
  const kind = String(e.kind ?? 'block');
  const ts = formatTimestamp(String(e.at ?? ''));
  const icon = kind === 'block' ? `${C.red}BLOCK${C.reset}` : `${C.yellow}${kind}${C.reset}`;
  return `${C.dim}${ts}${C.reset} ${icon} ${C.magenta}${rule}${C.reset}`;
}

function formatMatchEval(e: Record<string, unknown>): string | null {
  const source = String(e.source ?? '');
  const ranked = e.rankedTopN as unknown[] | undefined;
  const ts = formatTimestamp(String(e.ts ?? ''));
  if (!ranked || !Array.isArray(ranked) || ranked.length === 0) return null;
  // rankedTopN entries can be strings (names) or objects {name: ...}
  const names = ranked.slice(0, 3).map(r => {
    if (typeof r === 'string') return r;
    if (typeof r === 'object' && r !== null && 'name' in r) {
      return String((r as Record<string, unknown>).name);
    }
    return '?';
  }).filter(Boolean).join(', ');
  if (!names) return null;
  return `${C.dim}${ts}${C.reset} ${C.green}match${C.reset} ${C.dim}(${source})${C.reset} ${names}`;
}

function tailFile(filePath: string, fromEnd: number): Array<Record<string, unknown>> {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    const tail = lines.slice(-fromEnd);
    const out: Array<Record<string, unknown>> = [];
    for (const line of tail) {
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

function watchFile(filePath: string, onLine: (entry: Record<string, unknown>) => void): fs.FSWatcher | null {
  let lastSize = 0;
  try {
    if (fs.existsSync(filePath)) {
      lastSize = fs.statSync(filePath).size;
    }
  } catch { /* ok */ }

  try {
    return fs.watch(filePath, () => {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size <= lastSize) {
          lastSize = stat.size;
          return;
        }
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(stat.size - lastSize);
        fs.readSync(fd, buf, 0, buf.length, lastSize);
        fs.closeSync(fd);
        lastSize = stat.size;

        const chunk = buf.toString('utf-8');
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          try { onLine(JSON.parse(line)); } catch { /* skip */ }
        }
      } catch { /* fail-open */ }
    });
  } catch {
    return null;
  }
}

export async function handleWatch(): Promise<void> {
  const sources: WatchSource[] = [
    {
      label: 'hooks',
      path: path.join(STATE_DIR, 'hook-timing.jsonl'),
      format: formatHookTiming,
    },
    {
      label: 'enforcement',
      path: path.join(STATE_DIR, 'enforcement', 'violations.jsonl'),
      format: formatViolation,
    },
    {
      label: 'matches',
      path: path.join(STATE_DIR, 'match-eval-log.jsonl'),
      format: formatMatchEval,
    },
  ];

  console.log(`\n  ${C.cyan}forgen status --live${C.reset} — real-time event stream`);
  console.log(`  ${C.dim}Watching: hook-timing, violations, match-eval-log${C.reset}`);
  console.log(`  ${C.dim}Press Ctrl+C to stop${C.reset}\n`);

  // Show recent events (last 10 per source)
  const recent: Array<{ ts: number; line: string }> = [];
  for (const src of sources) {
    const entries = tailFile(src.path, 10);
    for (const e of entries) {
      const line = src.format(e);
      if (!line) continue;
      const ts = typeof e.at === 'number' ? e.at
        : typeof e.at === 'string' ? Date.parse(e.at)
        : typeof e.ts === 'string' ? Date.parse(e.ts)
        : 0;
      recent.push({ ts, line });
    }
  }

  recent.sort((a, b) => a.ts - b.ts);
  if (recent.length > 0) {
    console.log(`  ${C.dim}── recent ──${C.reset}`);
    for (const r of recent.slice(-15)) {
      console.log(`  ${r.line}`);
    }
    console.log(`  ${C.dim}── live ──${C.reset}\n`);
  }

  // Watch for new events
  const watchers: fs.FSWatcher[] = [];
  for (const src of sources) {
    const watcher = watchFile(src.path, (entry) => {
      const line = src.format(entry);
      if (line) console.log(`  ${line}`);
    });
    if (watcher) watchers.push(watcher);
  }

  // Keep process alive
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      for (const w of watchers) w.close();
      console.log(`\n  ${C.dim}watch stopped${C.reset}\n`);
      resolve();
    });
  });
}
