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

/**
 * `claude-mem status` 출력 → 실행 중인가.
 * 꺼져 있을 때의 출력은 "Worker is not running" 이다 — 'running' 포함 여부만 보면 꺼진 워커를
 * 실행 중으로 판정한다 (0.5.9 수정, claude-mem 13.12.4/13.28.0 실측).
 */
export function parseWorkerRunning(statusOutput: string): boolean {
  const out = statusOutput.toLowerCase();
  if (/\bnot running\b|\bstopped\b|\bnot started\b/.test(out)) return false;
  return out.includes('running');
}

export function workerStatus(): WorkerStatus {
  try {
    const out = execSync('npx --no-install claude-mem status', { encoding: 'utf-8', stdio: 'pipe' });
    return { running: parseWorkerRunning(out), detail: out.trim() };
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

/**
 * forgen-eval 이 CLI 계약(version/start/status/stop/search 출력, DB 컬럼)을 실측한 claude-mem 버전.
 * package.json 의 devDependency 핀과 같아야 한다 (tests/mem-contract.test.ts 가 강제 — 이전엔 핀만 올라가고
 * 이 상수는 12.4.8 에 머물러 매 실행마다 "version mismatch" 경고가 났다).
 */
export const CLAUDE_MEM_TESTED_VERSION = '13.28.0';

export function checkVersionPin(): { ok: boolean; actual: string | null; tested: string } {
  const actual = detectClaudeMemVersion();
  return {
    ok: actual?.includes(CLAUDE_MEM_TESTED_VERSION) ?? false,
    actual,
    tested: CLAUDE_MEM_TESTED_VERSION,
  };
}
