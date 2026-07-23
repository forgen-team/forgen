/**
 * `forgen opencode-guard` — OpenCode plugin 슬림이 호출하는 경량 브릿지 CLI (W3-3 P1).
 *
 * OpenCode 플러그인(`~/.config/opencode/plugins/forgen.ts`)이 `tool.execute.before` 에서
 * `{tool, args}` 를 stdin 으로 넘기면, 이 명령이 forgen PreToolUse 가드 체인을 돌려
 * `{block, reason}` 을 stdout 으로 반환한다. 플러그인은 block 이면 throw(도구 차단).
 *
 * 플러그인을 얇게 유지(= 번역/가드 로직 중복 없음, drift-free)하는 대신 forgen 이 이
 * 한 명령으로 전부 처리한다. per-tool-call 이라 cli.ts 최상단 fast-path 로 진입한다.
 *
 * fail-open: stdin 파싱 실패/가드 오류는 도구를 막지 않는다 → {block:false}.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolBeforeToClaudeInput } from './translate.js';
import { runPreToolGuards } from './plugin/forgen.js';

/** 이 CLI(dist/host/opencode/guard-cli.js) 기준 forgen dist/hooks 절대경로. */
function forgenHookDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

export async function runOpencodeGuard(): Promise<void> {
  let payload: { tool?: string; args?: Record<string, unknown> } = {};
  try {
    payload = JSON.parse((await readStdin()) || '{}');
  } catch {
    process.stdout.write(JSON.stringify({ block: false }));
    return;
  }
  const claudeInput = toolBeforeToClaudeInput(payload.tool ?? '', payload.args);
  const decision = await runPreToolGuards(claudeInput, { hookDir: forgenHookDir() });
  process.stdout.write(JSON.stringify(decision));
}
