/**
 * Codex 훅 생존 마커 — ADR-016 D1
 *
 * Codex 는 미승인(untrusted)/변경된(modified) 훅을 조용히 skip 한다. "forgen 훅이 실제로 실행되고 있는가"
 * 를 관측하는 유일한 choke point 는 codex-adapter 다 (Codex 가 forgen 훅을 실행하면 반드시 거친다).
 * 어댑터가 턴 경계 이벤트에서 전역 마커를 갱신하고, notify 폴백(codex-notify)이 그 신선도를 본다.
 *
 * 훅 신뢰 상태는 hooks.json 단위로 모든 세션이 공유하므로 마커는 세션별이 아니라 전역 1개다.
 * 어댑터가 매 훅마다 import 하므로 의존성은 node 내장 + paths 만 둔다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from '../core/paths.js';

export const CODEX_HOOK_ALIVE_PATH = path.join(STATE_DIR, 'codex-hook-alive.json');

/** notify 는 Stop 훅 직후 발화한다. Stop 훅 타임아웃(10s) 대비 넉넉한 창. */
export const CODEX_HOOK_ALIVE_WINDOW_MS = 120_000;

/** 턴 경계 이벤트만 기록 — PreToolUse/PostToolUse 마다 쓰지 않는다. */
const ALIVE_EVENTS: ReadonlySet<string> = new Set(['Stop', 'SubagentStop', 'UserPromptSubmit']);

export interface CodexHookAliveMarker {
  at: number;
  event: string;
  sessionId?: string;
}

/** 어댑터 입력(stdin JSON)으로 마커 갱신. 대상 이벤트가 아니면 no-op. 실패는 삼킨다 (fail-open). */
export function markCodexHookAlive(input: unknown, now: number = Date.now()): boolean {
  try {
    const i = (input ?? {}) as { hook_event_name?: unknown; hookEventName?: unknown; session_id?: unknown };
    const event = typeof i.hook_event_name === 'string' ? i.hook_event_name
      : typeof i.hookEventName === 'string' ? i.hookEventName : '';
    if (!ALIVE_EVENTS.has(event)) return false;
    const marker: CodexHookAliveMarker = { at: now, event };
    if (typeof i.session_id === 'string') marker.sessionId = i.session_id;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CODEX_HOOK_ALIVE_PATH, JSON.stringify(marker));
    return true;
  } catch {
    return false;
  }
}

export function readCodexHookAlive(): CodexHookAliveMarker | null {
  try {
    const m = JSON.parse(fs.readFileSync(CODEX_HOOK_ALIVE_PATH, 'utf-8')) as CodexHookAliveMarker;
    return typeof m.at === 'number' && Number.isFinite(m.at) ? m : null;
  } catch {
    return null;
  }
}

/** 최근 window 안에 forgen 훅이 Codex 에서 실행됐는가. */
export function isCodexHookAlive(now: number = Date.now(), windowMs: number = CODEX_HOOK_ALIVE_WINDOW_MS): boolean {
  const m = readCodexHookAlive();
  return m !== null && now - m.at >= 0 && now - m.at < windowMs;
}
