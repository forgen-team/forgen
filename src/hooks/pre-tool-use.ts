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
import { stripPrivate } from '../engine/private-filter.js';
import { isHookEnabled } from './hook-config.js';
import { approve, approveWithWarning, ask, denyOrObserve, failOpenWithTracking } from './shared/hook-response.js';
import { FORGEN_HOME, STATE_DIR } from '../core/paths.js';
import { recordHookTiming } from './shared/hook-timing.js';
import { maskQuotedContent } from './shared/command-parser.js';
import { analyzeCommand, worstFinding, MAX_COMMAND_LENGTH } from './shared/command-analyzer.js';
import { checkGitSecretsBudgeted } from './shared/commit-guard.js';
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
  /**
   * match_target (v0.4.1): 'masked' (default) — quote/heredoc 본문 제거 후 매칭.
   *   실 shell 실행 토큰 검사에 적합. 'raw' — 원본 command 그대로 매칭.
   *   `python -c "..."`, `eval "..."` 처럼 **quote 안 본문이 실제 payload 로 실행**
   *   되는 패턴에 사용.
   */
  matchTarget?: 'raw' | 'masked';
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
    const raw: Array<{ pattern: string; description: string; severity: string; flags?: string; match_target?: string }> =
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
        matchTarget: entry.match_target === 'raw' ? 'raw' : 'masked',
      });
    }
  } catch {
    // JSON 로드 실패 시 하드코딩 폴백 (최소 안전장치). 나머지 위험 명령은 command-analyzer 가 담당.
    results.push(
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

const DELETE_FINDING_IDS: ReadonlySet<string> = new Set(['rm-recursive', 'find-delete', 'find-exec-rm', 'script-delete']);
const REMINDER_INTERVAL = 10; // 10회 호출당 1회 리마인더
const REMINDER_COUNTER_PATH = path.join(STATE_DIR, 'reminder-counter.json');

/**
 * 위험 명령어 검사 (순수 함수).
 *
 * D12-A: 명령 문자열 전체에 정규식을 대던 방식을 버리고 command-analyzer 의 실제 파싱 결과를 쓴다.
 *  - block: 되돌릴 수 없는 파괴(루트/홈 재귀 삭제, mkfs, 장치 쓰기, 다운로드→셸) — 항상 차단
 *  - ask  : 오너 룰 "사용자 확인 없는 rm -rf 금지" — 임시(claude-*) 경로가 아닌 재귀 삭제는 확인을 요청
 *  - warn : 정책 유지(git reset --hard, git clean -f, force push, chmod 777, eval)
 * 정규식 테이블(dangerous-patterns.json + 사용자 커스텀)은 파서가 모르는 잔여 패턴(fork bomb 등)에만 쓴다.
 */
/**
 * ask 응답 문구 꼬리 — 비대화형(`claude -p`, CI)에서는 승인해 줄 사람이 없다. 호스트가 ask 를 지원하지 않아
 * deny 로 투영되는 경우(Codex/OpenCode)에도 같은 안내가 사유에 실려 간다.
 */
export const ASK_NONINTERACTIVE_HINT = '비대화형(claude -p/CI)이면 승인할 사람이 없습니다 — 의도한 작업이면 FORGEN_USER_CONFIRMED=1 을 설정해 다시 실행하세요 (우회는 violations.jsonl 에 기록됨).';

export function checkDangerousCommand(
  toolName: string,
  toolInput: Record<string, unknown> | string,
  cwd?: string,
): { action: 'block' | 'ask' | 'warn' | 'pass'; description?: string; command?: string; ruleId?: string } {
  if (toolName !== 'Bash') return { action: 'pass' };

  const command = typeof toolInput === 'string'
    ? toolInput
    : (toolInput.command as string ?? '');

  // 상한 초과는 정규식 경로(이차 시간 위험)까지 가지 않고 곧바로 확인 요청 — 시간 초과로 fail-open 되지 않게.
  if (command.length > MAX_COMMAND_LENGTH) {
    return { action: 'ask', description: `command too long to analyze (${command.length} > ${MAX_COMMAND_LENGTH} chars)`, command: command.slice(0, 100), ruleId: 'builtin:analysis-limit' };
  }
  const analysis = analyzeCommand(command, { cwd });
  const worst = worstFinding(analysis.findings);

  const maskedCommand = maskQuotedContent(command);
  let regexWarn: { description: string } | null = null;
  for (const { pattern, description, severity, matchTarget } of DANGEROUS_PATTERNS) {
    const target = matchTarget === 'raw' ? command : maskedCommand;
    if (!pattern.test(target)) continue;
    if (severity === 'block') return { action: 'block', description, command: command.slice(0, 100) };
    regexWarn ??= { description };
  }
  // SQL: db-guard 와 같은 분석기 기준(실행 문맥의 SQL 텍스트만). 이전 정규식 테이블의 drop/truncate 항목을 대체.
  for (const text of analysis.sqlTexts) {
    if (/drop\s+(?:table|database)/i.test(text)) return { action: 'block', description: 'DROP TABLE/DATABASE', command: command.slice(0, 100) };
  }
  if (worst && (worst.action === 'block' || worst.action === 'deny')) {
    return { action: 'block', description: worst.description, command: command.slice(0, 100), ruleId: `builtin:${worst.id}` };
  }
  if (worst?.action === 'ask') return { action: 'ask', description: worst.description, command: command.slice(0, 100), ruleId: `builtin:${worst.id}` };
  if (worst?.action === 'warn') return { action: 'warn', description: worst.description, command: command.slice(0, 100) };
  if (analysis.sqlTexts.some((t) => /truncate\s+table/i.test(t))) return { action: 'warn', description: 'TRUNCATE TABLE', command: command.slice(0, 100) };
  if (regexWarn) return { action: 'warn', description: regexWarn.description, command: command.slice(0, 100) };
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
function getActiveReminders(sessionId: string): string[] {
  const reminders: string[] = [];

  if (!fs.existsSync(STATE_DIR)) return reminders;

  try {
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (!f.endsWith('-state.json') || f.startsWith('context-guard') || f.startsWith('skill-cache')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf-8'));
        // H6: 다른 세션이 켠 모드를 이 세션의 리마인더로 보여주지 않는다.
        if (data.active && data.sessionId === sessionId) {
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

/**
 * Tool-call supplement log (ADR-008 / docs/codex-integration.md).
 *
 * Codex `approval_policy=auto`/`workspace-write` 환경에서 PermissionRequest
 * hook 이 dispatch 되지 않아 `permissions-<id>.jsonl` 가 생성되지 않는 갭을
 * 보완. 모든 PreToolUse 호출에서 동일 파일에 append (source='pre-tool-use'
 * 로 구분). permission-handler 의 entry 와 source 필드로 reader 측 dedup.
 *
 * fail-open: write 실패는 hook 차단하지 않음.
 */
function logToolCallSupplement(sessionId: string, toolName: string): void {
  try {
    const logPath = path.join(STATE_DIR, `permissions-${sanitizeId(sessionId)}.jsonl`);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      tool: toolName,
      decision: 'pre-approved',
      source: 'pre-tool-use',
    });
    fs.appendFileSync(logPath, `${entry}\n`);
  } catch (e) {
    log.debug('tool-call supplement log 실패', e);
  }
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

  // W2-5 (private 태그): 사용자가 <private> 로 표시한 코드 범위는 reflection 관측
  // 대상에서 제외한다. isReflectionCandidate 내부에서도 strip 하지만, 아래 태그
  // fallback 매칭은 이 code 를 직접 쓰므로 여기서 한 번 스트립해 두 경로를 일치시킨다.
  const code = stripPrivate(String(toolInput.new_string ?? toolInput.content ?? '')).cleaned;
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
      console.log(denyOrObserve('pre-tool-use', `[Forgen] PreToolUse: stdin parse failed ${failCount} consecutive times — blocking for safety.`));
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
  // ADR-017 §6-2: 상대 경로 rm 대상 해석용 (Claude Code 훅 stdin 의 cwd).
  const hookCwd = typeof (data as { cwd?: unknown }).cwd === 'string' ? String((data as { cwd?: string }).cwd) : undefined;

  // 입력 상한: 너무 긴 Bash 명령은 이후 어떤 분석(정규식·파서)도 돌리지 않고 확인을 요청한다 (훅 timeout 3초 안에 끝내기 위해).
  // 시간 초과로 fail-open 되는 것보다 사람이 한 번 보는 쪽이 안전하다.
  if (toolName === 'Bash' && typeof (toolInput as { command?: unknown }).command === 'string'
    && (toolInput as { command: string }).command.length > MAX_COMMAND_LENGTH) {
    if (process.env.FORGEN_USER_CONFIRMED !== '1') {
      const len = (toolInput as { command: string }).command.length;
      console.log(ask(`[Forgen] 사용자 확인 필요 — command too long to analyze (${len} > ${MAX_COMMAND_LENGTH} chars)\n${ASK_NONINTERACTIVE_HINT}`));
      return;
    }
    console.log(approve());
    return;
  }

  // ADR-008 / codex-integration.md — Codex `approval_policy=auto` 에서
  // PermissionRequest 가 dispatch 안 되는 갭 보완. 모든 tool call 을
  // permissions-<id>.jsonl 에 supplement 로 append (source='pre-tool-use').
  // D12-D: 중첩(추출) 실행에서는 위험 차단만 유지하고 학습·로그 부수효과는 건너뛴다.
  const nested = process.env.FORGEN_NESTED_RUN === '1';
  if (toolName && !nested) logToolCallSupplement(sessionId, toolName);

  // ADR-001 Mech-A PreToolUse dispatcher — 사용자가 정의한 rule 이 빌트인 위험-명령 감지보다 먼저.
  // 이렇게 해야 rule.block_message (맥락 있는 안내) 가 제네릭 "Dangerous command blocked" 대신 노출됨.
  // fail-open: 예외는 hook 차단 안 함.
  // ADR-017 D1: advise 강등 룰의 안내 메시지 — 차단 판정이 모두 끝난 뒤 승인 응답에 합쳐 출력한다.
  const advisories: string[] = [];
  try {
    const [
      { loadEnforcedRules },
      { recordViolation, matchedFragment },
      { compileSafeRegex, safeRegexTest },
      { preprocessForMatch },
    ] = await Promise.all([
      import('../store/rule-store.js'),
      import('../engine/lifecycle/signals.js'),
      import('./shared/safe-regex.js'),
      import('./shared/command-parser.js'),
    ]);
    const rules = loadEnforcedRules(hookCwd);
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
        // TEST-6 / RC5: quote-aware preprocessing. Default 'raw' = backward compat.
        // Rules that target real command invocations should set match_target: 'masked'
        // so quoted argument text (e.g. body of `forgen compound --solution "..."`)
        // doesn't trigger false positive blocks.
        const matchTarget = (v.params?.match_target ?? 'raw') as 'raw' | 'masked' | 'command_tokens';
        const target = preprocessForMatch(command, matchTarget);
        if (!safeRegexTest(re.regex, target)) continue;
        // ADR-017 §6-2 (오너 결정): rm -rf 류 룰이 Claude 의 임시 작업 폴더(/tmp/claude-*/… 등) 삭제에
        // 걸린 경우는 막지 않는다 — 같은 명령 안의 변수 대입까지 한 단계 해석해 대상이 전부 임시 경로일 때만.
        // critic D1 SEV-1: 예외는 **매칭된 토큰 자체가 rm** 일 때만 (pattern.includes('rm') 은 terraform 룰까지 껐다).
        const matchTok = re.regex.exec(target)?.[0] ?? '';
        // D12-A: rm 계열 판정은 command-analyzer 가 한다 — 정규식은 `rm -r -f`·`bash -c`·`xargs` 를 놓치고
        // 따옴표 속 문자열을 잡는다. 파서가 "삭제 없음/임시 경로"로 보면 룰도 통과, root/home 이면 룰 deny(영수증 포함),
        // 그 외 재귀 삭제는 오너 룰 "확인 없는 rm -rf 금지"에 따라 차단 대신 사용자 확인 요청(ask).
        let askOnly = false;
        if (/^\s*rm\b/.test(matchTok)) {
          const worstDel = worstFinding(analyzeCommand(command, { cwd: hookCwd }).findings.filter((f) => DELETE_FINDING_IDS.has(f.id)));
          if (!worstDel) { log.debug(`rule ${rule.rule_id}: no real recursive delete (temp-only/quoted) — exempt`); continue; }
          askOnly = worstDel.action === 'ask';
        }
        const requiresFlag = v.params?.requires_flag;
        const confirmed = process.env.FORGEN_USER_CONFIRMED === '1';
        const matchedFrag = matchedFragment(re.regex, target);
        // ADR-017 D1: precision 강등된 룰(enforce_mode 'advise')은 차단 대신 기록만.
        if (requiresFlag && !confirmed && rule.enforce_mode === 'advise') {
          recordViolation({ rule_id: rule.rule_id, session_id: sessionId, source: 'pre-tool-guard', kind: 'correction', message_preview: command.slice(0, 120), matched: matchedFrag, target_kind: 'command' });
          // ship-review MAJOR: 여기서 return 하면 같은 명령의 나머지 룰(하드 포함)과 빌트인 위험 검사를 건너뛴다 → 모아서 마지막에 경고.
          let why = '';
          try {
            const { lastDemotion } = await import('../engine/block-judge.js');
            const d = lastDemotion(rule.rule_id);
            if (d) why = ` (${d.at.slice(0, 10)} 7d 판정 ${d.judged}건 중 오탐률 ${Math.round((1 - d.precision) * 100)}% → 안내 모드)`;
          } catch { /* fail-open */ }
          advisories.push(`[Forgen] (advise) ${spec.block_message ?? rule.policy.slice(0, 120)}${why} — 차단 대신 안내만 합니다. 복귀: forgen rule enforce ${rule.rule_id.slice(0, 8)}`);
          continue;
        }
        if (requiresFlag && !confirmed) {
          const violationId = recordViolation(
            { rule_id: rule.rule_id, session_id: sessionId, source: 'pre-tool-guard', kind: askOnly ? 'correction' : 'deny', message_preview: command.slice(0, 120), matched: matchedFrag, target_kind: 'command' },
            { receipt_text: command },
          );
          if (!askOnly) { try { const { spawnBlockJudge } = await import('../engine/block-judge.js'); spawnBlockJudge(violationId, sessionId); } catch { /* fail-open */ } }
          const baseMsg = spec.block_message ?? `[${rule.rule_id}] policy violation: ${rule.policy.slice(0, 120)}`;
          // ADR-017 D0: 룰의 출처 교정 인용.
          const origin = await (async (): Promise<string> => {
            try { const { originLine } = await import('../store/rule-origin.js'); return originLine(rule); } catch { return ''; }
          })();
          // G8: override 힌트 — FORGEN_USER_CONFIRMED=1 으로 사용자 명시 승인 가능, 감사 로그 기록됨.
          if (askOnly) {
            console.log(ask(`${baseMsg}\n[Forgen] 사용자 확인 필요 — 이 재귀 삭제를 진행해도 되는지 승인해 주세요.${origin ? `\n${origin}` : ''}\n${ASK_NONINTERACTIVE_HINT}`));
            return;
          }
          const msgWithHint = `${baseMsg}${origin ? `\n${origin}` : ''}\n\n(override: set FORGEN_USER_CONFIRMED=1 (bypass will be audited in violations.jsonl). 오탐이면: forgen block ${violationId.slice(0, 8)} --fp)`;
          console.log(denyOrObserve('pre-tool-use', msgWithHint));
          return;
        }
        if (requiresFlag && confirmed) {
          // H3: 우회 감사 — FORGEN_USER_CONFIRMED 으로 Mech-A 를 우회할 때마다 violation 로그에
          // (ADR-017: kind='bypass_confirmed' — T3 의 유일한 입력. 아래 주석의 'correction' 은 구 의미.)
          recordViolation({
            rule_id: rule.rule_id, session_id: sessionId,
            source: 'pre-tool-guard',
            // ADR-017 D1: 사용자 명시 우회 전용 kind. (이전 'correction' 은 메타가드 advise 와 섞여
            // "사용자 우회 87건"으로 둔갑했다.) T3 의 유일한 입력.
            kind: 'bypass_confirmed',
            message_preview: `[FORGEN_USER_CONFIRMED=1 bypass] ${command.slice(0, 120)}`,
          });
        }
      }
    }
  } catch (e) { log.debug('enforce_via[PreToolUse] dispatch 실패', e); }

  // Bash 도구: 위험 명령어 감지 (빌트인 safety net)
  // critic D1: `rm -rf /tmp/../home`, `/tmp/{a,../..}`, `/tmp/*` 는 빌트인 /tmp lookahead 를 우회한다 → 먼저 차단.
  try {
    const cmd0 = typeof (toolInput as { command?: unknown }).command === 'string' ? String((toolInput as { command: string }).command) : '';
    if (toolName === 'Bash' && cmd0) {
      const { isSuspiciousRm, preprocessForMatch } = await import('./shared/command-parser.js');
      // heredoc 본문·따옴표 안 문자열(문서/테스트 소스에 적힌 예시)은 실행되는 명령이 아니다 → masked 로 검사.
      if (isSuspiciousRm(preprocessForMatch(cmd0, 'masked'))) {
        console.log(denyOrObserve('pre-tool-use', `[Forgen] Dangerous command blocked: recursive rm with path traversal/glob under a temp path\nCommand: ${cmd0.slice(0, 200)}`));
        return;
      }
    }
  } catch { /* fail-open */ }
  // D12-B: git add/commit 이 비밀 파일·키를 넣으려 하면 (실제 staged/untracked 내용 확인 후) 차단.
  if (toolName === 'Bash' && typeof (toolInput as { command?: unknown }).command === 'string') {
    try {
      const gitOps = analyzeCommand(String((toolInput as { command: string }).command), { cwd: hookCwd }).gitOps;
      if (gitOps.some((o) => o.sub === 'add' || o.sub === 'commit')) {
        const { hits: secretHits, timedOut } = checkGitSecretsBudgeted(gitOps, hookCwd, Number(process.env.FORGEN_COMMIT_GUARD_BUDGET_MS) || undefined);
        if (timedOut && secretHits.length === 0 && process.env.FORGEN_USER_CONFIRMED !== '1') {
          // 2초 예산 안에 비밀 검사를 끝내지 못했다 — 검사 안 된 커밋을 통과시키지 않는다.
          console.log(ask(`[Forgen] 사용자 확인 필요 — git add/commit 의 비밀 검사가 시간 예산(2초) 안에 끝나지 않았습니다 (저장소가 크거나 git 이 느림). 커밋 대상에 .env·키가 없는지 확인해 주세요.\n${ASK_NONINTERACTIVE_HINT}`));
          return;
        }
        if (secretHits.length > 0) {
          const lines = secretHits.slice(0, 10).map((h) => `  - ${h.file} (${h.reasons.join(', ')})`).join('\n');
          try { const { recordViolation } = await import('../engine/lifecycle/signals.js'); recordViolation({ rule_id: 'builtin:commit-secret', session_id: sessionId, source: 'pre-tool-guard', kind: 'deny', message_preview: `git secret files: ${secretHits.map((h) => h.file).slice(0, 5).join(', ')}`, target_kind: 'command' }); } catch { /* fail-open */ }
          console.log(denyOrObserve('pre-tool-use', `[Forgen] 비밀 파일/키가 커밋 대상에 포함되어 차단했습니다:\n${lines}\n.gitignore 에 추가하거나 git reset 으로 빼고, 키가 이미 노출됐다면 폐기·재발급하세요.`));
          return;
        }
      }
    } catch { /* fail-open */ }
  }
  const check = checkDangerousCommand(toolName, toolInput, hookCwd);
  const bashCmd = typeof (toolInput as { command?: unknown }).command === 'string' ? String((toolInput as { command: string }).command) : '';
  if (check.action === 'block') {
    if (check.ruleId) {
      try { const { recordViolation } = await import('../engine/lifecycle/signals.js'); recordViolation({ rule_id: check.ruleId, session_id: sessionId, source: 'pre-tool-guard', kind: 'deny', message_preview: bashCmd.slice(0, 120), target_kind: 'command' }); } catch { /* fail-open */ }
    }
    console.log(denyOrObserve('pre-tool-use', `[Forgen] Dangerous command blocked: ${check.description}\nCommand: ${check.command}`));
    return;
  }
  if (check.action === 'ask') {
    if (process.env.FORGEN_USER_CONFIRMED === '1') {
      try { const { recordViolation } = await import('../engine/lifecycle/signals.js'); recordViolation({ rule_id: check.ruleId ?? 'builtin:ask', session_id: sessionId, source: 'pre-tool-guard', kind: 'bypass_confirmed', message_preview: `[FORGEN_USER_CONFIRMED=1 bypass] ${bashCmd.slice(0, 120)}` }); } catch { /* fail-open */ }
    } else {
      console.log(ask(`${advisories.length ? `${advisories.join('\n')}\n` : ''}[Forgen] 사용자 확인 필요 — ${check.description}\n오너 룰: 확인 없는 재귀 삭제 금지 (임시 작업 폴더 /tmp/claude-* 는 면제).\nCommand: ${check.command}\n${ASK_NONINTERACTIVE_HINT}`));
      return;
    }
  }
  const withAdvisories = (body: string): string => (advisories.length ? `${advisories.map((x) => `<compound-tool-warning>\n${x}\n</compound-tool-warning>`).join('\n')}${body ? `\n${body}` : ''}` : body);
  if (check.action === 'warn') {
    console.log(approveWithWarning(withAdvisories(`<compound-tool-warning>\n[Forgen] ⚠ Dangerous command detected: ${check.description}\nProceed with caution.\n</compound-tool-warning>`)));
    return;
  }

  if (nested) { console.log(approve()); return; }

  // Output size guard: warn when Grep is used without head_limit
  if (toolName === 'Grep' && !toolInput?.head_limit) {
    console.log(approveWithWarning(withAdvisories(`<compound-tool-warning>\n[Forgen] Grep without head_limit may produce large output. Set head_limit or pipe through | head -n to limit output size.\n</compound-tool-warning>`)));
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
    const reminders = getActiveReminders(sessionId);
    if (reminders.length > 0) {
      console.log(approveWithWarning(withAdvisories(`<compound-reminder>\n${reminders.join('\n')}\n</compound-reminder>`)));
      return;
    }
  }

  if (advisories.length) { console.log(approveWithWarning(withAdvisories(''))); return; }
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
  console.log(failOpenWithTracking('pre-tool-use', e));
});
