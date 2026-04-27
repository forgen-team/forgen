/**
 * Codex exec --json 출력 파서 — feat/codex-support Phase 2 (P2-1)
 *
 * codex exec --json 의 stdout 은 JSONL — 한 줄에 하나씩 이벤트.
 * 본 파서는 agent_message 만 추출하여 문자열로 반환.
 *
 * 출력 형식 (실측 2026-04-27, Codex 0.125.0):
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{...}}
 *
 * spec §10 P2-1 산출물 — Phase 2 의 compound-extractor 가 host-aware 분기 시 사용.
 */

export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface CodexExecResult {
  /** 모든 agent_message text 를 join. 보통 1개. */
  readonly message: string;
  /** 모든 agent_message segment (디버깅/multi-turn 용). */
  readonly segments: ReadonlyArray<string>;
  /** turn.completed 의 usage (없으면 null). */
  readonly usage: CodexUsage | null;
  /** thread.started 의 thread_id. */
  readonly threadId: string | null;
  /** parse 실패한 line 수 (의미 있는 신호 — 0 이 아니면 형식 변경 신호). */
  readonly parseFailures: number;
}

/**
 * codex exec --json 의 stdout 을 받아 agent message + 메타 추출.
 * stderr 의 hook 발화 noise 는 *별도* — 본 함수는 stdout 만 처리.
 *
 * fail-open: parse 실패 line 은 무시하되 카운터로 보고.
 */
export function parseCodexJsonlOutput(stdout: string): CodexExecResult {
  const segments: string[] = [];
  let usage: CodexUsage | null = null;
  let threadId: string | null = null;
  let parseFailures = 0;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith('{')) continue; // ANSI / status line skip

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parseFailures += 1;
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const event = parsed as Record<string, unknown>;
    const type = event.type;

    if (type === 'thread.started') {
      const tid = (event as { thread_id?: string }).thread_id;
      if (typeof tid === 'string') threadId = tid;
    } else if (type === 'item.completed') {
      const item = (event as { item?: { type?: string; text?: string } }).item;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        segments.push(item.text);
      }
    } else if (type === 'turn.completed') {
      const u = (event as { usage?: CodexUsage }).usage;
      if (u && typeof u === 'object') usage = u;
    }
  }

  return {
    message: segments.join('\n'),
    segments,
    usage,
    threadId,
    parseFailures,
  };
}
