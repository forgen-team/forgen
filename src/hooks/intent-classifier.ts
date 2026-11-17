#!/usr/bin/env node
/**
 * Forgen — Intent Classifier Hook
 *
 * Claude Code UserPromptSubmit 훅으로 등록.
 * 사용자 프롬프트를 분석하여 의도를 분류하고, 의도별 가이드를 주입합니다.
 *
 * stdin: JSON { prompt: string, ... }
 * stdout: JSON { result: "approve", message?: string }
 */

import { readStdinJSON } from './shared/read-stdin.js';
import { isHookEnabled, loadHookConfig } from './hook-config.js';
import { approve, approveWithContext, failOpenWithTracking } from './shared/hook-response.js';

export type Intent = 'implement' | 'debug' | 'refactor' | 'explain' | 'review' | 'explore' | 'design' | 'general';

interface HookInput {
  prompt: string;
  session_id?: string;
  cwd?: string;
}

interface IntentRule {
  intent: Intent;
  pattern: RegExp;
}

const INTENT_RULES: IntentRule[] = [
  { intent: 'implement', pattern: /(?:만들어|추가해|구현해|생성해|작성해|넣어|create|add|implement|build|write|make)(?:\b|(?=[가-힣\s]|$))/i },
  { intent: 'debug', pattern: /(?:에러|버그|안돼|안\s*되|안\s*됨|왜|고쳐|수정해|fix|bug|error|debug|문제|실패|fail|crash|broken)/i },
  { intent: 'refactor', pattern: /(?:리팩토링|리팩터|정리|개선|refactor|clean\s*up|improve|optimize|최적화)/i },
  { intent: 'explain', pattern: /(?:설명|알려|뭐야|뭔가요|어떻게|explain|what\s+is|how\s+does|why\s+does|tell\s+me)/i },
  { intent: 'review', pattern: /(?:리뷰|검토|review|check|audit|평가)/i },
  { intent: 'explore', pattern: /(?:찾아|어디|검색|find|search|where|locate|grep|어디에|어디서)/i },
  { intent: 'design', pattern: /(?:설계|아키텍처|구조|design|architect|structure|다이어그램|diagram)/i },
];

const INTENT_HINTS: Record<Intent, string> = {
  implement: 'Implementation task.',
  debug: 'Debug mode. Approach: reproduce → isolate → fix.',
  refactor: 'Refactoring task. Improve structure while preserving existing behavior.',
  explain: 'Explanation request. Convey core concepts concisely.',
  review: 'Code review. Classify feedback by severity.',
  explore: 'Exploration task. Use Glob/Grep to find quickly.',
  design: 'Design task. Specify trade-offs explicitly.',
  general: 'General request.',
};

/**
 * Intent-specific context rules injected via additionalContext.
 *
 * 2026-11 재설계 D2: 검증 방법을 지시하는 줄(테스트 작성·실행, build/lint/type-check, 단계마다 검증)은 넣지 않는다.
 * 이 블록은 사용자 룰을 보지 않고 매 프롬프트에 들어가서, "작업 중에는 테스트·lint 를 돌리지 마라" 같은
 * 개인 룰과 정면으로 부딪혔다(실데이터: 같은 교정 1주 6회). 검증을 언제·어떻게 할지는 사용자 룰이 정한다.
 * 예전 문구는 hooks.intent-classifier.verbose=true 로 되살릴 수 있다.
 */
const INTENT_CONTEXT: Partial<Record<Intent, string>> = {
  implement: `[quality-rules]
- Prefer small incremental changes (<200 lines)
- Interfaces and type contracts before implementation`,
  review: `[review-rules]
- Report format: [SEVERITY] file:line — issue
- Check: logic errors, security (OWASP), performance, maintainability
- Verify edge cases and error handling at system boundaries
- No empty catch blocks, no eslint-disable without justification`,
  debug: `[debug-rules]
- Reproduce the bug first, then isolate the root cause
- Check for regression: does the fix break anything else?
- Read error messages carefully — they usually point to the cause`,
  refactor: `[refactor-rules]
- Make one structural change at a time
- Preserve external behavior — refactoring changes structure, not function
- Avoid mixing refactoring with feature changes in the same pass`,
};

/** 2026-11 이전 문구 (hooks.intent-classifier.verbose=true). */
const LEGACY_HINTS: Partial<Record<Intent, string>> = { implement: 'Implementation task. Consider tests.' };
const LEGACY_CONTEXT: Partial<Record<Intent, string>> = {
  implement: `[quality-rules]
- Write tests for new logic (branch coverage 83%+)
- Build + lint + type-check must pass before completion
- Prefer small incremental changes (<200 lines)
- Interfaces and type contracts before implementation`,
  review: INTENT_CONTEXT.review,
  debug: `[debug-rules]
- Reproduce the bug first, then isolate the root cause
- Write a failing test that captures the bug before fixing
- Check for regression: does the fix break anything else?
- Read error messages carefully — they usually point to the cause`,
  refactor: `[refactor-rules]
- Ensure all tests pass before AND after refactoring
- Make one structural change at a time, verify between each
- Preserve external behavior — refactoring changes structure, not function
- Avoid mixing refactoring with feature changes in the same pass`,
};

/** 의도별로 주입할 문구. general 이면 null. */
export function buildIntentContext(intent: Intent, verbose = false): string | null {
  if (intent === 'general') return null;
  const hint = (verbose ? LEGACY_HINTS[intent] : undefined) ?? INTENT_HINTS[intent];
  const extra = (verbose ? LEGACY_CONTEXT : INTENT_CONTEXT)[intent] ?? '';
  return extra ? `[intent: ${intent}] ${hint}\n${extra}` : `[intent: ${intent}] ${hint}`;
}

export function classifyIntent(prompt: string): Intent {
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(prompt)) {
      return rule.intent;
    }
  }
  return 'general';
}

async function main(): Promise<void> {
  const input = await readStdinJSON<HookInput>();
  if (!isHookEnabled('intent-classifier')) {
    console.log(approve());
    return;
  }
  if (!input?.prompt) {
    console.log(approve());
    return;
  }

  const verbose = loadHookConfig('intent-classifier')?.verbose === true;
  const context = buildIntentContext(classifyIntent(input.prompt), verbose);
  console.log(context ? approveWithContext(context, 'UserPromptSubmit') : approve());
}

main().catch((e) => {
  process.stderr.write(`[ch-hook] ${e instanceof Error ? e.message : String(e)}\n`);
  console.log(failOpenWithTracking('intent-classifier', e));
});
