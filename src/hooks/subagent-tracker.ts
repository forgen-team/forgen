#!/usr/bin/env node
/**
 * Forgen — SubagentStart/Stop Hook
 *
 * 에이전트 생성/종료 추적.
 * - 활성 에이전트 수 모니터링 + 동시 실행 경고 (ADR-009 §4: 기본 16, workflow 면제)
 * - 에이전트 실행 이력 기록
 * - ADR-009 §A: 상태 갱신을 file-lock 으로 보호 (동시 fanout lost-update 방지)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readStdinJSON } from './shared/read-stdin.js';
import { isHookEnabled } from './hook-config.js';
import { sanitizeId } from './shared/sanitize-id.js';
import { atomicWriteJSON } from './shared/atomic-write.js';
import { approve, approveWithWarning, failOpenWithTracking } from './shared/hook-response.js';
import { withFileLock } from './shared/file-lock.js';
import { STATE_DIR } from '../core/paths.js';

/**
 * 동시 에이전트 경고 임계값.
 * ADR-009 §4: dynamic workflows 는 동시 16 까지 정상 사용하므로 기본값을 16 으로
 * 올리고 env 로 조정 가능하게 한다. 과거 10 고정값은 workflow/team/swarm 실행마다
 * 거짓 경고를 뱉었다.
 */
export function maxConcurrentAgents(): number {
  const env = Number(process.env.FORGEN_MAX_CONCURRENT_AGENTS);
  return Number.isFinite(env) && env > 0 ? env : 16;
}

/**
 * Claude Code 가 dynamic-workflow 내부 에이전트에 부여하는 agentType (probe 실측,
 * 2026-05-29). 워크플로우 에이전트는 동시 16 이 정상이므로 동시성 경고에서 면제한다.
 */
const WORKFLOW_AGENT_TYPE = 'workflow-subagent';

/**
 * 동시성 경고를 띄울지 결정 (순수 — 테스트 대상).
 * ADR-009 §4/§B: workflow-subagent 는 동시 16 이 정상이므로 면제. 그 외 에이전트가
 * 임계값을 초과할 때만 경고.
 */
export function shouldWarnConcurrency(agentType: string, activeCount: number, max: number): boolean {
  if (agentType === WORKFLOW_AGENT_TYPE) return false;
  return activeCount > max;
}

const AGENT_GC_AGE_MS = 60 * 60 * 1000; // 1시간 이상 종료된 에이전트는 GC

interface AgentEntry {
  agentId: string;
  agentType?: string;
  model?: string;
  startedAt: string;
  stoppedAt?: string;
}

interface AgentsState {
  sessionId: string;
  agents: AgentEntry[];
}

export interface AgentEvent {
  sessionId: string;
  action: 'start' | 'stop';
  agentId: string;
  agentType?: string;
  model?: string;
}

function getAgentsStatePath(sessionId: string): string {
  return path.join(STATE_DIR, `active-agents-${sanitizeId(sessionId)}.json`);
}

function loadAgentsStateAt(statePath: string, sessionId: string): AgentsState {
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
  } catch { /* parse failure — starting fresh, prior agent history for this session is lost */ }
  return { sessionId, agents: [] };
}

function saveAgentsStateAt(statePath: string, state: AgentsState): void {
  // GC: 1시간 이상 종료된 에이전트 제거
  const now = Date.now();
  state.agents = state.agents.filter(a => {
    if (!a.stoppedAt) return true; // 활성 에이전트는 유지
    return now - new Date(a.stoppedAt).getTime() < AGENT_GC_AGE_MS;
  });
  atomicWriteJSON(statePath, state);
}

/**
 * 에이전트 이벤트를 file-lock 아래에서 적용한다 (ADR-009 §A).
 *
 * 락이 없던 시절에는 동시 SubagentStart (워크플로우 fanout) 가 같은 active-agents
 * 파일을 read-modify-write 하면서 lost-update 로 일부 에이전트가 누락됐다 (probe 에서
 * 3개 중 1개 손실 관찰). 락 안에서 **fresh re-read** 후 mutate 해야 변경이 보존된다.
 * staleMs 는 hook fn 이 짧으므로 5s 로 단축.
 *
 * statePath 는 테스트 주입용 (기본은 sessionId 파생 경로). 반환값은 start 후 활성
 * 에이전트 수 (경고 판정에 사용; stop 은 0).
 */
export async function recordAgentEvent(
  ev: AgentEvent,
  statePath: string = getAgentsStatePath(ev.sessionId),
): Promise<{ activeCount: number }> {
  fs.mkdirSync(path.dirname(statePath), { recursive: true }); // lock 파일 생성 전 디렉토리 보장
  let activeCount = 0;
  await withFileLock(
    statePath,
    () => {
      const state = loadAgentsStateAt(statePath, ev.sessionId); // 락 안에서 fresh re-read
      if (ev.action === 'start') {
        state.agents.push({
          agentId: ev.agentId,
          agentType: ev.agentType || undefined,
          model: ev.model,
          startedAt: new Date().toISOString(),
        });
        activeCount = state.agents.filter(a => !a.stoppedAt).length;
      } else if (ev.action === 'stop') {
        const agent = state.agents.find(a => a.agentId === ev.agentId && !a.stoppedAt);
        if (agent) agent.stoppedAt = new Date().toISOString();
      }
      saveAgentsStateAt(statePath, state);
    },
    { staleMs: 5000 },
  );
  return { activeCount };
}

async function main(): Promise<void> {
  const data = await readStdinJSON();
  // hook-registry에서는 subagent-tracker-start/stop으로 분리 등록됨
  const suffix = process.argv[2] === 'stop' ? 'stop' : 'start';
  if (!isHookEnabled(`subagent-tracker-${suffix}`)) {
    console.log(approve());
    return;
  }
  if (!data) {
    console.log(approve());
    return;
  }

  const sessionId = (data.session_id as string) ?? 'default';
  // 이벤트 타입은 argv[2] 또는 data 필드에서 판별
  const action = (process.argv[2] ?? (data.action as string) ?? '') === 'stop' ? 'stop' : 'start';
  const agentId = (data.agent_id as string) ?? (data.agentId as string) ?? `agent-${Date.now()}`;
  const agentType = (data.agent_type as string) ?? (data.agentType as string) ?? (data.subagent_type as string) ?? '';
  const model = (data.model as string) ?? (data.agentModel as string) ?? undefined;

  // ADR-009 §A: 상태 갱신은 file-lock 아래에서. 락 실패/타임아웃은 .catch 의 fail-open
  // 으로 흡수 (추적은 best-effort — 에이전트 실행 자체를 막지 않는다).
  const { activeCount } = await recordAgentEvent({ sessionId, action, agentId, agentType, model });

  // 동시성 경고 (락 밖). 면제/임계값 판정은 shouldWarnConcurrency (테스트 박제).
  if (action === 'start' && shouldWarnConcurrency(agentType, activeCount, maxConcurrentAgents())) {
    console.log(approveWithWarning(`<compound-tool-warning>\n[Forgen] ⚠ ${activeCount} active agents — too many concurrent executions. Watch resource usage.\n</compound-tool-warning>`));
    return;
  }

  console.log(approve());
}

// import.meta 가드: 직접 실행 시에만 main() — 테스트가 헬퍼를 import 할 때
// stdin 을 읽는 main 이 돌지 않도록 한다 (모듈 위생).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`[ch-hook] ${e instanceof Error ? e.message : String(e)}\n`);
    console.log(failOpenWithTracking('subagent-tracker', e));
  });
}
