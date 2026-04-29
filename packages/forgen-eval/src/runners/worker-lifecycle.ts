/**
 * claude-mem worker lifecycle for testbed (US-021).
 * ADR-004 amendment §신규 위험: worker가 transcript watcher → race condition 회피.
 */

import { execSync } from 'node:child_process';

export interface WorkerStatus {
  running: boolean;
  detail: string;
}

export function startWorker(): WorkerStatus {
  try {
    const out = execSync('npx --no-install claude-mem start', { encoding: 'utf-8', stdio: 'pipe' });
    return { running: true, detail: out.trim() };
  } catch (err) {
    return { running: false, detail: (err as Error).message };
  }
}

export function stopWorker(): WorkerStatus {
  try {
    const out = execSync('npx --no-install claude-mem stop', { encoding: 'utf-8', stdio: 'pipe' });
    return { running: false, detail: out.trim() };
  } catch (err) {
    return { running: false, detail: (err as Error).message };
  }
}

export function workerStatus(): WorkerStatus {
  try {
    const out = execSync('npx --no-install claude-mem status', { encoding: 'utf-8', stdio: 'pipe' });
    return { running: out.toLowerCase().includes('running'), detail: out.trim() };
  } catch (err) {
    return { running: false, detail: (err as Error).message };
  }
}

export function detectClaudeMemVersion(): string | null {
  try {
    return execSync('npx --no-install claude-mem version', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return null;
  }
}

export const CLAUDE_MEM_TESTED_VERSION = '12.4.8';

export function checkVersionPin(): { ok: boolean; actual: string | null; tested: string } {
  const actual = detectClaudeMemVersion();
  return {
    ok: actual?.includes(CLAUDE_MEM_TESTED_VERSION) ?? false,
    actual,
    tested: CLAUDE_MEM_TESTED_VERSION,
  };
}
