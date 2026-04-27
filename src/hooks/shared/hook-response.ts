/**
 * Forgen — Hook Response Utilities
 *
 * Claude Code Plugin SDK 공식 형식에 맞는 훅 응답 생성.
 *
 * 공식 형식 (검증 완료 — claude-code 소스 기반):
 *   hookSpecificOutput은 discriminated union이며 hookEventName이 필수.
 *   - PreToolUse: { hookEventName, permissionDecision, permissionDecisionReason? }
 *   - UserPromptSubmit: { hookEventName, additionalContext? }
 *   - SessionStart: { hookEventName, additionalContext?, initialUserMessage? }
 *
 * 주의:
 *   systemMessage 필드는 UI 표시용으로만 사용되며 모델에 전달되지 않음.
 *   모델에 컨텍스트를 주입하려면 반드시 additionalContext를 사용해야 함.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from '../../core/paths.js';
import { canBlock } from './blocking-allowlist.js';

/** 통과 응답 (컨텍스트 없음, 모든 이벤트 공통) */
export function approve(): string {
  return JSON.stringify({ continue: true });
}

/**
 * 통과 + 모델에 컨텍스트 주입.
 * UserPromptSubmit, SessionStart 이벤트에서만 모델에 도달함.
 *
 * H1 (v0.4.1): optional `userNotice` 로 사용자 UI (systemMessage) 에도 동시
 * 1줄 노출. additionalContext 는 모델 전용이라 기존 recall hit 이 8,000+ 번
 * 주입되었는데도 사용자는 0 건을 봤음. userNotice 로 같은 hit 을 사용자
 * 에게 가시화한다.
 */
export function approveWithContext(context: string, eventName: string, userNotice?: string): string {
  return JSON.stringify({
    continue: true,
    hookSpecificOutput: { hookEventName: eventName, additionalContext: context },
    ...(userNotice ? { systemMessage: userNotice } : {}),
  });
}

/**
 * 통과 + UI 경고 표시 (모델에는 전달되지 않음).
 * PostToolUse, PreToolUse 경고 등 모델 도달이 불필요한 경우 사용.
 */
export function approveWithWarning(warning: string): string {
  return JSON.stringify({ continue: true, suppressOutput: false, systemMessage: warning });
}

/** 차단 응답 (PreToolUse 전용) */
export function deny(reason: string): string {
  return JSON.stringify({
    continue: false,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

/** 사용자 확인 요청 (PreToolUse 전용) */
export function ask(reason: string): string {
  return JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  });
}

/**
 * P3' enforcement helper (2026-04-27)
 *
 * ALLOW-LIST 에 있는 hook 만 진짜 deny — 아닌 경우 approve + 관찰 신호로 강등.
 *
 * 사용:
 * ```ts
 * import { canBlock } from './blocking-allowlist.js';
 * if (someCondition) {
 *   console.log(blockOrObserve(hookName, 'reason', logCallback));
 *   return;
 * }
 * ```
 *
 * 점진 마이그레이션 — 본 helper 를 새로 사용하는 hook 은 ALLOW-LIST 외라면
 * 자동 관찰 모드로 작동. 기존 hook 들은 별도 PR 에서 마이그레이션.
 */
export function denyOrObserve(hookName: string, reason: string, observer?: (msg: string) => void): string {
  if (canBlock(hookName)) {
    return deny(reason);
  }
  // ALLOW-LIST 외 — log only, approve
  if (observer) {
    try { observer(`[${hookName}] would-deny (observe-only): ${reason}`); } catch { /* fail-open */ }
  }
  return approve();
}

/**
 * Stop hook only — block the agent from stopping and feed a self-check
 * question back to Claude so the current session resumes with new guidance.
 *
 * `reason` becomes the next-turn content (Claude reads this verbatim), while
 * `systemMessage` is auxiliary context rendered alongside. Put the whole
 * self-check question in `reason`; keep `systemMessage` to a short rule tag.
 *
 * Source: Stop hook spec — `decision: "block"` "prevents stopping and continues the agent's work".
 */
export function blockStop(reason: string, systemMessage?: string): string {
  return JSON.stringify({
    continue: true,
    decision: 'block',
    reason,
    ...(systemMessage ? { systemMessage } : {}),
  });
}

/**
 * fail-open with error tracking: 에러 시 안전하게 통과하되, 실패 정보를 기록.
 * forgen doctor의 Hook Health 섹션에서 실패 이력을 표시할 수 있도록 JSONL 로그에 기록.
 *
 * v0.4.1 (2026-04-24): optional `err` 매개변수 추가. 실 데이터상 106건의 hook 에러가
 * 누적됐으나 전부 `{hook,at}` 만이라 근원 조사 불가했다. 이제 `error`/`stack` 을
 * 함께 기록해 `forgen doctor` 가 원인 카테고리별로 빈도 surface 가능.
 * payload 는 한 줄 cap(400자)로 잘라 JSONL 크기 폭주 방지.
 *
 * @fail-open: hook failure must never block the user's workflow
 */
export function failOpenWithTracking(hookName: string, err?: unknown): string {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const logPath = path.join(STATE_DIR, 'hook-errors.jsonl');
    const payload: Record<string, unknown> = { hook: hookName, at: Date.now() };
    if (err !== undefined && err !== null) {
      if (err instanceof Error) {
        payload.error = err.message.slice(0, 400);
        if (err.stack) {
          // 스택 첫 3줄만 — 어느 파일/라인에서 throw 됐는지만 알면 충분.
          payload.stack = err.stack.split('\n').slice(0, 3).join(' | ').slice(0, 400);
        }
        const maybeCode = (err as unknown as { code?: unknown }).code;
        if (typeof maybeCode === 'string') payload.code = maybeCode;
      } else {
        payload.error = String(err).slice(0, 400);
      }
    }
    const entry = JSON.stringify(payload);
    fs.appendFileSync(logPath, entry + '\n');
  } catch { /* fail-open: tracking itself must not throw */ }
  return JSON.stringify({ continue: true });
}
