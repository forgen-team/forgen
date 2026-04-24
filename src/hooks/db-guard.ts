#!/usr/bin/env node
/**
 * Forgen — PreToolUse: DB Guard Hook
 *
 * Bash 도구 실행 전 위험한 SQL 명령어를 감지하여 차단 또는 경고합니다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readStdinJSON } from './shared/read-stdin.js';
import { atomicWriteJSON } from './shared/atomic-write.js';
import { isHookEnabled } from './hook-config.js';
import { approve, approveWithWarning, deny, failOpenWithTracking } from './shared/hook-response.js';
import { STATE_DIR } from '../core/paths.js';
import { preprocessForMatch } from './shared/command-parser.js';
const FAIL_COUNTER_PATH = path.join(STATE_DIR, 'db-guard-fail-counter.json');
const FAIL_CLOSE_THRESHOLD = 3;

interface PreToolInput {
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
}

export interface SqlPattern {
  pattern: RegExp;
  description: string;
  severity: 'block' | 'warn';
}

export const DANGEROUS_SQL_PATTERNS: SqlPattern[] = [
  { pattern: /DROP\s+(TABLE|DATABASE|SCHEMA)/i, description: 'DROP TABLE/DATABASE/SCHEMA', severity: 'block' },
  { pattern: /TRUNCATE\s+TABLE/i, description: 'TRUNCATE TABLE', severity: 'block' },
  { pattern: /DELETE\s+FROM\s+\w+/i, description: 'DELETE FROM (WHERE clause required)', severity: 'block' },
  { pattern: /ALTER\s+TABLE\s+\w+\s+DROP\s+COLUMN/i, description: 'ALTER TABLE DROP COLUMN', severity: 'warn' },
  { pattern: /UPDATE\s+\w+\s+SET/i, description: 'UPDATE SET (WHERE clause required)', severity: 'warn' },
];

/** SQL 명령어 위험도 검사 (순수 함수) */
export function checkDangerousSql(
  toolName: string,
  toolInput: Record<string, unknown> | string,
): { action: 'block' | 'warn' | 'pass'; description?: string } {
  if (toolName !== 'Bash') return { action: 'pass' };

  const command = typeof toolInput === 'string'
    ? toolInput
    : (toolInput.command as string ?? '');

  // TEST-6 확장 (2026-04-24): DB CLI allowlist 기반 quote-aware 전처리.
  //
  // 결함: 이전에는 raw command 를 직접 매칭해 `git commit -m "... DROP TABLE ..."`
  // 같은 quote 안 SQL 키워드까지 block (실증: 이번 세션 내 release 커밋 메시지 차단).
  //
  // 단순히 masked 만 쓰면 `psql -c "DROP TABLE users"` 같은 실 DB 실행의 True-Positive
  // 까지 놓친다. 해법: masked 처리 후에도 **DB CLI 토큰** 이 보이면 진짜 실행 의도
  // 라고 판단해 raw 를 검사, 아니면 masked 를 검사.
  //   - `psql -c "DROP TABLE"` → masked: `psql -c ""` → psql 존재 → raw 검사 → block
  //   - `git commit -m "DROP TABLE"` → masked: `git commit -m ""` → psql 없음 → masked 검사 → pass
  //   - `DROP DATABASE production` (direct SQL) → masked 그대로 (quote 없음) → block
  const maskedCommand = preprocessForMatch(command, 'masked');
  const dbCliRe = /\b(psql|mysql|sqlite3?|pg_restore|mongosh|mysqldump|cockroach\s+sql|redis-cli)\b/i;
  const hasDbCli = dbCliRe.test(maskedCommand);
  const scanCommand = hasDbCli ? command : maskedCommand;

  // 주석 제거 후 SQL에 대해 패턴 매칭 (주석 안 키워드 오차단 방지)
  const sqlWithoutComments = scanCommand
    .replace(/--[^\n]*/g, '')           // 라인 주석 제거
    .replace(/\/\*[\s\S]*?\*\//g, '');  // 블록 주석 제거

  for (const { pattern, description, severity } of DANGEROUS_SQL_PATTERNS) {
    if (pattern.test(sqlWithoutComments)) {
      // DELETE/UPDATE — SQL 본문에서 WHERE 절이 있으면 통과
      if (/DELETE\s+FROM/i.test(sqlWithoutComments) && /\bWHERE\s+/i.test(sqlWithoutComments)) continue;
      if (/UPDATE\s+\w+\s+SET/i.test(sqlWithoutComments) && /\bWHERE\s+/i.test(sqlWithoutComments)) continue;
      return { action: severity, description };
    }
  }
  return { action: 'pass' };
}

/** 연속 파싱 실패 카운터 */
function getAndIncrementFailCount(): number {
  try {
    let count = 0;
    if (fs.existsSync(FAIL_COUNTER_PATH)) {
      const data = JSON.parse(fs.readFileSync(FAIL_COUNTER_PATH, 'utf-8'));
      count = (data.count ?? 0) + 1;
    } else {
      count = 1;
    }
    atomicWriteJSON(FAIL_COUNTER_PATH, { count, updatedAt: new Date().toISOString() });
    return count;
  } catch { return 1; }
}

function resetFailCount(): void {
  try { if (fs.existsSync(FAIL_COUNTER_PATH)) fs.unlinkSync(FAIL_COUNTER_PATH); } catch { /* fail counter reset failed — counter stays elevated but next parse success resets it */ }
}

async function main(): Promise<void> {
  const data = await readStdinJSON<PreToolInput>();
  if (!data) {
    const failCount = getAndIncrementFailCount();
    if (failCount >= FAIL_CLOSE_THRESHOLD) {
      console.log(deny(`[Forgen] DB Guard: stdin parse failed ${failCount} consecutive times — blocking for safety.`));
    } else {
      process.stderr.write(`[ch-hook] db-guard stdin parse failed (${failCount}/${FAIL_CLOSE_THRESHOLD})\n`);
      console.log(approve());
    }
    return;
  }
  resetFailCount();

  if (!isHookEnabled('db-guard')) {
    console.log(approve());
    return;
  }

  const toolName = data.tool_name ?? data.toolName ?? '';
  const toolInput = data.tool_input ?? data.toolInput ?? {};

  const check = checkDangerousSql(toolName, toolInput);
  if (check.action === 'block') {
    console.log(deny(`[Forgen] Dangerous SQL blocked: ${check.description}`));
    return;
  }
  if (check.action === 'warn') {
    console.log(approveWithWarning(`<compound-sql-warning>\n[Forgen] ⚠ Dangerous SQL detected: ${check.description}\nProceed with caution.\n</compound-sql-warning>`));
    return;
  }

  console.log(approve());
}

main().catch((e) => {
  process.stderr.write(`[ch-hook] DB Guard error: ${e instanceof Error ? e.message : String(e)}\n`);
  console.log(failOpenWithTracking('db-guard', e));
});
