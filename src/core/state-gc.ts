/**
 * State directory garbage collector.
 *
 * `~/.forgen/state/` accumulates per-session files that are never cleaned
 * up (injection-cache, active-agents, checkpoint, modified-files,
 * outcome-pending, permissions, skill-trigger, tool-state, etc.). A field
 * audit on 2026-04-21 found one installation with 10,802 files in a single
 * flat directory — SessionStart hook scans linearly on each session, and
 * `ls` / `rsync` / backup tools all pay the cost.
 *
 * This module scans session-scoped files by filename prefix and prunes
 * those older than a configurable retention window (default 7 days). The
 * jsonl aggregate logs (hook-errors.jsonl, hook-timing.jsonl,
 * implicit-feedback.jsonl, match-eval-log.jsonl, solution-quarantine.jsonl)
 * are left alone — they are tracked append-only and handled by #5
 * (log rotation).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR, OUTCOMES_DIR } from './paths.js';

/** Filename prefixes that identify session-scoped ephemeral files. */
const SESSION_SCOPED_PREFIXES = [
  'active-agents-',
  'checkpoint-',
  'injection-cache-',
  'modified-files-',
  'outcome-pending-',
  'permissions-',
  'skill-trigger-',
  'tool-state-',
  'reminder-',
  'context-',
  'last-',
];

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface PruneReport {
  scanned: number;
  pruned: number;
  bytesFreed: number;
  retentionDays: number;
  dryRun: boolean;
  /** First 20 pruned file basenames for user confirmation */
  sample: string[];
}

export interface PruneOptions {
  retentionMs?: number;
  dryRun?: boolean;
  /** Override the state directory. Used by tests. */
  stateDir?: string;
  /** Override the outcomes directory. Used by tests. */
  outcomesDir?: string;
  /** Current time for deterministic tests. Defaults to Date.now(). */
  now?: number;
}

function hasSessionPrefix(name: string): boolean {
  return SESSION_SCOPED_PREFIXES.some((pfx) => name.startsWith(pfx));
}

function pruneDir(
  dir: string,
  cutoff: number,
  dryRun: boolean,
  filter: (name: string) => boolean,
): { scanned: number; pruned: number; bytes: number; sample: string[] } {
  const out = { scanned: 0, pruned: 0, bytes: 0, sample: [] as string[] };
  if (!fs.existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!filter(name)) continue;
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.scanned++;
    if (stat.mtimeMs >= cutoff) continue;
    if (!dryRun) {
      try {
        fs.unlinkSync(full);
      } catch {
        continue;
      }
    }
    out.pruned++;
    out.bytes += stat.size;
    if (out.sample.length < 20) out.sample.push(name);
  }
  return out;
}

/**
 * 0.4.6 #14 — append-only jsonl 로그 회전.
 *
 * state-gc 의 SESSION_SCOPED_PREFIXES 는 session 별 파일을 prefix-base 로 잡지만,
 * 단일 aggregate jsonl (hook-timing, prompt-history, usage-telemetry 등) 은 매번
 * append 되어 무한 grow. 본 함수가 size cap (default 10MB) 초과 시 `<name>.1` 로
 * rotate 하고 `<name>.2` 는 삭제 (한 단계만 보존).
 *
 * 회전 정책:
 *  - cap 미만: no-op
 *  - cap 초과: <name>.2 삭제 → <name>.1 → <name>.2, <name> → <name>.1, 새 빈 <name>
 *  - 0.4.6 신설 jsonl 들 (prompt-history, usage-telemetry, rate-limit-misses) 포함
 *
 * fail-open: 모든 I/O 실패는 silent — 호출 측 차단 안 함.
 */
const ROTATABLE_LOGS = [
  'hook-errors.jsonl',
  'hook-timing.jsonl',
  'implicit-feedback.jsonl',
  'match-eval-log.jsonl',
  'solution-quarantine.jsonl',
  'prompt-history.jsonl',
  'usage-telemetry.jsonl',
  'rate-limit-misses.jsonl',
];
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024; // 10MB

export interface RotateReport {
  scanned: number;
  rotated: number;
  bytesFreed: number;
  sample: string[];
}

export function rotateAppendOnlyLogs(opts: {
  stateDir?: string;
  maxBytes?: number;
} = {}): RotateReport {
  const stateDir = opts.stateDir ?? STATE_DIR;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
  const out: RotateReport = { scanned: 0, rotated: 0, bytesFreed: 0, sample: [] };
  if (!fs.existsSync(stateDir)) return out;

  for (const name of ROTATABLE_LOGS) {
    const full = path.join(stateDir, name);
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { continue; }
    out.scanned++;
    if (stat.size <= maxBytes) continue;

    try {
      const r1 = `${full}.1`;
      const r2 = `${full}.2`;
      // .2 삭제
      try { fs.unlinkSync(r2); out.bytesFreed += fs.existsSync(r2) ? 0 : (fs.statSync(r2).size ?? 0); } catch { /* no .2 */ }
      // .1 → .2
      try { if (fs.existsSync(r1)) fs.renameSync(r1, r2); } catch { /* skip */ }
      // active → .1
      fs.renameSync(full, r1);
      // 새 빈 파일
      fs.writeFileSync(full, '');
      out.rotated++;
      if (out.sample.length < 20) out.sample.push(name);
    } catch { /* fail-open per file */ }
  }
  return out;
}

/**
 * Prune session-scoped files older than `retentionMs` from the state and
 * outcomes directories. Defaults to a dry-run so callers must opt-in to
 * deletion via `dryRun: false`.
 */
export function pruneState(opts: PruneOptions = {}): PruneReport {
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const dryRun = opts.dryRun ?? true;
  const stateDir = opts.stateDir ?? STATE_DIR;
  const outcomesDir = opts.outcomesDir ?? OUTCOMES_DIR;
  const now = opts.now ?? Date.now();
  const cutoff = now - retentionMs;

  const state = pruneDir(stateDir, cutoff, dryRun, hasSessionPrefix);
  // outcomes/*.jsonl: one file per session, session-scoped by design.
  // These compound over time exactly like state session files.
  const outcomes = pruneDir(outcomesDir, cutoff, dryRun, (n) => n.endsWith('.jsonl'));

  // ADR-002 block-count directory — session-scoped per rule. F-M block-count GC.
  const blockCountDir = path.join(stateDir, 'enforcement', 'block-count');
  const blockCounters = pruneDir(blockCountDir, cutoff, dryRun, (n) => n.endsWith('.json'));

  return {
    scanned: state.scanned + outcomes.scanned + blockCounters.scanned,
    pruned: state.pruned + outcomes.pruned + blockCounters.pruned,
    bytesFreed: state.bytes + outcomes.bytes + blockCounters.bytes,
    retentionDays: Math.round(retentionMs / (24 * 60 * 60 * 1000)),
    dryRun,
    sample: [...state.sample, ...outcomes.sample, ...blockCounters.sample].slice(0, 20),
  };
}

/**
 * ADR-002 T4 — daily rule decay scanner.
 *
 * `~/.forgen/me/rules` 전체를 훑어 `last_inject_at < now - decay_days` 인 active rule 을
 * retire phase 로 전이시킨다. 실제 파일 삭제가 아니라 status='removed' + phase='retired'.
 *
 * 호출 지점: `forgen doctor --prune-state` 또는 `forgen lifecycle-scan --apply` 그리고
 * 별도 cron/CI scheduler 에서도 호출 가능. dryRun=true 기본.
 */
export async function runDailyT4Decay(opts: {
  decayDays?: number;
  dryRun?: boolean;
  now?: number;
} = {}): Promise<{ scanned: number; retired: number; sample: string[]; dryRun: boolean }> {
  const decayDays = opts.decayDays ?? 90;
  const dryRun = opts.dryRun ?? true;
  const now = opts.now ?? Date.now();

  try {
    const [{ loadAllRules, saveRule }, { detect: detectT4 }, { collectAllSignals }, { appendLifecycleEvents }, { foldEvents }] = await Promise.all([
      import('../store/rule-store.js'),
      import('../engine/lifecycle/trigger-t4-decay.js'),
      import('../engine/lifecycle/signals.js'),
      import('../engine/lifecycle/meta-reclassifier.js'),
      import('../engine/lifecycle/orchestrator.js'),
    ]);
    const rules = loadAllRules();
    const signals = collectAllSignals(rules, { now });
    const events = detectT4({ rules, signals, decay_days: decayDays, ts: now });
    const report = { scanned: rules.length, retired: events.length, sample: events.map((e) => e.rule_id.slice(0, 8)), dryRun };

    if (!dryRun && events.length > 0) {
      const folded = foldEvents(rules, events, now);
      for (const [id, updated] of folded.entries()) {
        const original = rules.find((r) => r.rule_id === id);
        if (!original || updated === original) continue;
        saveRule(updated);
      }
      appendLifecycleEvents(events, now);
    }
    return report;
  } catch {
    return { scanned: 0, retired: 0, sample: [], dryRun };
  }
}

/**
 * Count session-scoped files in STATE_DIR without deleting. Used by doctor
 * to surface a warning when the directory is bloated.
 */
export function countSessionScopedFiles(stateDir: string = STATE_DIR): number {
  if (!fs.existsSync(stateDir)) return 0;
  try {
    return fs.readdirSync(stateDir).filter(hasSessionPrefix).length;
  } catch {
    return 0;
  }
}
