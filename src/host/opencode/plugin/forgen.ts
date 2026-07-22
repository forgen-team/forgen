/**
 * forgen OpenCode plugin 슬림 (W3-3 P1, adapter-plan §4.1 in-process-plugin binding).
 *
 * OpenCode 는 in-process TS plugin 을 로드한다(`.opencode/plugins/` 또는
 * `~/.config/opencode/plugins/`). 이 슬림은 OpenCode 의 `tool.execute.before` 이벤트를
 * forgen 의 *기존* subprocess hook(pre-tool-use / db-guard, Claude PreToolUse schema)으로
 * 브릿지한다 — deny → throw(도구 차단). 번역은 순수 모듈 translate.ts 재사용.
 *
 * 정직성: block-tool-use 는 capabilities-opencode 에서 supported(throw). 이 슬림이 그
 * 계약의 실제 배선이다. (secret-filter=PostToolUse·inject-context 는 후속 증분.)
 *
 * fail-open 정책: hook 해소/spawn 실패는 도구를 막지 않는다(forgen hook 실패 정책과 동일).
 */

import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type ClaudePreToolInput,
  type OpencodeToolDecision,
  decisionFromForgenOutput,
  toolBeforeToClaudeInput,
} from '../translate.js';

/** OpenCode plugin 계약의 최소 타입 (외부 @opencode-ai/plugin 하드의존 회피). */
type OpencodeHooks = {
  'tool.execute.before'?: (
    input: { tool?: string },
    output: { args?: Record<string, unknown> },
  ) => Promise<void> | void;
};
type OpencodePluginFn = (ctx: unknown) => Promise<OpencodeHooks> | OpencodeHooks;

/** PreToolUse 가드 순서: pre-tool-use(룰+위험명령 디스패처) → db-guard(rm -rf/위험 SQL). */
export const PRE_TOOL_GUARDS = ['pre-tool-use.js', 'db-guard.js'] as const;

export interface GuardRunOptions {
  /** forgen hook 바이너리 디렉터리. install-opencode 가 FORGEN_HOOK_DIR 로 주입. */
  hookDir?: string;
  /** spawn 타임아웃(ms). */
  timeoutMs?: number;
}

/** forgen hook 디렉터리 해소: 명시 > FORGEN_HOOK_DIR env > ~/.forgen/hooks 폴백. */
export function resolveHookDir(explicit?: string): string {
  return explicit ?? process.env.FORGEN_HOOK_DIR ?? path.join(os.homedir(), '.forgen', 'hooks');
}

/**
 * Claude PreToolUse 입력을 forgen 가드 체인에 흘려 첫 deny 를 반환(테스트 가능한 핵심).
 * 어느 가드든 deny 하면 즉시 block. 전부 통과/실패(fail-open)면 block=false.
 */
export function runPreToolGuards(claudeInput: ClaudePreToolInput, opts: GuardRunOptions = {}): OpencodeToolDecision {
  const dir = resolveHookDir(opts.hookDir);
  const stdin = JSON.stringify(claudeInput);
  for (const guard of PRE_TOOL_GUARDS) {
    try {
      const res = spawnSync('node', [path.join(dir, guard)], {
        input: stdin,
        encoding: 'utf-8',
        timeout: opts.timeoutMs ?? 5000,
      });
      const decision = decisionFromForgenOutput(res.stdout ?? '');
      if (decision.block) return decision;
    } catch {
      /* fail-open — 이 가드 실패는 도구를 막지 않는다 */
    }
  }
  return { block: false };
}

/**
 * OpenCode plugin 엔트리. OpenCode 가 이 함수를 호출해 hooks 객체를 얻는다.
 * `tool.execute.before` 에서 forgen 가드가 deny 하면 throw → OpenCode 가 도구 실행을 차단.
 */
export const forgen: OpencodePluginFn = async () => ({
  'tool.execute.before': async (input, output) => {
    const claudeInput = toolBeforeToClaudeInput(input?.tool ?? '', output?.args);
    const decision = runPreToolGuards(claudeInput);
    if (decision.block) {
      throw new Error(decision.reason ?? '[forgen] blocked by guard');
    }
  },
});

export default forgen;
