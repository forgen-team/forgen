/**
 * R9-PA1: `forgen stats` — 7-number single-screen dashboard.
 *
 * Pure aggregation over existing jsonl sources. No new telemetry; surfaces
 * what forgen is *already* learning so users can verify the trust layer is
 * working between Claude sessions.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAllRules } from '../store/rule-store.js';
import { loadRecentEvidence } from '../store/evidence-store.js';

const ENFORCEMENT_DIR = path.join(os.homedir(), '.forgen', 'state', 'enforcement');
const LIFECYCLE_DIR = path.join(os.homedir(), '.forgen', 'state', 'lifecycle');
const STATE_DIR = path.join(os.homedir(), '.forgen', 'state');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function readJsonl(p: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(p)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch { /* skip malformed */ }
  }
  return out;
}

function countWithin(entries: Array<Record<string, unknown>>, days: number, tsKey = 'at'): number {
  const cutoff = Date.now() - days * MS_PER_DAY;
  let n = 0;
  for (const e of entries) {
    const raw = e[tsKey];
    if (typeof raw !== 'string') continue;
    const t = Date.parse(raw);
    if (Number.isFinite(t) && t >= cutoff) n += 1;
  }
  return n;
}

function readLifecycleRetired(days: number): number {
  if (!fs.existsSync(LIFECYCLE_DIR)) return 0;
  const cutoff = Date.now() - days * MS_PER_DAY;
  let n = 0;
  for (const f of fs.readdirSync(LIFECYCLE_DIR)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const entry of readJsonl(path.join(LIFECYCLE_DIR, f))) {
      const action = entry.suggested_action;
      const ts = typeof entry.ts === 'number' ? entry.ts : Date.parse(String(entry.ts ?? ''));
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      if (action === 'retire' || action === 'supersede') n += 1;
    }
  }
  return n;
}

function readLastExtraction(): string {
  const p = path.join(STATE_DIR, 'last-extraction.json');
  if (!fs.existsSync(p)) return 'never';
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as { timestamp?: string; date?: string };
    const ts = data.timestamp ?? data.date;
    if (!ts) return 'never';
    const diffDays = Math.floor((Date.now() - Date.parse(ts)) / MS_PER_DAY);
    const dateStr = new Date(ts).toISOString().slice(0, 10);
    if (diffDays === 0) return `${dateStr} (today)`;
    if (diffDays === 1) return `${dateStr} (yesterday)`;
    return `${dateStr} (${diffDays}d ago)`;
  } catch {
    return 'unknown';
  }
}

export interface StatsSnapshot {
  activeRules: number;
  suppressedRules: number;
  correctionsTotal: number;
  corrections7d: number;
  blocks7d: number;
  acks7d: number;
  bypass7d: number;
  drift7d: number;
  retired7d: number;
  lastExtraction: string;
}

export function computeStats(): StatsSnapshot {
  const rules = loadAllRules();
  const activeRules = rules.filter((r) => r.status === 'active').length;
  const suppressedRules = rules.filter((r) => r.status === 'suppressed').length;

  const evidence = loadRecentEvidence(500);
  const corrections = evidence.filter((e) => e.type === 'explicit_correction');
  const correctionsTotal = corrections.length;
  const cutoff7d = Date.now() - 7 * MS_PER_DAY;
  const corrections7d = corrections.filter((e) => Date.parse(e.timestamp) >= cutoff7d).length;

  const violations = readJsonl(path.join(ENFORCEMENT_DIR, 'violations.jsonl'));
  const bypass = readJsonl(path.join(ENFORCEMENT_DIR, 'bypass.jsonl'));
  const drift = readJsonl(path.join(ENFORCEMENT_DIR, 'drift.jsonl'));
  const acks = readJsonl(path.join(ENFORCEMENT_DIR, 'acknowledgments.jsonl'));

  // R9-PA2: violations 는 'block' (stop-guard/post-tool) + 'deny' (pre-tool Mech-A)
  // + 'correction' (user bypass audit) 혼재. 사용자 관점에서 "Block" 은 앞의 2종이며
  // correction 은 제외해야 ack ratio 가 의미를 갖는다. legacy-undefined 엔트리도 포함.
  const realBlocks = violations.filter((e) =>
    e.kind === 'block' || e.kind === 'deny' || e.kind === undefined,
  );

  return {
    activeRules,
    suppressedRules,
    correctionsTotal,
    corrections7d,
    blocks7d: countWithin(realBlocks, 7),
    acks7d: countWithin(acks, 7),
    bypass7d: countWithin(bypass, 7),
    drift7d: countWithin(drift, 7),
    retired7d: readLifecycleRetired(7),
    lastExtraction: readLastExtraction(),
  };
}

function padNum(n: number, width = 4): string {
  return String(n).padStart(width);
}

export function renderStats(s: StatsSnapshot): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('  forgen — trust layer status');
  lines.push('  ───────────────────────────');
  lines.push(`  Active rules          ${padNum(s.activeRules)}    (${s.suppressedRules} suppressed)`);
  lines.push(`  Corrections (total)   ${padNum(s.correctionsTotal)}    (+${s.corrections7d} last 7d)`);
  lines.push('');
  lines.push('  Last 7 days');
  // R9-PA2: ack rate = block→retract→pass 루프가 실제 작동한 비율.
  const ackRateLabel = s.blocks7d > 0
    ? `(${Math.round((s.acks7d / s.blocks7d) * 100)}% acknowledged)`
    : '';
  lines.push(`    Blocks              ${padNum(s.blocks7d)}    — times Claude was asked to retract ${ackRateLabel}`);
  lines.push(`    Acknowledgments     ${padNum(s.acks7d)}    — block → retract → pass loops`);
  lines.push(`    Bypass              ${padNum(s.bypass7d)}    — user overrides`);
  lines.push(`    Drift events        ${padNum(s.drift7d)}    — stuck-loop force-approves`);
  lines.push(`    Retired rules       ${padNum(s.retired7d)}    — superseded or timed out`);
  lines.push('');
  lines.push(`  Last extraction: ${s.lastExtraction}`);
  lines.push('');
  return lines.join('\n');
}

export async function handleStats(_args: string[]): Promise<void> {
  const snap = computeStats();
  console.log(renderStats(snap));
}
