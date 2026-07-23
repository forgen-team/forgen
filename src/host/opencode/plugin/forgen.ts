/**
 * forgen OpenCode 가드 러너 (W3-3 P1, adapter-plan §4.1 in-process-plugin binding).
 *
 * OpenCode `tool.execute.before` → forgen 기존 PreToolUse 가드(pre-tool-use/db-guard) 브릿지의
 * *핵심 로직*. `forgen opencode-guard` CLI(guard-cli.ts)가 이 함수를 호출한다. 실 배포되는
 * 플러그인(assets/opencode/forgen.ts)은 이 CLI 를 async 로 부르는 얇은 shim 이라, OpenCode
 * 이벤트루프를 막지 않는다.
 *
 * 리뷰 MED (a): spawnSync 는 in-process 플러그인에서 이벤트루프를 막으므로 **async spawn**
 * (execFile+await)으로 구현. (b): spawn 실패는 fail-open 하되 **로그**를 남겨 systematically
 * -broken 가드를 관찰 가능하게 한다.
 *
 * fail-open 정책: 가드 해소/spawn 실패는 도구를 막지 않는다(forgen hook 실패 정책과 동일).
 */

import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '../../../core/logger.js';
import {
  type ClaudePreToolInput,
  type OpencodeToolDecision,
  decisionFromForgenOutput,
  toolBeforeToClaudeInput,
} from '../translate.js';

const execFileAsync = promisify(execFile);
const log = createLogger('opencode-guard');

/** PreToolUse 가드 순서: pre-tool-use(룰+위험명령 디스패처) → db-guard(rm -rf/위험 SQL). */
export const PRE_TOOL_GUARDS = ['pre-tool-use.js', 'db-guard.js'] as const;

export interface GuardRunOptions {
  /** forgen hook 바이너리 디렉터리. guard-cli 가 forgen dist/hooks 를 주입. */
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
 * **async** — execFile 로 비동기 spawn (이벤트루프 비차단). 어느 가드든 deny 하면 즉시 block.
 * 전부 통과/실패(fail-open)면 block=false. spawn 실패는 로그 후 계속(fail-open).
 */
export async function runPreToolGuards(
  claudeInput: ClaudePreToolInput,
  opts: GuardRunOptions = {},
): Promise<OpencodeToolDecision> {
  const dir = resolveHookDir(opts.hookDir);
  const stdin = JSON.stringify(claudeInput);
  const timeout = opts.timeoutMs ?? 5000;
  for (const guard of PRE_TOOL_GUARDS) {
    try {
      const child = execFileAsync('node', [path.join(dir, guard)], { timeout, encoding: 'utf-8' });
      child.child.stdin?.end(stdin);
      const { stdout } = await child;
      const decision = decisionFromForgenOutput(stdout ?? '');
      if (decision.block) return decision;
    } catch (e) {
      // fail-open, 그러나 관찰 가능하게 — systematically-broken 가드 발견용 (리뷰 MED b).
      // execFile 은 non-zero exit(가드가 정상 deny 로 종료해도)에서 throw 할 수 있어 stdout 을 확인.
      const stdout = (e as { stdout?: string })?.stdout;
      if (typeof stdout === 'string') {
        const decision = decisionFromForgenOutput(stdout);
        if (decision.block) return decision;
      }
      log.debug(`opencode 가드 spawn 실패(fail-open): ${guard}`, e);
    }
  }
  return { block: false };
}
