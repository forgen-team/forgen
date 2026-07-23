/**
 * `forgen opencode-context` — OpenCode plugin 이 compaction 시 주입할 forgen context 출력 (W3-3 P1).
 *
 * OpenCode 의 유일한 문서화된 context 주입 표면은 `experimental.session.compacting`
 * (output.context.push) — *compaction 시점*에 context 를 얹는다. forgen 은 여기에 활성
 * forge-loop 상태(≤1KB)를 얹어 **compaction 을 넘어 목표가 유지**되게 한다
 * (forge-loop-state-inject intent, capabilities-opencode=partial).
 *
 * 정직한 스코프: Claude 의 per-prompt 주입(UserPromptSubmit)과 달리 OpenCode 플러그인은
 * 매 프롬프트 주입 표면이 문서화돼 있지 않다 → 정적 룰은 AGENTS.md(install), compound 는
 * MCP tool 로 커버하고, 동적 forge-loop 상태만 compaction 에 얹는다.
 *
 * 활성 forge-loop 이 없으면 빈 출력(주입할 것 없음).
 */

import { readForgeLoopState, renderForgeLoopForSession } from '../../hooks/shared/forge-loop-state.js';

export function runOpencodeContext(): void {
  let block: string | null = null;
  try {
    block = renderForgeLoopForSession(readForgeLoopState());
  } catch {
    block = null; // fail-safe — 주입 실패가 세션을 막지 않는다
  }
  process.stdout.write(block ?? '');
}
