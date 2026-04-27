#!/usr/bin/env node
/**
 * Forgen — Forge Loop Progress Injector
 *
 * Claude Code UserPromptSubmit 훅. forge-loop active=true 인 동안 매 프롬프트
 * 마다 진행 상황(N/M, next story)을 컨텍스트에 inject 한다. RC6 가드의 두 번째
 * 축 — 세션 도중에도 forge-loop 가 컨텍스트에서 사라지지 않게 함.
 */

import { readStdinJSON } from './shared/read-stdin.js';
import { isHookEnabled } from './hook-config.js';
import { approve, approveWithContext, failOpenWithTracking } from './shared/hook-response.js';
import { recordHookTiming } from './shared/hook-timing.js';
import { readForgeLoopState, renderForgeLoopForPrompt } from './shared/forge-loop-state.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('forge-loop-progress');

interface HookInput {
  prompt?: string;
  session_id?: string;
}

async function main(): Promise<void> {
  const _hookStart = Date.now();
  try {
    await readStdinJSON<HookInput>().catch((e) => { log.debug('stdin read failed', e); return null; });
    if (!isHookEnabled('forge-loop-progress')) {
      console.log(approve());
      return;
    }
    const block = renderForgeLoopForPrompt(readForgeLoopState());
    if (!block) {
      console.log(approve());
      return;
    }
    console.log(approveWithContext(block, 'UserPromptSubmit'));
  } finally {
    recordHookTiming('forge-loop-progress', Date.now() - _hookStart, 'UserPromptSubmit');
  }
}

main().catch((e) => {
  process.stderr.write(`[ch-hook] forge-loop-progress: ${e instanceof Error ? e.message : String(e)}\n`);
  console.log(failOpenWithTracking('forge-loop-progress', e));
});
