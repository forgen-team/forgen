import * as fs from 'node:fs';
import * as path from 'node:path';
import { OUTCOMES_DIR, STATE_DIR } from '../core/paths.js';
import { sanitizeId } from '../hooks/shared/sanitize-id.js';
import { withFileLockSync, FileLockError } from '../hooks/shared/file-lock.js';
import { atomicWriteJSON } from '../hooks/shared/atomic-write.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('solution-outcomes');

export type Outcome = 'accept' | 'correct' | 'error' | 'unknown';
export type Attribution = 'explicit' | 'window' | 'session_end' | 'default';

/**
 * One inject → outcome event. Written append-only to
 * ~/.forgen/state/outcomes/{session_id}.jsonl. The pending state (inject
 * happened, outcome not yet decided) is stored separately in
 * ~/.forgen/state/outcome-pending-{session_id}.json.
 */
export interface OutcomeEvent {
  ts: number;
  session_id: string;
  solution: string;
  match_score: number;
  injected_chars: number;
  outcome: Outcome;
  outcome_lag_ms: number;
  attribution: Attribution;
}

interface PendingEntry {
  solution: string;
  ts: number;
  match_score: number;
  injected_chars: number;
}

interface PendingState {
  pending: PendingEntry[];
  last_prompt_ts: number;
}

function pendingPath(sessionId: string): string {
  return path.join(STATE_DIR, `outcome-pending-${sanitizeId(sessionId)}.json`);
}

function outcomesPath(sessionId: string): string {
  return path.join(OUTCOMES_DIR, `${sanitizeId(sessionId)}.jsonl`);
}

function readPending(sessionId: string): PendingState {
  const p = pendingPath(sessionId);
  if (!fs.existsSync(p)) return { pending: [], last_prompt_ts: 0 };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as PendingState;
  } catch {
    return { pending: [], last_prompt_ts: 0 };
  }
}

function writePending(sessionId: string, state: PendingState): void {
  const p = pendingPath(sessionId);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  atomicWriteJSON(p, state, { mode: 0o600, dirMode: 0o700 });
}

function appendOutcome(event: OutcomeEvent): void {
  fs.mkdirSync(OUTCOMES_DIR, { recursive: true });
  fs.appendFileSync(outcomesPath(event.session_id), JSON.stringify(event) + '\n');
}

/**
 * Run a read-modify-write pending-state mutation under a file lock
 * (2026-04-21 audit fix #9).
 *
 * Prior code (`readPending` → in-memory mutate → `writePending`) was not
 * serialised, so inject + correction + error hooks racing on the same
 * session could lose or duplicate outcome events. The entire critical
 * section now sits inside `withFileLockSync`; the lock file lives next
 * to the pending file itself. A lock-acquire failure falls through
 * fail-open (outcome tracking must never block the user).
 */
function mutatePending<T>(sessionId: string, fn: () => T): T | null {
  const p = pendingPath(sessionId);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    let result: T | null = null;
    withFileLockSync(p, () => {
      result = fn();
    });
    return result;
  } catch (e) {
    if (e instanceof FileLockError) {
      log.debug(`pending lock 실패 — skip (fail-open): ${e.message}`);
      return null;
    }
    throw e;
  }
}

/**
 * Record that solutions were injected. Called from solution-injector right
 * after `approveWithContext` is emitted. Fails silently — outcome tracking
 * must never block the user's workflow.
 */
export function appendPending(
  sessionId: string,
  injections: Array<{ solution: string; match_score: number; injected_chars: number }>,
): void {
  if (!sessionId || injections.length === 0) return;
  try {
    mutatePending(sessionId, () => {
      const state = readPending(sessionId);
      const ts = Date.now();
      for (const inj of injections) {
        state.pending.push({ ...inj, ts });
      }
      writePending(sessionId, state);
    });
  } catch (e) {
    log.debug(`appendPending failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Flush pending injections as `accept` events. Called when a new user
 * prompt arrives without any intervening correction/error, signaling that
 * the previous injections were silently accepted. "Silence = consent."
 *
 * If `excludeSolutions` is provided, those solutions are NOT flushed (e.g.
 * because an earlier step already attributed them as `correct` or `error`).
 */
export function flushAccept(sessionId: string, excludeSolutions: Set<string> = new Set()): number {
  if (!sessionId) return 0;
  try {
    const result = mutatePending<number>(sessionId, () => {
      const state = readPending(sessionId);
      if (state.pending.length === 0) return 0;
      const now = Date.now();
      const kept: PendingEntry[] = [];
      let flushed = 0;
      for (const p of state.pending) {
        // P1-L1 fix (2026-04-20): 이전에는 excluded pending을 `continue`로 건너뛰면서
        // `kept`에도 push 안 하고 appendOutcome도 안 해서 증거 없이 사라졌다.
        // 이미 correct/error로 attribute된 항목은 보존 (나중 prompt에서 재처리 방지).
        if (excludeSolutions.has(p.solution)) {
          kept.push(p);
          continue;
        }
        appendOutcome({
          ts: now,
          session_id: sessionId,
          solution: p.solution,
          match_score: p.match_score,
          injected_chars: p.injected_chars,
          outcome: 'accept',
          outcome_lag_ms: now - p.ts,
          attribution: 'default',
        });
        flushed++;
      }
      writePending(sessionId, { pending: kept, last_prompt_ts: now });
      return flushed;
    });
    return result ?? 0;
  } catch (e) {
    log.debug(`flushAccept failed: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

/**
 * Attribute a correction to the most recent pending injection(s). Called
 * from the correction-record MCP tool. Removes attributed entries from
 * pending so subsequent `flushAccept` does not double-count them.
 *
 * Strategy: all currently-pending solutions in this session are marked as
 * `correct`. This is conservative (the correction may target only one of
 * them), but without semantic attribution we err on the side of the user's
 * feedback signal being louder than acceptance.
 */
export function attributeCorrection(sessionId: string): string[] {
  if (!sessionId) return [];
  try {
    const result = mutatePending<string[]>(sessionId, () => {
      const state = readPending(sessionId);
      if (state.pending.length === 0) return [];
      const now = Date.now();
      const attributed: string[] = [];
      for (const p of state.pending) {
        appendOutcome({
          ts: now,
          session_id: sessionId,
          solution: p.solution,
          match_score: p.match_score,
          injected_chars: p.injected_chars,
          outcome: 'correct',
          outcome_lag_ms: now - p.ts,
          attribution: 'explicit',
        });
        attributed.push(p.solution);
      }
      writePending(sessionId, { pending: [], last_prompt_ts: state.last_prompt_ts });
      return attributed;
    });
    return result ?? [];
  } catch (e) {
    log.debug(`attributeCorrection failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Attribution gates for error events (2026-04-21 fix):
 *   - MIN_ERROR_MATCH_SCORE: solutions injected on thin relevance (< 0.3)
 *     are unlikely to have caused unrelated tool failures. Attributing
 *     error to them distorts fitness and poisons the Phase 4 evolver.
 *   - MAX_ATTRIBUTION_LAG_MS: errors more than 5 minutes after injection
 *     are too temporally distant — the user has likely moved on to work
 *     the solution has no bearing on.
 *   - MAX_ATTRIBUTED_PER_ERROR: cap at the top 3 most-relevant pending
 *     solutions so a broad inject batch doesn't scatter false blame.
 *
 * Data audit (2026-04-21, ~/.forgen/state/outcomes/ 260 sessions):
 *   Top-3 "error" solutions = 80% of all error events, injected at score
 *   0.15/0.21 nearly every session. Without these gates, fitness
 *   classification drags good-but-low-score solutions into underperform.
 */
const MIN_ERROR_MATCH_SCORE = 0.3;
const MAX_ATTRIBUTION_LAG_MS = 5 * 60 * 1000;
const MAX_ATTRIBUTED_PER_ERROR = 3;

/**
 * Attribute a tool error to pending solutions in this session. Called from
 * post-tool-failure hook. Unlike corrections, errors do not clear pending
 * — an error is a weaker signal and the next user prompt can still produce
 * a correct/accept decision.
 *
 * Only the top-K most-relevant, recent, above-threshold pending solutions
 * are attributed (see gates above). Below-threshold or stale pending
 * entries are left untouched — they will resolve via accept/unknown later.
 *
 * To avoid flooding the log with duplicate errors for the same pending
 * batch, we cap at one `error` event per (session, solution) pair per
 * pending-cycle by tracking a `error_flagged` set in the pending state.
 */
export function attributeError(sessionId: string): string[] {
  if (!sessionId) return [];
  try {
    const result = mutatePending<string[]>(sessionId, () => {
      const state = readPending(sessionId);
      if (state.pending.length === 0) return [];
      const flaggedKey = `__error_flagged` as const;
      const existing = (state as unknown as Record<string, unknown>)[flaggedKey];
      const flagged = new Set<string>(Array.isArray(existing) ? (existing as string[]) : []);
      const now = Date.now();

      const eligible = state.pending
        .filter((p) => !flagged.has(p.solution))
        .filter((p) => p.match_score >= MIN_ERROR_MATCH_SCORE)
        .filter((p) => now - p.ts <= MAX_ATTRIBUTION_LAG_MS)
        .sort((a, b) => b.match_score - a.match_score)
        .slice(0, MAX_ATTRIBUTED_PER_ERROR);

      const flaggedThisCall: string[] = [];
      for (const p of eligible) {
        appendOutcome({
          ts: now,
          session_id: sessionId,
          solution: p.solution,
          match_score: p.match_score,
          injected_chars: p.injected_chars,
          outcome: 'error',
          outcome_lag_ms: now - p.ts,
          attribution: 'window',
        });
        flagged.add(p.solution);
        flaggedThisCall.push(p.solution);
      }
      (state as unknown as Record<string, unknown>)[flaggedKey] = Array.from(flagged);
      writePending(sessionId, state);
      return flaggedThisCall;
    });
    return result ?? [];
  } catch (e) {
    log.debug(`attributeError failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * At session end, any still-pending entries are logged as `unknown` (we
 * can't tell if the user was happy or just stopped). Pending file is
 * removed.
 */
export function finalizeSession(sessionId: string): number {
  if (!sessionId) return 0;
  try {
    const result = mutatePending<number>(sessionId, () => {
      const state = readPending(sessionId);
      const now = Date.now();
      let finalized = 0;
      for (const p of state.pending) {
        appendOutcome({
          ts: now,
          session_id: sessionId,
          solution: p.solution,
          match_score: p.match_score,
          injected_chars: p.injected_chars,
          outcome: 'unknown',
          outcome_lag_ms: now - p.ts,
          attribution: 'session_end',
        });
        finalized++;
      }
      const pendingFile = pendingPath(sessionId);
      if (fs.existsSync(pendingFile)) fs.unlinkSync(pendingFile);
      return finalized;
    });
    return result ?? 0;
  } catch (e) {
    log.debug(`finalizeSession failed: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

/**
 * Read all outcome events across all sessions. Used by fitness
 * calculation. Returns events sorted by timestamp ascending.
 */
export function readAllOutcomes(): OutcomeEvent[] {
  if (!fs.existsSync(OUTCOMES_DIR)) return [];
  const events: OutcomeEvent[] = [];
  for (const file of fs.readdirSync(OUTCOMES_DIR)) {
    if (!file.endsWith('.jsonl')) continue;
    try {
      const text = fs.readFileSync(path.join(OUTCOMES_DIR, file), 'utf-8');
      for (const line of text.split('\n')) {
        if (!line) continue;
        try { events.push(JSON.parse(line) as OutcomeEvent); }
        catch { /* skip bad line */ }
      }
    } catch { /* skip */ }
  }
  events.sort((a, b) => a.ts - b.ts);
  return events;
}
