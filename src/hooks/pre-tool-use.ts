#!/usr/bin/env node
/**
 * Forgen — PreToolUse Hook
 *
 * 도구 실행 전 위험 명령어 차단 및 컨텍스트 리마인더 주입.
 * - rm -rf, git push --force 등 위험 패턴 감지
 * - 활성 모드 상태 리마인더 주입
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../core/logger.js';

const log = createLogger('pre-tool-use');
import { HookError } from '../core/errors.js';
import { readStdinJSON } from './shared/read-stdin.js';
import { atomicWriteJSON } from './shared/atomic-write.js';
import { withFileLockSync, FileLockError } from './shared/file-lock.js';
import { sanitizeId } from './shared/sanitize-id.js';
import { incrementEvidence } from '../engine/solution-writer.js';
import { isReflectionCandidate } from './compound-reflection.js';
import { isHookEnabled } from './hook-config.js';
import { approve, approveWithWarning, deny, failOpenWithTracking } from './shared/hook-response.js';
import { FORGEN_HOME, STATE_DIR } from '../core/paths.js';
import { recordHookTiming } from './shared/hook-timing.js';
const FAIL_COUNTER_PATH = path.join(STATE_DIR, 'pre-tool-fail-counter.json');
const FAIL_CLOSE_THRESHOLD = 3; // 연속 3회 파싱 실패 시에만 reject

interface PreToolInput {
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  session_id?: string;
  cwd?: string;
}

interface DangerousPatternEntry {
  pattern: RegExp;
  description: string;
  severity: 'block' | 'warn';
}

/** RegExp 안전성 검증 (ReDoS 방지) — 매칭/비매칭 양쪽 모두 테스트 */
function isSafeRegex(pattern: string, flags: string): boolean {
  try {
    const re = new RegExp(pattern, flags);
    const testStr = 'a'.repeat(25);
    // 매칭 성공 케이스
    let start = Date.now();
    re.test(testStr);
    if (Date.now() - start >= 100) return false;
    // 매칭 실패 케이스 (ReDoS는 주로 여기서 발생)
    start = Date.now();
    re.test(`${testStr}!`);
    return Date.now() - start < 100;
  } catch {
    return false;
  }
}

/** JSON에서 패턴 로드 (패키지 내장 + 사용자 커스텀 병합) */
function loadDangerousPatterns(): DangerousPatternEntry[] {
  const results: DangerousPatternEntry[] = [];

  // 1. 패키지 내장 패턴 (dangerous-patterns.json)
  try {
    const builtinPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dangerous-patterns.json');
    const raw: Array<{ pattern: string; description: string; severity: string; flags?: string }> =
      JSON.parse(fs.readFileSync(builtinPath, 'utf-8'));
    for (const entry of raw) {
      if (!isSafeRegex(entry.pattern, entry.flags ?? '')) {
        log.debug(`내장 패턴 건너뜀 (ReDoS 위험): ${entry.description}`);
        continue;
      }
      results.push({
        pattern: new RegExp(entry.pattern, entry.flags ?? ''),
        description: entry.description,
        severity: entry.severity as 'block' | 'warn',
      });
    }
  } catch {
    // JSON 로드 실패 시 하드코딩 폴백 (최소 안전장치)
    results.push(
      { pattern: /rm\s+(-rf|-fr)\s+[/~]/, description: 'rm -rf on root/home path', severity: 'block' },
      { pattern: /curl\s+.*\|\s*(ba)?sh/, description: 'curl pipe to shell', severity: 'block' },
      { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, description: 'fork bomb', severity: 'block' },
    );
  }

  // 2. 사용자 커스텀 패턴 (~/.compound/dangerous-patterns.json)
  try {
    const customPath = path.join(FORGEN_HOME, 'dangerous-patterns.json');
    if (fs.existsSync(customPath)) {
      const custom: Array<{ pattern: string; description: string; severity: string; flags?: string }> =
        JSON.parse(fs.readFileSync(customPath, 'utf-8'));
      for (const entry of custom) {
        if (!isSafeRegex(entry.pattern, entry.flags ?? '')) {
          log.debug(`사용자 커스텀 패턴 건너뜀 (ReDoS 위험): ${entry.description}`);
          continue;
        }
        results.push({
          pattern: new RegExp(entry.pattern, entry.flags ?? ''),
          description: entry.description,
          severity: entry.severity as 'block' | 'warn',
        });
      }
    }
  } catch {
    log.debug('사용자 커스텀 위험 패턴 로드 실패');
  }

  return results;
}

/** 위험 Bash 명령어 패턴 (패키지 내장 + 사용자 커스텀 병합) */
export const DANGEROUS_PATTERNS: DangerousPatternEntry[] = loadDangerousPatterns();

const REMINDER_INTERVAL = 10; // 10회 호출당 1회 리마인더
const REMINDER_COUNTER_PATH = path.join(STATE_DIR, 'reminder-counter.json');

/** 위험 명령어 검사 (순수 함수) */
export function checkDangerousCommand(
  toolName: string,
  toolInput: Record<string, unknown> | string,
): { action: 'block' | 'warn' | 'pass'; description?: string; command?: string } {
  if (toolName !== 'Bash') return { action: 'pass' };

  const command = typeof toolInput === 'string'
    ? toolInput
    : (toolInput.command as string ?? '');

  for (const { pattern, description, severity } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { action: severity, description, command: command.slice(0, 100) };
    }
  }
  return { action: 'pass' };
}

/** 카운터 기반 리마인더 표시 여부 판정 (순수 함수 — I/O 없음) */
export function shouldShowReminder(count: number, interval: number = REMINDER_INTERVAL): boolean {
  return count > 0 && count % interval === 0;
}

/** 카운터 기반 리마인더 표시 여부 (I/O 포함 — main에서 사용) */
function shouldShowReminderIO(): boolean {
  try {
    let count: number;
    if (fs.existsSync(REMINDER_COUNTER_PATH)) {
      const data = JSON.parse(fs.readFileSync(REMINDER_COUNTER_PATH, 'utf-8'));
      count = (data.count ?? 0) + 1;
    } else {
      // 파일 없음 = 최초 호출: 1부터 시작하여 10번째 호출에 첫 리마인더 표시
      count = 1;
    }
    atomicWriteJSON(REMINDER_COUNTER_PATH, { count });
    return shouldShowReminder(count);
  } catch {
    return false;
  }
}

/** 활성 모드 상태를 리마인더로 수집 */
function getActiveReminders(): string[] {
  const reminders: string[] = [];

  if (!fs.existsSync(STATE_DIR)) return reminders;

  try {
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (!f.endsWith('-state.json') || f.startsWith('context-guard') || f.startsWith('skill-cache')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf-8'));
        if (data.active) {
          const mode = f.replace('-state.json', '');
          reminders.push(`[${mode}] mode active`);
        }
      } catch { /* skip corrupt files */ }
    }
  } catch (e) {
    log.debug('상태 디렉토리 읽기 실패', e);
  }

  return reminders;
}

/** 연속 파싱 실패 카운터 관리 */
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
  try { if (fs.existsSync(FAIL_COUNTER_PATH)) fs.unlinkSync(FAIL_COUNTER_PATH); } catch (e) { log.debug('fail counter reset failed — counter stays elevated', e); }
}

/**
 * Compound v3: detect if Edit/Write code reflects injected solution identifiers.
 *
 * false positive 방지를 위한 3중 필터 적용 (compound-reflection.ts):
 *   1. 시간 윈도우: 주입 후 15분 이내만 반영 인정
 *   2. 매칭 비율: 유효 식별자의 50% 이상 매칭 필요
 *   3. 공통 식별자 차단: 프레임워크 기본 용어 제외
 */
function checkCompoundReflection(toolName: string, toolInput: Record<string, unknown>, sessionId: string): void {
  if (toolName !== 'Edit' && toolName !== 'Write') return;

  const code = String(toolInput.new_string ?? toolInput.content ?? '');
  if (!code || code.length < 10) return;

  const cachePath = path.join(STATE_DIR, `injection-cache-${sanitizeId(sessionId)}.json`);
  if (!fs.existsSync(cachePath)) return;

  // PR2c-1 + M-2 fix: lock-narrowing.
  // cache lock 안에서는 cache 갱신(_sessionCounted 비트)만 수행하고,
  // evidence 갱신은 lock 밖에서 수행한다. 이전 구조는 cache lock을 잡은 채로
  // 매 솔루션마다 .md 파일 lock을 잡아서 cache lock holding time이 N×해졌고
  // 다른 hook이 cache lock을 잡지 못해 FileLockError가 빈발할 수 있었다.
  const reflectedNames: string[] = [];
  const newlySessionCounted: string[] = [];
  try {
    withFileLockSync(cachePath, () => {
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (!Array.isArray(cache.solutions)) return;

      const now = new Date();
      let mutated = false;

      for (const sol of cache.solutions) {
        const hasIdentifiers = Array.isArray(sol.identifiers) && sol.identifiers.length > 0;
        const hasTags = Array.isArray(sol.tags) && sol.tags.length > 0;

        if (!hasIdentifiers && !hasTags) continue;

        let reflected = false;

        if (hasIdentifiers) {
          const result = isReflectionCandidate({
            identifiers: sol.identifiers,
            code,
            injectedAt: sol.injectedAt ?? '',
            now,
          });
          reflected = result.reflected;
        }

        // Tag-based fallback: identifiers 없는 솔루션도 감지
        // 6자 이상 non-generic 태그 2개 이상이 코드에 출현하면 반영으로 인정
        if (!reflected && hasTags) {
          const genericTags = new Set(['pattern', 'solution', 'workflow', 'quality', 'best-practice', 'convention']);
          const eligibleTags = (sol.tags as string[]).filter(
            (t: string) => t.length >= 6 && !genericTags.has(t) && /^[a-zA-Z가-힣]/.test(t)
          );
          const matchedTagCount = eligibleTags.filter((t: string) => code.toLowerCase().includes(t.toLowerCase())).length;
          const injectedTime = new Date(sol.injectedAt ?? '').getTime();
          const elapsed = now.getTime() - injectedTime;
          if (matchedTagCount >= 2 && elapsed <= 15 * 60 * 1000 && elapsed >= 0) {
            reflected = true;
          }
        }

        if (reflected) {
          reflectedNames.push(sol.name);
          if (!sol._sessionCounted) {
            sol._sessionCounted = true;
            mutated = true;
            newlySessionCounted.push(sol.name);
          }
        }
      }

      if (mutated) {
        // mode 0o600 — solution-injector와 일관성
        atomicWriteJSON(cachePath, cache, { mode: 0o600, dirMode: 0o700 });
      }
    });
  } catch (e) {
    if (e instanceof FileLockError) {
      log.warn('compound reflection lock 실패 — write skipped', e);
    } else {
      log.debug('compound reflection 체크 실패', e);
    }
    return;
  }

  // Evidence 갱신은 lock 밖에서 (M-2 fix). solution-writer가 자체 lock을 가지므로 안전.
  for (const name of reflectedNames) {
    updateSolutionEvidence(name, 'reflected');
  }
  for (const name of newlySessionCounted) {
    updateSolutionEvidence(name, 'sessions');
  }
}

/**
 * Update evidence counter in a solution file.
 * PR2b: solution-writer.incrementEvidence로 위임. lock + fresh re-read + atomic write.
 *
 * Exported for use by solution-injector.
 */
export function updateSolutionEvidence(solutionName: string, field: 'reflected' | 'negative' | 'injected' | 'sessions' | 'reExtracted'): void {
  incrementEvidence(solutionName, field);
}

async function main(): Promise<void> {
  const _hookStart = Date.now();
  try {
  const data = await readStdinJSON<PreToolInput>();
  if (!data) {
    // graceful fail-close: consecutive failure counter.
    // At threshold, block with a user-visible deny message (the block itself
    // is actionable — the user needs to know why their tool call was
    // rejected). Below threshold, pass SILENTLY via plain approve() so a
    // transient parse glitch doesn't leak `systemMessage` noise to the
    // user's terminal on every tool call. stderr still gets the counter
    // for `forgen doctor` / log inspection. Mirrors `db-guard.ts:85-96`.
    const failCount = getAndIncrementFailCount();
    if (failCount >= FAIL_CLOSE_THRESHOLD) {
      console.log(deny(`[Forgen] PreToolUse: stdin parse failed ${failCount} consecutive times — blocking for safety.`));
    } else {
      process.stderr.write(`[ch-hook] pre-tool-use stdin parse failed (${failCount}/${FAIL_CLOSE_THRESHOLD})\n`);
      console.log(approve());
    }
    return;
  }
  // 정상 파싱 성공 시 연속 실패 카운터 리셋
  resetFailCount();

  if (!isHookEnabled('pre-tool-use')) {
    console.log(approve());
    return;
  }

  const toolName = data.tool_name ?? data.toolName ?? '';
  const toolInput = data.tool_input ?? data.toolInput ?? {};
  const sessionId = data.session_id ?? 'default';

  // ADR-001 Mech-A PreToolUse dispatcher — 사용자가 정의한 rule 이 빌트인 위험-명령 감지보다 먼저.
  // 이렇게 해야 rule.block_message (맥락 있는 안내) 가 제네릭 "Dangerous command blocked" 대신 노출됨.
  // fail-open: 예외는 hook 차단 안 함.
  try {
    const [
      { loadActiveRules },
      { recordViolation },
      { compileSafeRegex, safeRegexTest },
    ] = await Promise.all([
      import('../store/rule-store.js'),
      import('../engine/lifecycle/signals.js'),
      import('./shared/safe-regex.js'),
    ]);
    const rules = loadActiveRules();
    const command = typeof (toolInput as { command?: unknown }).command === 'string'
      ? String((toolInput as { command: string }).command)
      : '';
    for (const rule of rules) {
      for (const spec of rule.enforce_via ?? []) {
        if (spec.hook !== 'PreToolUse' || spec.mech !== 'A') continue;
        const v = spec.verifier;
        if (!v || v.kind !== 'tool_arg_regex') continue;
        const pattern = String(v.params?.pattern ?? '');
        if (!pattern) continue;
        const re = compileSafeRegex(pattern, 'i');
        if (!re.regex) { log.debug(`rule ${rule.rule_id} unsafe regex: ${re.reason}`); continue; }
        if (!safeRegexTest(re.regex, command)) continue;
        const requiresFlag = v.params?.requires_flag;
        const confirmed = process.env.FORGEN_USER_CONFIRMED === '1';
        if (requiresFlag && !confirmed) {
          recordViolation({ rule_id: rule.rule_id, session_id: sessionId, source: 'pre-tool-guard', kind: 'deny', message_preview: command.slice(0, 120) });
          const baseMsg = spec.block_message ?? `[${rule.rule_id}] policy violation: ${rule.policy.slice(0, 120)}`;
          // G8: override 힌트 — FORGEN_USER_CONFIRMED=1 으로 사용자 명시 승인 가능, 감사 로그 기록됨.
          const msgWithHint = `${baseMsg}\n\n(override: set FORGEN_USER_CONFIRMED=1 (bypass will be audited in violations.jsonl))`;
          console.log(deny(msgWithHint));
          return;
        }
        if (requiresFlag && confirmed) {
          // H3: 우회 감사 — FORGEN_USER_CONFIRMED 으로 Mech-A 를 우회할 때마다 violation 로그에
          // kind='correction' 으로 기록. T3 bypass 누적 대신 별도 채널로 운영자가 monitoring 가능.
          recordViolation({
            rule_id: rule.rule_id, session_id: sessionId,
            source: 'pre-tool-guard',
            kind: 'correction', // 'correction' = 사용자 명시 우회, rule 위반이지만 의도된 것
            message_preview: `[FORGEN_USER_CONFIRMED=1 bypass] ${command.slice(0, 120)}`,
          });
        }
      }
    }
  } catch (e) { log.debug('enforce_via[PreToolUse] dispatch 실패', e); }

  // Bash 도구: 위험 명령어 감지 (빌트인 safety net)
  const check = checkDangerousCommand(toolName, toolInput);
  if (check.action === 'block') {
    console.log(deny(`[Forgen] Dangerous command blocked: ${check.description}\nCommand: ${check.command}`));
    return;
  }
  if (check.action === 'warn') {
    console.log(approveWithWarning(`<compound-tool-warning>\n[Forgen] ⚠ Dangerous command detected: ${check.description}\nProceed with caution.\n</compound-tool-warning>`));
    return;
  }

  // Output size guard: warn when Grep is used without head_limit
  if (toolName === 'Grep' && !toolInput?.head_limit) {
    console.log(approveWithWarning(`<compound-tool-warning>\n[Forgen] Grep without head_limit may produce large output. Set head_limit or pipe through | head -n to limit output size.\n</compound-tool-warning>`));
    return;
  }

  // Compound v3: Code Reflection check (non-blocking)
  try { checkCompoundReflection(toolName, toolInput, sessionId); } catch (e) { log.debug('compound reflection check 실패', e); }

  // 활성 모드 리마인더 (10회 호출당 1회 — 결정적 카운터 기반)
  // P0-4 fix (2026-04-20): 과거에는 getActiveReminders()로 STATE_DIR을 먼저
  // readdir + N회 readFileSync한 뒤에야 shouldShowReminderIO 카운터를 체크했다.
  // 그래서 "리마인더를 보여줄 호출이 아닌" 90%에서도 디렉터리 스캔이 발생.
  // 이제 shouldShowReminderIO를 먼저 체크해 표시 회차일 때만 스캔한다.
  if (shouldShowReminderIO()) {
    const reminders = getActiveReminders();
    if (reminders.length > 0) {
      console.log(approveWithWarning(`<compound-reminder>\n${reminders.join('\n')}\n</compound-reminder>`));
      return;
    }
  }

  console.log(approve());
  } finally {
    recordHookTiming('pre-tool-use', Date.now() - _hookStart, 'PreToolUse');
  }
}

main().catch((e) => {
  const hookErr = new HookError(e instanceof Error ? e.message : String(e), {
    hookName: 'pre-tool-use', eventType: 'PreToolUse', cause: e,
  });
  process.stderr.write(`[ch-hook] ${hookErr.name}: ${hookErr.message}\n`);
  // fail-open: approve on internal error to avoid blocking all tool calls
  console.log(failOpenWithTracking('pre-tool-use'));
});
