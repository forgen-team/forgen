#!/usr/bin/env node
/**
 * Forgen — Context Guard Hook
 *
 * Claude Code Stop 훅으로 등록.
 * context window limit, edit error 등 실행 중 에러를 감지하여
 * 사용자에게 경고하고 상태를 보존합니다.
 *
 * 또한 UserPromptSubmit에서 현재 대화 길이를 추적하여
 * context 한계에 접근 시 preemptive 경고를 제공합니다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../core/logger.js';
import { readStdinJSON } from './shared/read-stdin.js';
import { atomicWriteJSON } from './shared/atomic-write.js';
import { loadHookConfig, isHookEnabled } from './hook-config.js';
import { approve, approveWithContext, approveWithWarning, failOpenWithTracking } from './shared/hook-response.js';
import { HANDOFFS_DIR, STATE_DIR } from '../core/paths.js';
import { recordHookTiming } from './shared/hook-timing.js';
import { sanitizeId } from './shared/sanitize-id.js';
import { redactSecrets } from './secret-filter.js';
import type { HostId } from '../core/trust-layer-intent.js';

const log = createLogger('context-guard');
const CONTEXT_STATE_PATH = path.join(STATE_DIR, 'context-guard.json');
const PROMPT_HISTORY_PATH = path.join(STATE_DIR, 'prompt-history.jsonl');
const PROMPT_HISTORY_TRUNCATE = 1024; // ADR-008: 1KB cap per entry
const RATE_LIMIT_MISSES_PATH = path.join(STATE_DIR, 'rate-limit-misses.jsonl');

// ADR-008: detection regex 분리. token-limit 은 context window, rate-limit 은 API quota.
export const TOKEN_LIMIT_REGEX = /context.*limit|token.*limit|conversation.*too.*long/i;
export const RATE_LIMIT_REGEX = /rate.?limit|5.?hour.*limit|weekly.*limit|usage.*limit|quota.*exceeded|out of (?:extra |free )?usage|usage cap|monthly limit reached?/i;

/**
 * Best-effort reset 시각 파서 (ADR-008 §2).
 *
 * 5 패턴 시도, 모두 실패 시 null. 실제 메시지 포맷은 Claude/Codex CLI 의
 * 공식 contract 가 아니므로 hotfix 가능한 best-effort.
 *
 * @param msg stderr/error message text
 * @param now epoch ms (테스트 결정성 위해 주입 가능)
 * @returns ISO timestamp 또는 null
 */
export function parseRateLimitResetAt(msg: string, now: number = Date.now()): string | null {
  // Pattern 4: explicit ISO timestamp — "available again at <ISO>"
  const isoMatch = msg.match(/(?:available|reset|retry)\s+(?:again\s+)?(?:at|on)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/i);
  if (isoMatch) {
    const ts = Date.parse(isoMatch[1]);
    if (Number.isFinite(ts)) return new Date(ts).toISOString();
  }

  // Pattern 2: "Resets in 4h 12m" / "in 4h" / "in 12m"
  const hMin = msg.match(/(?:reset|retry|try\s+again)s?\s+in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?/i);
  if (hMin && (hMin[1] || hMin[2])) {
    const hours = parseInt(hMin[1] ?? '0', 10);
    const mins = parseInt(hMin[2] ?? '0', 10);
    const offset = (hours * 3600 + mins * 60) * 1000;
    if (offset > 0) return new Date(now + offset).toISOString();
  }

  // Pattern 3: "Resets in 18000 seconds"
  const secMatch = msg.match(/(?:reset|retry|try\s+again)s?\s+in\s+(\d+)\s*sec(?:ond)?s?/i);
  if (secMatch) {
    const sec = parseInt(secMatch[1], 10);
    if (sec > 0) return new Date(now + sec * 1000).toISOString();
  }

  // Pattern 5: "resets <H>:<MM><am|pm>" (12h, optional "at", optional TZ label in parens)
  // Pattern 1보다 앞에 위치: "resets at 4:20 pm" 에서 Pattern 1이 am/pm 없이 잡으면
  // 24h 로 오변환되므로 am/pm 있는 경우를 먼저 처리.
  // 예: "resets 4:20pm", "resets 4:20pm (Asia/Seoul)", "resets at 4:20 pm"
  const ampm = msg.match(/resets?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = parseInt(ampm[2], 10);
    const meridiem = ampm[3].toLowerCase();
    if (h >= 1 && h <= 12 && m >= 0 && m <= 59) {
      // 12h → 24h 변환: 12am=0, 12pm=12, 1-11am=1-11, 1-11pm=13-23
      if (meridiem === 'am') {
        h = h === 12 ? 0 : h;
      } else {
        h = h === 12 ? 12 : h + 12;
      }
      const d = new Date(now);
      d.setUTCHours(h, m, 0, 0);
      if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString();
    }
  }

  // Pattern 1: "Resets at HH:MM(:SS)? TZ" — TZ 미지원 (UTC 가정)
  const hhmm = msg.match(/(?:reset|retry|available)s?\s+at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(UTC|GMT|PST|PDT|EST|EDT|KST|JST)?/i);
  if (hhmm) {
    const h = parseInt(hhmm[1], 10);
    const m = parseInt(hhmm[2], 10);
    const s = parseInt(hhmm[3] ?? '0', 10);
    if (h < 24 && m < 60 && s < 60) {
      const d = new Date(now);
      d.setUTCHours(h, m, s, 0);
      // 이미 지난 시각이면 다음 날
      if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString();
    }
  }

  return null;
}

/**
 * Detector 실패 (RATE_LIMIT_REGEX 매칭 실패) raw 메시지를 누적.
 * ADR-008 §5: 5건 누적 시 사용자 경고 — patch release 로 hotfix 신호.
 */
function logRateLimitMiss(errorMsg: string): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(RATE_LIMIT_MISSES_PATH, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      message: errorMsg.slice(0, 500),
    })}\n`);
  } catch (e) { log.debug('rate-limit-miss log 실패', e); }
}

/**
 * Append-only prompt history writer (docs/codex-integration.md §"prompt-history.jsonl").
 *
 * compound-extractor.ts:547 의 read 코드가 0.4.5 까지 dead code 였음. 0.4.6
 * 부터 UserPromptSubmit hook 에서 truncated prompt 를 append 하여 활성화.
 *
 * fail-open: 실패는 hook 차단하지 않음.
 */
function appendPromptHistory(sessionId: string, prompt: string): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // ADR-008 critical: secret/PII redaction via secret-filter regex 재사용.
    // password/api-key 가 평문 prompt 에 들어가면 그대로 disk 에 박제되는 위험 차단.
    const safePrompt = redactSecrets(prompt).redacted;
    const truncated = safePrompt.length > PROMPT_HISTORY_TRUNCATE
      ? safePrompt.slice(0, PROMPT_HISTORY_TRUNCATE)
      : safePrompt;
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionId,
      promptLength: prompt.length,
      prompt: truncated,
    });
    fs.appendFileSync(PROMPT_HISTORY_PATH, `${entry}\n`);
  } catch (e) {
    log.debug('prompt-history append 실패', e);
  }
}

interface ContextState {
  promptCount: number;
  totalChars: number;
  lastWarningAt: number;
  lastAutoCompactAt: number;
  sessionId: string;
}

// 경고 임계값: 프롬프트 50회 또는 총 문자 수 200K 이상
const PROMPT_WARNING_THRESHOLD = 50;
const CHARS_WARNING_THRESHOLD = 200_000;
const WARNING_COOLDOWN_MS = 10 * 60 * 1000; // 10분 쿨다운

// Auto-compact 임계값: 추적된 문자 120K ≈ 실제 context ~20%
const AUTO_COMPACT_CHARS_THRESHOLD = 120_000;
const AUTO_COMPACT_COOLDOWN_MS = 5 * 60 * 1000; // 5분 쿨다운

/** 경고 표시 여부 판정 (순수 함수) */
export function shouldWarn(
  contextPercent: { promptCount: number; totalChars: number; lastWarningAt: number },
  thresholds: { promptThreshold?: number; charsThreshold?: number; cooldownMs?: number } = {},
): boolean {
  const promptThreshold = thresholds.promptThreshold ?? PROMPT_WARNING_THRESHOLD;
  const charsThreshold = thresholds.charsThreshold ?? CHARS_WARNING_THRESHOLD;
  const cooldownMs = thresholds.cooldownMs ?? WARNING_COOLDOWN_MS;
  const now = Date.now();
  return (
    (contextPercent.promptCount >= promptThreshold || contextPercent.totalChars >= charsThreshold) &&
    (now - contextPercent.lastWarningAt > cooldownMs)
  );
}

/** auto-compact 트리거 여부 판정 (순수 함수) */
export function shouldAutoCompact(
  state: { totalChars: number; lastAutoCompactAt: number },
  thresholds: { charsThreshold?: number; cooldownMs?: number } = {},
): boolean {
  const charsThreshold = thresholds.charsThreshold ?? AUTO_COMPACT_CHARS_THRESHOLD;
  const cooldownMs = thresholds.cooldownMs ?? AUTO_COMPACT_COOLDOWN_MS;
  const now = Date.now();
  return state.totalChars >= charsThreshold && (now - state.lastAutoCompactAt > cooldownMs);
}

/** auto-compact 지시 메시지 생성 (순수 함수) */
export function buildAutoCompactMessage(totalChars: number): string {
  return `<forgen-auto-compact>
[Forgen] Context 사용량이 ${Math.round(totalChars / 1000)}K 문자에 도달했습니다 (추정 ~20%+).
지금 즉시 /compact를 실행하여 컨텍스트를 압축하세요. 이 지시는 자동으로 생성되었습니다.
현재 작업을 마무리하지 말고, 다음 응답에서 바로 compact를 실행하세요.
</forgen-auto-compact>`;
}

/** 경고 메시지 생성 (순수 함수) */
export function buildContextWarningMessage(promptCount: number, totalChars: number): string {
  return `<compound-context-warning>\n[Forgen] Context limit approaching: ${promptCount} prompts, ${Math.round(totalChars / 1000)}K characters.\nIf you have important progress, save it now:\n- Use cancelforgen to reset mode state and start a new session\n- Or continue current work (auto compaction may occur)\n</compound-context-warning>`;
}

function loadContextState(sessionId: string): ContextState {
  try {
    if (fs.existsSync(CONTEXT_STATE_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONTEXT_STATE_PATH, 'utf-8'));
      if (data.sessionId === sessionId) return data;
    }
  } catch (e) { log.debug('context state 파일 읽기/파싱 실패', e); }
  return { promptCount: 0, totalChars: 0, lastWarningAt: 0, lastAutoCompactAt: 0, sessionId };
}

function saveContextState(state: ContextState): void {
  atomicWriteJSON(CONTEXT_STATE_PATH, state);
}

export async function main(): Promise<void> {
  const _hookStart = Date.now();
  let _hookEvent = 'UserPromptSubmit';
  try {
  const input = await readStdinJSON<{ prompt?: string; session_id?: string; stop_hook_type?: string; error?: string; transcript_path?: string; cwd?: string }>();
  if (!isHookEnabled('context-guard')) {
    console.log(approve());
    return;
  }
  if (!input) {
    console.log(approve());
    return;
  }

  const sessionId = input.session_id ?? 'default';

  // Stop 훅: stop_hook_type이 있으면 처리
  if (input.stop_hook_type) {
    _hookEvent = 'Stop';

    // 세션 종료 시 pending outcome을 unknown으로 finalize.
    // 과거에는 프로덕션에서 호출되지 않아 pending이 다음 세션의 flushAccept에
    // accept로 쓸려들어가는 구조적 optimistic bias가 있었다 (2026-04-20).
    // finalizeSession은 idempotent (pending 없으면 0 반환, 에러는 log.debug만).
    try {
      const { finalizeSession } = await import('../engine/solution-outcomes.js');
      finalizeSession(sessionId);
    } catch (e) {
      log.debug('finalizeSession 실패 (fail-open)', e);
    }

    // forge-loop 활성 시 미완료 스토리 감지 → 지속 메시지 주입 (polite-stop 방지)
    const forgeLoopBlock = checkForgeLoopActive(sessionId);
    if (forgeLoopBlock) {
      console.log(forgeLoopBlock);
      return;
    }

    // 에러가 포함된 경우: context-limit / rate-limit 감지 (ADR-008)
    if (input.error) {
      const errorMsg = input.error;
      // FORGEN_RUNTIME 은 buildEnv (config-injector.ts:479) 에서 spawn 시 주입.
      // hook 은 claude/codex CLI 를 통해 invoke 되어 부모 env 상속.
      const runtime = (process.env.FORGEN_RUNTIME as HostId | undefined) ?? 'claude';

      if (TOKEN_LIMIT_REGEX.test(errorMsg)) {
        saveHandoff(sessionId, 'context-limit', errorMsg);
        try {
          const resumePath = path.join(STATE_DIR, 'pending-resume.json');
          fs.writeFileSync(resumePath, JSON.stringify({
            reason: 'token-limit',
            sessionId,
            runtime,
            savedAt: new Date().toISOString(),
            cwd: process.env.FORGEN_CWD ?? process.env.COMPOUND_CWD ?? process.cwd(),
          }, null, 2));
        } catch { /* fail-open */ }
        console.log(approveWithWarning(`[Forgen] Context limit reached. Current state has been saved to ~/.forgen/handoffs/.\nThe previous work will be automatically recovered in the next session.`));
        return;
      }

      if (RATE_LIMIT_REGEX.test(errorMsg)) {
        const resetAt = parseRateLimitResetAt(errorMsg);
        saveHandoff(sessionId, 'rate-limit', errorMsg);
        try {
          const resumePath = path.join(STATE_DIR, 'pending-resume.json');
          fs.writeFileSync(resumePath, JSON.stringify({
            reason: 'rate-limit',
            sessionId,
            runtime,
            resetAt,
            savedAt: new Date().toISOString(),
            cwd: process.env.FORGEN_CWD ?? process.env.COMPOUND_CWD ?? process.cwd(),
          }, null, 2));
        } catch { /* fail-open */ }
        const eta = resetAt ? `at ${resetAt}` : 'with backoff schedule';
        console.log(approveWithWarning(`[Forgen] Rate limit reached. Auto-resume scheduled ${eta}. State saved to ~/.forgen/handoffs/.`));
        return;
      }

      // ADR-008 §5: detection 실패 raw 누적 → patch hotfix 신호
      // (어느 limit regex 도 매칭 안 됨 = unknown error 또는 detector miss)
      if (/limit|quota|throttle/i.test(errorMsg)) {
        logRateLimitMiss(errorMsg);
      }
    }

    // 정상 종료 시: 의미 있는 세션이었으면 compound 안내/자동 트리거
    if (input.stop_hook_type === 'user' || input.stop_hook_type === 'end_turn') {
      const state = loadContextState(sessionId);

      // ADR-002 T1 — 세션 중간에 교정이 들어와도 session-scoped rule 이 me-scope 으로
      // 승급되도록 Stop 에서 직접 auto-compound-runner 를 debounced 로 트리거.
      // 'forgen' CLI 를 통하지 않는 사용자 (claude 직접 실행) 에게도 교정이 유실되지 않는 보장.
      // dedup: last-auto-compound.json 의 sessionId + 5분 cooldown.
      try {
        await maybeSpawnAutoCompound(sessionId, input.transcript_path, state.promptCount);
      } catch (e) { log.debug('auto-compound Stop trigger 실패', e); }

      if (state.promptCount >= 20) {
        // 20+ prompts: auto-trigger compound by writing marker
        try {
          fs.mkdirSync(STATE_DIR, { recursive: true });
          const marker = { reason: 'session-end', promptCount: state.promptCount, detectedAt: new Date().toISOString() };
          fs.writeFileSync(path.join(STATE_DIR, 'pending-compound.json'), JSON.stringify(marker));
        } catch { /* fail-open: marker write failure is non-critical */ }
        const summary = buildSessionSummary(sessionId, state.promptCount);
        console.log(approveWithWarning(
          `[Forgen] Session with ${state.promptCount} prompts ended.\n${summary}\nCompound loop will auto-trigger on next session start.`
        ));
        return;
      }
      if (state.promptCount >= 10) {
        // 10-19 prompts: suggest /compound manually
        const summary = buildSessionSummary(sessionId, state.promptCount);
        console.log(approveWithWarning(
          `[Forgen] 이 세션에서 ${state.promptCount}개의 프롬프트를 처리했습니다.\n${summary}/compound 를 실행하면 이 세션의 학습 내용을 축적할 수 있습니다.`
        ));
        return;
      }
    }

    console.log(approve());
    return;
  }

  // error만 있는 경우 (stop_hook_type 없이)
  if (input.error) {
    console.log(approve());
    return;
  }

  // UserPromptSubmit 훅: 대화 길이 추적
  if (input.prompt) {
    const config = loadHookConfig('context-guard');
    // maxTokens가 설정되어 있으면 chars threshold로 사용 (토큰 ≈ 4자 기준 환산)
    const charsThreshold =
      typeof config?.maxTokens === 'number' ? config.maxTokens * 4 : undefined;

    const state = loadContextState(sessionId);
    state.promptCount++;
    state.totalChars += input.prompt.length;

    // ADR-008 / docs/codex-integration.md — prompt-history writer 활성화
    appendPromptHistory(sessionId, input.prompt);

    // auto-compact: 추적 문자 120K 이상이면 compact 지시 주입
    const autoCompactThreshold =
      typeof config?.autoCompactChars === 'number' ? config.autoCompactChars : undefined;
    if (shouldAutoCompact(state, autoCompactThreshold !== undefined ? { charsThreshold: autoCompactThreshold } : {})) {
      state.lastAutoCompactAt = Date.now();
      saveContextState(state);
      console.log(approveWithContext(buildAutoCompactMessage(state.totalChars), 'UserPromptSubmit'));
      return;
    }

    if (shouldWarn(state, charsThreshold !== undefined ? { charsThreshold } : {})) {
      state.lastWarningAt = Date.now();
      saveContextState(state);
      console.log(approveWithContext(buildContextWarningMessage(state.promptCount, state.totalChars), 'UserPromptSubmit'));
      return;
    }

    saveContextState(state);
  }

  console.log(approve());
  } finally {
    recordHookTiming('context-guard', Date.now() - _hookStart, _hookEvent);
  }
}

/**
 * 세션 종료 시 forgen *활동*을 요약 (관찰 — 인과 효과/절약 미주장).
 * solution-cache 에서 이번 세션 주입된 compound 수·상위 솔루션·주입 대화 비율을 보여준다.
 * honest-null (positioning #74): "forgen 없었으면 ~N분 절약" 카운터팩추얼은 은퇴.
 */
function buildSessionSummary(sessionId: string, promptCount: number): string {
  try {
    // P1-S3 fix (2026-04-20): sanitizeId로 path traversal 차단.
    // 다른 세션 캐시 경로는 모두 sanitizeId 사용. 여기만 누락되어 있었다.
    const cachePath = path.join(STATE_DIR, `solution-cache-${sanitizeId(sessionId)}.json`);
    if (!fs.existsSync(cachePath)) return '';
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as {
      injected?: Array<{ name: string; injectedAt: string }>;
    };
    const injected = Array.isArray(cache.injected) ? cache.injected : [];
    if (injected.length === 0) return '';

    // honest-null (2026-07-21, positioning #74 정합): "절약 시간(forgen 없었으면)"
    // 카운터팩추얼은 은퇴 — 측정된 δ 없이 시간절약을 추정하는 건 날조다. *관찰 가능한*
    // 활동만 보여준다 (무엇이 주입됐나), 인과 효과 크기는 주장하지 않는다.
    const topNames = injected.slice(0, 3).map(i => `"${i.name}"`).join(', ');
    const moreCount = injected.length - 3;
    const topStr = moreCount > 0 ? `${topNames} 외 ${moreCount}개` : topNames;
    const injectedPromptPct = Math.round((injected.length / promptCount) * 100);

    return [
      `\n📊 이번 세션 forgen 활동:`,
      `  주입된 compound: ${injected.length}건 (${topStr})`,
      `  주입이 있던 대화 비율: ${injectedPromptPct}% ${'\x1b[2m'}(관찰 — 도움 여부는 미측정)${'\x1b[0m'}`,
    ].join('\n');
  } catch {
    return '';
  }
}

// forge-loop 상태 파일 경로
const FORGE_LOOP_STATE_PATH = path.join(STATE_DIR, 'forge-loop.json');

/**
 * Stop hook 에서 auto-compound-runner 를 debounced 로 spawn.
 *
 * 호출 조건:
 *   - promptCount ≥ 10 (의미있는 세션)
 *   - transcript_path 유효
 *   - last-auto-compound.json 의 sessionId 가 다르거나 5분 전
 *
 * dedup 파일은 session-recovery hook 과 공유되어 double-run 방지.
 * fire-and-forget (detached) — hook timeout 과 무관.
 */
const AUTO_COMPOUND_COOLDOWN_MS = 5 * 60 * 1000; // 5 min (default)
const AUTO_COMPOUND_BARREN_COOLDOWN_MS = 30 * 60 * 1000; // 30 min if last run extracted nothing

/**
 * 0.4.6 perf #12 — adaptive cooldown.
 *
 * 마지막 auto-compound run 이 0건 추출했으면 (barren), 다음 cooldown 을 5min →
 * 30min 으로 확장. 같은 session 의 짧은 prompt 추가에서 동일 transcript 로 매번
 * 3 LLM 호출하는 wasted run 차단. completed marker 의 extractedSolutions /
 * promotedRules / userPatternFound 합산이 0 이면 barren 판정.
 *
 * 일반 case (추출 있음) 은 5분 cooldown 유지 — adaptive 가 sparsity 시그널을
 * 강화할 뿐 정상 동작 차단 안 함.
 */
function effectiveCooldownMs(parsed: {
  extractedSolutions?: number;
  promotedRules?: number;
  userPatternFound?: boolean;
}): number {
  const total = (parsed.extractedSolutions ?? 0) + (parsed.promotedRules ?? 0)
    + (parsed.userPatternFound ? 1 : 0);
  return total === 0 ? AUTO_COMPOUND_BARREN_COOLDOWN_MS : AUTO_COMPOUND_COOLDOWN_MS;
}

async function maybeSpawnAutoCompound(
  sessionId: string,
  transcriptPath: string | undefined,
  promptCount: number,
): Promise<void> {
  if (!transcriptPath || promptCount < 10) return;

  const markerPath = path.join(STATE_DIR, 'last-auto-compound.json');
  try {
    const raw = fs.readFileSync(markerPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      sessionId?: string;
      completedAt?: string;
      extractedSolutions?: number;
      promotedRules?: number;
      userPatternFound?: boolean;
    };
    if (parsed.sessionId === sessionId) {
      const last = parsed.completedAt ? Date.parse(parsed.completedAt) : 0;
      const cooldown = effectiveCooldownMs(parsed);
      if (Number.isFinite(last) && Date.now() - last < cooldown) return;
    }
  } catch { /* first time or corrupt — proceed */ }

  const { spawn: spawnProcess } = await import('node:child_process');
  const cwd = process.env.FORGEN_CWD ?? process.env.COMPOUND_CWD ?? process.cwd();

  // 기본: 번들된 auto-compound-runner. 프로덕션 빌드는 이 경로만 실행.
  const defaultRunner = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'auto-compound-runner.js');

  // 테스트 주입 경로 — FORGEN_TEST=1 게이트 + 경로 containment (~/.forgen 또는 /tmp 하위만 허용).
  // FORGEN_TEST 없이 FORGEN_AUTO_COMPOUND_RUNNER_PATH 만 설정되어도 무시 → 임의 코드 실행 방지.
  let runnerPath = defaultRunner;
  const override = process.env.FORGEN_AUTO_COMPOUND_RUNNER_PATH;
  if (override && process.env.FORGEN_TEST === '1') {
    const resolved = path.resolve(override);
    const homeDir = os.homedir();
    const allowed = [
      path.join(homeDir, '.forgen'),
      os.tmpdir(), // 플랫폼별 /tmp, /var/folders/... 등
      '/tmp',
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    ];
    if (allowed.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
      runnerPath = resolved;
    } else {
      log.debug(`FORGEN_AUTO_COMPOUND_RUNNER_PATH 무시 — ${resolved} 가 허용 루트 밖`);
    }
  } else if (override) {
    log.debug('FORGEN_AUTO_COMPOUND_RUNNER_PATH 무시 — FORGEN_TEST=1 가 필요');
  }
  const child = spawnProcess('node', [runnerPath, cwd, transcriptPath, sessionId], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  log.debug(`Stop-triggered auto-compound 시작: ${sessionId} (${promptCount} prompts)`);
}

// forge-loop 차단 안전 상한 (무한 루프 방지)
const FORGE_LOOP_MAX_BLOCKS = 30;
// TTL: 24시간. 과거 2시간은 정상적으로 오래 걸리는 forge-loop 세션까지 중도
// 해제시켰다. "크래시된 세션의 잔여 active:true 가 무관한 후속 세션을 영구
// 차단"하는 문제는 이 TTL 이 아니라 아래 sessionId 바인딩으로 별도 해결한다 —
// TTL 은 진짜로 죽은(재개 안 되는) 세션을 회수하기 위한 상한일 뿐이다.
const FORGE_LOOP_STALE_MS = 24 * 60 * 60 * 1000;

interface ForgeLoopStory {
  id: string;
  title: string;
  passes: boolean;
  attempts?: number;
  /** 첫 항목만 차단 메시지에 AC1으로 노출 (선택 필드 — 없어도 정상 동작). */
  acceptanceCriteria?: string[];
}

interface ForgeLoopState {
  active: boolean;
  startedAt: string;
  /** 최초 차단 시점에 자동 귀속되는 소유 세션. 다른 세션의 Stop 은 이 루프를 건드리지 않는다. */
  sessionId?: string;
  lastBlockAt?: string;
  blockCount?: number;
  stories: ForgeLoopStory[];
  awaitingConfirmation?: boolean;
}

/**
 * forge-loop 활성 시 미완료 스토리가 있으면 Stop을 차단하고 지속 메시지 주입.
 * OMC의 persistent-mode.cjs 패턴 참고.
 *
 * @param sessionId 호출한 Stop hook 의 세션 ID. 미지정 시(레거시 호출) 세션
 *   바인딩을 건너뛰고 기존처럼 전역으로 평가한다.
 */
export function checkForgeLoopActive(sessionId?: string): string | null {
  try {
    if (!fs.existsSync(FORGE_LOOP_STATE_PATH)) return null;

    const state: ForgeLoopState = JSON.parse(fs.readFileSync(FORGE_LOOP_STATE_PATH, 'utf-8'));
    if (!state.active) return null;

    // 세션 바인딩: 이미 다른 세션에 귀속된 루프라면 이 세션과 무관 — 손대지 않고 통과.
    // 크래시된 세션이 남긴 active:true 가 이후 전혀 다른 세션을 영구 차단하는 것을 방지.
    if (state.sessionId && sessionId && state.sessionId !== sessionId) {
      return null;
    }
    // 최초 차단 후보 세션에 자동 귀속 (스킬은 세션 ID를 알 필요 없음).
    if (!state.sessionId && sessionId) {
      state.sessionId = sessionId;
    }

    // 사용자 명시 우회 — 이번 턴만 통과시키고 루프 상태(active/blockCount)는 보존.
    // pre-tool-use/stop-guard 와 동일한 FORGEN_USER_CONFIRMED=1 관용구.
    if (process.env.FORGEN_USER_CONFIRMED === '1') return null;

    // Stale 감지: TTL(24h) 초과 → 자동 비활성화 + 1회성 안내 (침묵 해제 금지).
    const startedAt = new Date(state.startedAt).getTime();
    if (Number.isFinite(startedAt) && Date.now() - startedAt > FORGE_LOOP_STALE_MS) {
      state.active = false;
      atomicWriteJSON(FORGE_LOOP_STATE_PATH, state);
      return approveWithWarning(
        `[Forgen] forge-loop 상태가 ${Math.round(FORGE_LOOP_STALE_MS / 3_600_000)}시간 이상 갱신되지 않아 자동 해제되었습니다. ` +
        `재개하려면 "/forge-loop resume" 를 입력하세요.`
      );
    }

    // 확인 대기 중이면 차단하지 않음 (사용자 개입 허용) — 귀속은 반영 후 통과.
    if (state.awaitingConfirmation) {
      atomicWriteJSON(FORGE_LOOP_STATE_PATH, state);
      return null;
    }

    // 안전 상한: 30회 이상 연속 차단 시 무한 루프로 간주하여 해제 + 1회성 안내.
    const blockCount = state.blockCount ?? 0;
    if (blockCount >= FORGE_LOOP_MAX_BLOCKS) {
      state.active = false;
      atomicWriteJSON(FORGE_LOOP_STATE_PATH, state);
      return approveWithWarning(
        `[Forgen] forge-loop 이 연속 ${FORGE_LOOP_MAX_BLOCKS}회 차단되어 안전 상한으로 자동 해제되었습니다. ` +
        `무한 루프 가능성을 점검한 뒤 필요 시 "/forge-loop resume" 로 재개하세요.`
      );
    }

    // 미완료 스토리 확인
    const stories = Array.isArray(state.stories) ? state.stories : [];
    const pending = stories.filter((s) => !s.passes);
    if (pending.length === 0) {
      // 모든 스토리 완료 → forge-loop 종료
      state.active = false;
      atomicWriteJSON(FORGE_LOOP_STATE_PATH, state);
      return null;
    }

    // 차단 카운트 증가 + 지속 메시지 주입
    state.blockCount = blockCount + 1;
    state.lastBlockAt = new Date().toISOString();
    atomicWriteJSON(FORGE_LOOP_STATE_PATH, state);

    const nextStory = pending[0];
    const firstAC = Array.isArray(nextStory.acceptanceCriteria) ? nextStory.acceptanceCriteria[0] : undefined;
    const lines = [
      `<forgen-forge-loop iteration="${state.blockCount}/${FORGE_LOOP_MAX_BLOCKS}">`,
      `[FORGE-LOOP] ${pending.length}개 스토리가 미완료입니다.`,
      `현재 스토리: ${nextStory.id} — ${nextStory.title}`,
    ];
    if (firstAC) lines.push(`AC1: ${firstAC}`);
    lines.push(
      ``,
      `계속 진행하세요. 보고는 다음 시점에만 합니다:`,
      `  1. 모든 스토리 완료 (최종 리포트)`,
      `  2. 3회 실패 (에스컬레이션)`,
      `  3. Context limit 접근 (handoff)`,
      ``,
      `중간 "완료했습니다" 보고는 polite-stop anti-pattern입니다.`,
      `취소하려면: "/forge-loop cancel" 또는 "cancelforgen" 입력`,
      `</forgen-forge-loop>`,
    );

    // block 결정으로 Claude가 계속 작업하도록 강제
    return JSON.stringify({
      continue: true,
      decision: 'block',
      reason: lines.join('\n'),
    });
  } catch (e) {
    // fail-open: forge-loop 상태 읽기 실패는 차단하지 않음
    log.debug('forge-loop 상태 확인 실패', e);
    return null;
  }
}

function saveHandoff(sessionId: string, reason: string, detail: string): void {
  fs.mkdirSync(HANDOFFS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const handoffPath = path.join(HANDOFFS_DIR, `${timestamp}-${reason}.md`);

  // 활성 모드 상태 수집
  const stateDir = STATE_DIR;
  const activeStates: string[] = [];
  if (fs.existsSync(stateDir)) {
    for (const f of fs.readdirSync(stateDir)) {
      if (f.endsWith('-state.json') && !f.startsWith('skill-cache-') && !f.startsWith('context-guard')) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf-8'));
          if (data.active) {
            activeStates.push(`- ${f.replace('-state.json', '')}: ${data.prompt ?? 'no prompt'}`);
          }
        } catch (e) { log.debug(`상태 파일 파싱 실패: ${f}`, e); }
      }
    }
  }

  const content = [
    `# Handoff: ${reason}`,
    `- Session: ${sessionId}`,
    `- Time: ${new Date().toISOString()}`,
    `- Reason: ${detail}`,
    '',
    '## Active Modes',
    activeStates.length > 0 ? activeStates.join('\n') : '- none',
    '',
    '## Recovery Instructions',
    'Automatically recovered in the next session (session-recovery hook).',
    'Manual recovery: Check the last state of the previous work and continue from there.',
  ].join('\n');

  fs.writeFileSync(handoffPath, content);
}

// ESM main guard: import 시 main() 실행 방지
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[ch-hook] ${e instanceof Error ? e.message : String(e)}\n`);
    console.log(failOpenWithTracking('context-guard', e));
  });
}
