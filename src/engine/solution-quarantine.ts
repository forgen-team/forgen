import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { SOLUTION_QUARANTINE_PATH, STATE_DIR } from '../core/paths.js';
import { diagnoseFrontmatter } from './solution-format.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('solution-quarantine');

interface QuarantineEntry {
  path: string;
  at: string;
  errors: string[];
}

/**
 * Produce actionable frontmatter diagnostics directly from file content.
 *
 * This duplicates the YAML parse that `parseFrontmatterOnly` already does,
 * but it runs only on the rare failure path (solution dropped from index),
 * so the overhead is acceptable in exchange for a human-readable error list.
 */
export function diagnoseFromRawContent(content: string): string[] {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return ['no YAML frontmatter (missing leading ---)'];
  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) return ['frontmatter not closed (missing trailing ---)'];
  const raw = trimmed.slice(3, endIdx);
  if (raw.length > 5000) return ['frontmatter too large (>5000 chars — YAML bomb guard)'];
  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch (e) {
    return [`YAML parse error: ${e instanceof Error ? e.message : String(e)}`];
  }
  return diagnoseFrontmatter(parsed);
}

/**
 * Append one quarantine entry for `filePath`. Deduped by path within the
 * current file: if the latest entry for this path already matches the
 * current errors, skip the append.
 *
 * Storage: one JSONL line per quarantine event. Readers use only the
 * latest line per path.
 */
export function recordQuarantine(filePath: string, errors: string[]): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    if (dedupeHit(filePath, errors)) return;
    const entry: QuarantineEntry = {
      path: filePath,
      at: new Date().toISOString(),
      errors,
    };
    fs.appendFileSync(SOLUTION_QUARANTINE_PATH, JSON.stringify(entry) + '\n');
  } catch (e) {
    log.debug(`quarantine write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function dedupeHit(filePath: string, errors: string[]): boolean {
  if (!fs.existsSync(SOLUTION_QUARANTINE_PATH)) return false;
  try {
    const text = fs.readFileSync(SOLUTION_QUARANTINE_PATH, 'utf-8');
    const lines = text.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let prev: QuarantineEntry;
      try { prev = JSON.parse(lines[i]) as QuarantineEntry; } catch { continue; }
      if (prev.path !== filePath) continue;
      if (sameErrors(prev.errors, errors)) return true;
      return false;
    }
  } catch { /* ignore */ }
  return false;
}

function sameErrors(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

/**
 * Read the latest quarantine state: one entry per path, keyed to the most
 * recent append. Entries whose file no longer exists are dropped.
 */
export function listQuarantined(): QuarantineEntry[] {
  if (!fs.existsSync(SOLUTION_QUARANTINE_PATH)) return [];
  let text: string;
  try { text = fs.readFileSync(SOLUTION_QUARANTINE_PATH, 'utf-8'); }
  catch { return []; }
  const byPath = new Map<string, QuarantineEntry>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as QuarantineEntry;
      byPath.set(entry.path, entry);
    } catch { /* skip bad line */ }
  }
  const result: QuarantineEntry[] = [];
  for (const entry of byPath.values()) {
    try { if (fs.existsSync(entry.path)) result.push(entry); }
    catch { /* skip */ }
  }
  return result;
}

/**
 * Clear quarantine entries for files that now parse correctly or no longer
 * exist. Intended to be called after `forgen learn fix-up` or a manual edit.
 */
export function pruneQuarantine(): { removed: number; kept: number } {
  if (!fs.existsSync(SOLUTION_QUARANTINE_PATH)) return { removed: 0, kept: 0 };
  // Read raw entries without listQuarantined's existsSync filter so we can
  // count deleted files as removed rather than silently dropping them.
  const byPath = new Map<string, QuarantineEntry>();
  try {
    const text = fs.readFileSync(SOLUTION_QUARANTINE_PATH, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as QuarantineEntry;
        byPath.set(entry.path, entry);
      } catch { /* skip bad line */ }
    }
  } catch { /* empty */ }

  const stillBad: QuarantineEntry[] = [];
  let removed = 0;
  for (const entry of byPath.values()) {
    let content: string;
    try {
      content = fs.readFileSync(entry.path, 'utf-8');
    } catch {
      removed++;
      continue;
    }
    const errors = diagnoseFromRawContent(content);
    if (errors.length === 0) { removed++; continue; }
    stillBad.push({ ...entry, errors });
  }
  const dir = path.dirname(SOLUTION_QUARANTINE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const text = stillBad.map((e) => JSON.stringify(e)).join('\n') + (stillBad.length ? '\n' : '');
  fs.writeFileSync(SOLUTION_QUARANTINE_PATH, text);
  return { removed, kept: stillBad.length };
}
