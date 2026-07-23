/**
 * OpenCode ↔ Claude hook translation (W3-3 P1 plugin 슬림, adapter-plan §4.1).
 *
 * OpenCode 는 in-process TS plugin(`tool.execute.before(input, output)`)이라 forgen 의
 * subprocess hook(Claude PreToolUse schema stdin/stdout)과 형태가 다르다. 이 모듈은 그 사이
 * *순수* 번역만 담당한다 — spawn/파일 IO 는 plugin shim(forgen.ts)이 수행.
 *
 * 번역 축:
 *   1. tool 이름: opencode(소문자 bash/read/write/edit…) → Claude(Bash/Read/Write/Edit…).
 *   2. tool 인자 키: opencode(filePath) → Claude(file_path) 등, 가드가 읽는 필드 정합.
 *   3. 결정: forgen PreToolUse 출력(permissionDecision:deny) → OpenCode block(throw) 신호.
 *
 * 이 계약은 docs-level(adapter-plan §2.2 web probe) 기반이며, 실제 OpenCode tool 스키마로
 * plugin 슬림 통합 시 검증·보정한다.
 */

/** Claude PreToolUse hook 에 넣을 입력 (forgen hook 이 stdin 으로 받는 형태). */
export interface ClaudePreToolInput {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/** forgen PreToolUse hook 결정 → OpenCode 로 번역한 판정. */
export interface OpencodeToolDecision {
  /** true 면 plugin 이 throw 해서 도구 실행을 차단. */
  block: boolean;
  reason?: string;
}

/**
 * OpenCode tool 이름 → Claude tool 이름. forgen 가드(db-guard/pre-tool-use)가 Claude tool
 * 이름 관습(Bash/Read/Write/Edit)으로 매칭하므로 정합이 필요하다.
 */
export const OPENCODE_TO_CLAUDE_TOOL: Readonly<Record<string, string>> = Object.freeze({
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  patch: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  list: 'LS',
  webfetch: 'WebFetch',
  task: 'Task',
});

/** 매핑에 없으면 첫 글자 대문자화(안전 폴백) — 가드가 못 알아봐도 fail-open(허용). */
export function mapToolName(opencodeTool: string): string {
  if (!opencodeTool) return '';
  return OPENCODE_TO_CLAUDE_TOOL[opencodeTool.toLowerCase()] ?? (opencodeTool[0].toUpperCase() + opencodeTool.slice(1));
}

/**
 * OpenCode tool 인자 키 → Claude tool_input 키. 가드가 읽는 필드만 정규화한다:
 *   - filePath → file_path (Read/Write/Edit 대상 파일)
 *   - command 는 그대로 (Bash) — db-guard 가 tool_input.command 로 rm -rf 감지.
 * 나머지 키는 원본 유지(추가 정보는 무해).
 */
export function normalizeToolArgs(args: Record<string, unknown> | undefined | null): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const out: Record<string, unknown> = { ...args };
  if ('filePath' in out && !('file_path' in out)) {
    out.file_path = out.filePath;
  }
  return out;
}

/** OpenCode `tool.execute.before` (input.tool, output.args) → Claude PreToolUse stdin. */
export function toolBeforeToClaudeInput(
  opencodeTool: string,
  opencodeArgs: Record<string, unknown> | undefined | null,
): ClaudePreToolInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: mapToolName(opencodeTool),
    tool_input: normalizeToolArgs(opencodeArgs),
  };
}

/**
 * forgen PreToolUse hook 의 stdout(JSON 여러 줄일 수 있음) → OpenCode 판정.
 * permissionDecision:"deny" → block(throw). 그 외/파싱 실패 → 허용(fail-open — 가드 부재가
 * 도구를 막지 않는다, forgen 의 hook 실패 정책과 동일).
 */
export function decisionFromForgenOutput(stdout: string): OpencodeToolDecision {
  const parsed = lastJsonObject(stdout);
  if (!parsed || typeof parsed !== 'object') return { block: false };
  const hso = (parsed as { hookSpecificOutput?: unknown }).hookSpecificOutput;
  if (hso && typeof hso === 'object') {
    const decision = (hso as { permissionDecision?: unknown }).permissionDecision;
    if (decision === 'deny') {
      const reason = (hso as { permissionDecisionReason?: unknown }).permissionDecisionReason;
      return { block: true, reason: typeof reason === 'string' ? reason : '[forgen] blocked by guard' };
    }
  }
  return { block: false };
}

/** 텍스트에서 마지막 JSON 객체를 파싱(hook 이 로그+JSON 을 섞어 낼 수 있음). */
function lastJsonObject(raw: string): unknown | null {
  if (!raw) return null;
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* try previous line */
    }
  }
  return null;
}
