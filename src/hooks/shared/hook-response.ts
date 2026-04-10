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

/** 통과 응답 (컨텍스트 없음, 모든 이벤트 공통) */
export function approve(): string {
  return JSON.stringify({ continue: true });
}

/**
 * 통과 + 모델에 컨텍스트 주입.
 * UserPromptSubmit, SessionStart 이벤트에서만 모델에 도달함.
 */
export function approveWithContext(context: string, eventName: string): string {
  return JSON.stringify({
    continue: true,
    hookSpecificOutput: { hookEventName: eventName, additionalContext: context },
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

/** fail-open: 에러 시 안전하게 통과 */
export function failOpen(): string {
  return JSON.stringify({ continue: true });
}

/** 훅별 에러 카운트를 STATE_DIR/hook-errors.json에 누적 */
export function incrementHookErrorCount(hookName: string): void {
  try {
    const errorPath = path.join(STATE_DIR, 'hook-errors.json');
    let errors: Record<string, { count: number; lastAt: string }> = {};
    try {
      if (fs.existsSync(errorPath)) {
        errors = JSON.parse(fs.readFileSync(errorPath, 'utf-8'));
      }
    } catch { /* start fresh */ }

    if (!errors[hookName]) errors[hookName] = { count: 0, lastAt: '' };
    errors[hookName].count++;
    errors[hookName].lastAt = new Date().toISOString();

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(errorPath, JSON.stringify(errors, null, 2));
  } catch { /* meta-error in error tracking — ignore */ }
}

/**
 * fail-open + 에러 카운트 누적.
 * 훅의 main().catch() 블록에서 명시적으로 호출.
 */
export function failOpenWithTracking(hookName: string): string {
  incrementHookErrorCount(hookName);
  return JSON.stringify({ continue: true });
}
