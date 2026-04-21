#!/usr/bin/env node
/**
 * Forgen — PermissionRequest Hook
 *
 * 사용자 권한 요청 시 활성 모드에 따른 자동 승인/거부 정책 적용.
 * - autopilot 모드: 안전한 도구는 자동 승인
 * - 위험 패턴: 항상 사용자 확인 요구
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../core/logger.js';

const log = createLogger('permission-handler');
import { readStdinJSON } from './shared/read-stdin.js';
import { sanitizeId } from './shared/sanitize-id.js';
import { isHookEnabled } from './hook-config.js';
import { approve, approveWithWarning, failOpenWithTracking } from './shared/hook-response.js';
import { STATE_DIR } from '../core/paths.js';

interface PermissionInput {
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  session_id?: string;
}

/** 자동 승인 가능한 안전 도구 목록 */
export const SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'Agent', 'LSP', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
]);

/** autopilot 모드에서도 수동 확인이 필요한 도구 */
export const ALWAYS_CONFIRM_TOOLS = new Set([
  'Bash', 'Write', 'Edit',
]);

/**
 * 도구 분류: pass-through 결정 (순수 함수).
 *
 * Audit clarification #4 (2026-04-21): 본 훅은 Claude의 기본 권한 흐름을
 * 가로채지 않는다 — 모든 return 라벨은 "어떤 pass-through 경로인가"를
 * 의미하며, `permissionDecision: 'allow'`를 강제하지 않는다. 과거 라벨
 * `auto-approve-safe`, `autopilot-approve`는 승인으로 오해되어 audit log가
 * 실제 실행 신뢰도와 어긋났다.
 */
export function classifyTool(
  toolName: string,
  isAutopilot: boolean,
): 'safe-pass-through' | 'autopilot-warn-pass-through' | 'autopilot-pass-through' | 'pass-through' {
  if (SAFE_TOOLS.has(toolName)) return 'safe-pass-through';
  if (!isAutopilot) return 'pass-through';
  if (ALWAYS_CONFIRM_TOOLS.has(toolName)) return 'autopilot-warn-pass-through';
  return 'autopilot-pass-through';
}

/** autopilot 모드 활성 여부 확인 */
function isAutopilotActive(): boolean {
  const modes = ['autopilot', 'ralph', 'ultrawork'];
  for (const mode of modes) {
    const statePath = path.join(STATE_DIR, `${mode}-state.json`);
    try {
      if (fs.existsSync(statePath)) {
        const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        if (data.active) return true;
      }
    } catch (e) { log.debug(`mode state file parse failed: ${mode}`, e); }
  }
  return false;
}

/** 권한 요청 로그 기록 */
function logPermissionRequest(sessionId: string, toolName: string, decision: string): void {
  try {
    const logPath = path.join(STATE_DIR, `permissions-${sanitizeId(sessionId)}.jsonl`);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      tool: toolName,
      decision,
    });
    fs.appendFileSync(logPath, `${entry}\n`);
  } catch (e) {
    log.debug('권한 로그 기록 실패', e);
  }
}

async function main(): Promise<void> {
  const data = await readStdinJSON<PermissionInput>();
  if (!data) {
    console.log(approve());
    return;
  }
  if (!isHookEnabled('permission-handler')) {
    console.log(approve());
    return;
  }

  const toolName = data.tool_name ?? data.toolName ?? '';
  const sessionId = data.session_id ?? 'default';

  // Audit note #4 (2026-04-21): `approve()` / `approveWithWarning()` 둘 다
  // Claude Code hook protocol에서 `permissionDecision: 'allow'`를 설정하지
  // 않는다. 따라서 본 훅은 실제로 도구 실행을 "승인(force-allow)"하지 않고,
  // Claude의 기본 권한 흐름으로 pass-through 시킨다 (systemMessage UI 경고는
  // 선택사항). 과거 로그에서 `auto-approve-safe` / `autopilot-approve` 같은
  // 결정 이름이 실제 효과와 어긋났기에 로그 라벨을 실효에 맞춰 정정했다.
  //
  // SAFE_TOOLS (Read/Glob/Grep 등): Claude 기본 정책상 이미 허용되는 도구이므로
  // 이곳에서 별도 장치 없이 pass-through. 로그는 `safe-pass-through`로 기록.
  if (SAFE_TOOLS.has(toolName)) {
    logPermissionRequest(sessionId, toolName, 'safe-pass-through');
    console.log(approve());
    return;
  }

  // autopilot 모드가 아니면 기본 동작 (Claude Code 기본 권한 흐름)
  if (!isAutopilotActive()) {
    logPermissionRequest(sessionId, toolName, 'pass-through');
    console.log(approve());
    return;
  }

  // autopilot 모드 (2차 방어선):
  // pre-tool-use 훅이 위험 패턴(rm -rf, git push --force 등)을 이미 block/warn 처리함.
  // 여기 도달하는 도구는 pre-tool-use를 통과한 것으로 pass-through + UI 경고.
  // 여전히 Claude의 기본 confirmation은 사용자에게 노출된다 — 본 훅이 전체
  // 승인을 가로채는 게 아니라 추적성을 위한 어노테이션이다.
  if (ALWAYS_CONFIRM_TOOLS.has(toolName)) {
    logPermissionRequest(sessionId, toolName, 'autopilot-warn-pass-through');

    // Bash는 pre-tool-use를 통과했더라도 경고 강도를 높임 (임의 셸 실행 위험)
    const warningLevel = toolName === 'Bash'
      ? `[Forgen] ⚠ Autopilot: Bash tool — passed pre-tool-use validation. Beware of unexpected commands.`
      : `[Forgen] Autopilot: ${toolName} tool use passed through with warning.`;

    console.log(approveWithWarning(`<compound-permission>\n${warningLevel}\n</compound-permission>`));
    return;
  }

  // 기타 도구: autopilot 모드에서도 pass-through (force-approve 아님).
  // 과거 로그 라벨은 `autopilot-approve`였으나 실제 효과는 pass-through.
  logPermissionRequest(sessionId, toolName, 'autopilot-pass-through');
  console.log(approve());
}

main().catch((e) => {
  process.stderr.write(`[ch-hook] ${e instanceof Error ? e.message : String(e)}\n`);
  console.log(failOpenWithTracking('permission-handler'));
});
