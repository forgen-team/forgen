#!/usr/bin/env node
/**
 * Forgen — SubagentStop Guard (ADR-009 §2)
 *
 * 워크플로우/Task subagent 의 마지막 응답에 메타 가드(TEST-1/2/3 + DANGEROUS)를
 * 적용한다. probe 실측(2026-05-29)으로 워크플로우 내부 에이전트도 forgen 훅을
 * 발화함이 확인되어, 대화 밖에서 수행되는 subagent 산출물도 검증 사각지대에서
 * 끌어낸다. SubagentStop 은 `decision:"block"` + `reason` 을 지원하므로(공식 문서
 * 확인) 메인 Stop 과 동일한 Mech-B 재개 메커니즘이 작동한다.
 *
 * 설계 (ADR-009 §2a/2c/2d):
 *   - 평가 본체는 checks/_shared/meta-guard-dispatch.runMetaGuards 를 Stop 과 공유.
 *   - block-count 는 (sessionId, agentId) 합성 키로 분리 → 동시 subagent 간 stuck-
 *     loop 카운터 충돌 방지 (2c).
 *   - recentTools 는 per-agent modified-files (post-tool-use 2d 키) 에서 로드 →
 *     subagent 자기 tool 윈도우로 TEST-1/2 를 정확히 판정 (2d).
 *
 * fail-open: 어떤 단계든 throw/누락이면 approve. subagent 추적/검증은 best-effort —
 * 에이전트 실행을 막지 않는다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readStdinJSON } from './shared/read-stdin.js';
import { approve, blockStop, failOpenWithTracking } from './shared/hook-response.js';
import { isHookEnabled } from './hook-config.js';
import { sanitizeId } from './shared/sanitize-id.js';
import { recordHookTiming } from './shared/hook-timing.js';
import { STATE_DIR } from '../core/paths.js';
import { runMetaGuards } from '../checks/_shared/meta-guard-dispatch.js';
import { recordViolation } from '../engine/lifecycle/signals.js';
import {
  incrementBlockCount,
  resetBlockCount,
  getStuckLoopThreshold,
  logDriftEvent,
} from './stop-guard.js';

const HOOK_NAME = 'subagent-stop-guard';

interface SubagentStopInput {
  session_id?: string;
  transcript_path?: string;
  agent_id?: string;
  agentId?: string;
  agent_type?: string;
  agentType?: string;
}

/** SubagentStop 에는 last_assistant_message 가 없으므로 transcript JSONL 을 역순 스캔. */
export function readLastAssistantFromTranscript(transcriptPath?: string): string | null {
  if (!transcriptPath) return null;
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { role?: string; content?: unknown };
        if (entry.role !== 'assistant') continue;
        if (typeof entry.content === 'string') return entry.content;
        if (Array.isArray(entry.content)) {
          const parts = entry.content
            .map((p: unknown) => {
              if (typeof p === 'string') return p;
              if (p && typeof p === 'object' && 'text' in p) return String((p as { text: unknown }).text);
              return '';
            })
            .filter(Boolean);
          if (parts.length) return parts.join('\n');
        }
      } catch {
        // skip malformed line
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** ADR-009 §2d: per-agent modified-files 에서 recentToolNames 로드. 없으면 []. */
function loadAgentRecentTools(sessionId: string, agentId: string): string[] {
  try {
    const key = `${sessionId}.agent-${agentId}`;
    const p = path.join(STATE_DIR, `modified-files-${sanitizeId(key)}.json`);
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as { recentToolNames?: unknown };
    if (Array.isArray(data.recentToolNames)) {
      return data.recentToolNames.filter((n): n is string => typeof n === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

export async function main(): Promise<void> {
  const started = Date.now();
  try {
    if (!isHookEnabled(HOOK_NAME)) {
      console.log(approve());
      return;
    }

    const input = await readStdinJSON<SubagentStopInput>();
    const lastMessage = readLastAssistantFromTranscript(input?.transcript_path);
    if (!lastMessage) {
      console.log(approve());
      return;
    }

    // 사용자 명시 우회 — 메인 Stop 과 일관.
    if (process.env.FORGEN_USER_CONFIRMED === '1') {
      console.log(approve());
      return;
    }

    const sessionId = input?.session_id ?? 'unknown';
    const agentId = input?.agent_id ?? input?.agentId ?? 'unknown';
    const recentTools = loadAgentRecentTools(sessionId, agentId);

    const results = runMetaGuards({ lastMessage, recentTools, minMeasurements: 1 });
    // 2c: stuck-loop 카운터를 (sessionId, agentId) 로 분리해 동시 subagent 간 충돌 방지.
    const counterKey = `${sessionId}:${agentId}`;

    for (const r of results) {
      recordViolation({
        rule_id: `builtin:${r.shortId}`,
        session_id: sessionId,
        source: HOOK_NAME,
        kind: r.kind,
        message_preview: lastMessage.slice(0, 120),
      });
      if (r.kind !== 'block') continue;

      const count = incrementBlockCount(counterKey, r.shortId);
      if (count > getStuckLoopThreshold()) {
        // 같은 subagent 가 같은 가드에 반복 차단 → block reason 에 말려든 루프.
        // force approve + drift 기록 후 카운터 리셋 (메인 Stop 과 동일 정책).
        logDriftEvent({
          kind: 'subagent_stuck_loop_force_approve',
          session_id: counterKey,
          rule_id: r.shortId,
          count,
          reason_preview: r.reason.slice(0, 120),
          message_preview: lastMessage.slice(0, 120),
        });
        resetBlockCount(counterKey, r.shortId);
        console.log(approve());
        return;
      }

      const reasonText = `[forgen:subagent-stop-guard/${r.shortId}] (agent ${agentId.slice(0, 8)}) ${r.reason}

(Override this turn: set FORGEN_USER_CONFIRMED=1 (audited).)`;
      console.log(blockStop(reasonText, r.ruleSlug));
      return;
    }

    console.log(approve());
  } catch (e) {
    console.log(failOpenWithTracking(HOOK_NAME, e));
  } finally {
    recordHookTiming(HOOK_NAME, Date.now() - started, 'SubagentStop');
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  void main();
}
