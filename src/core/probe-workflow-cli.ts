/**
 * forgen dev probe-workflow — ADR-009 §1 결정적 미확인 변수 실측 도구.
 *
 * 질문: dynamic workflow **내부** 에이전트에 대해 SubagentStart/Stop·PostToolUse
 *       훅이 발화하는가? (워크플로우 런타임은 "대화와 분리된 격리 백그라운드"로
 *       명시되어 있어 발화 여부가 문서로 미확인.)
 *
 * 이 답이 ADR-009 §2(훅 라우트로 워크플로우까지 검증 가능) vs §3(워크플로우
 * 품질은 템플릿 라우트로만 도달)의 선택을 가른다. forgen 프로젝트 룰상 가정
 * 위에 §2 를 구현할 수 없으므로, 실제 실행 증거를 먼저 수집한다.
 *
 * 신호원 (훅이 부작용으로 남기는 state 파일 — forgen 자체 timing 계측의 공백과
 * 무관하게 직접 관측 가능):
 *   - SubagentStart/Stop → ~/.forgen/state/active-agents-*.json (agents[])
 *   - PostToolUse        → ~/.forgen/state/modified-files-*.json (mtime)
 *   - (보조) hook-timing.jsonl 의 event 별 엔트리
 *
 * 절차 (2단계 — 런타임이 격리되어 있어 단일 프로세스로는 트리거 불가):
 *   1. `forgen dev probe-workflow arm`    → baseline 마커 기록 + 안내 출력
 *   2. 사용자가 Claude Code 에서 워크플로우 1회 실행 (그 사이 다른 작업 금지)
 *   3. `forgen dev probe-workflow report` → baseline 이후 신호 수집 → verdict 박제
 *
 * 가정 (detailed-communication): arm~report 사이에 사용자가 **워크플로우만**
 * 실행했다고 전제한다. 일반 Task-tool subagent 를 같이 돌리면 신호가 섞인다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from './paths.js';

const isTTY = process.stdout.isTTY;
const C = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  red: isTTY ? '\x1b[31m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
};

const BASELINE_PATH = path.join(STATE_DIR, 'probe-workflow.json');
const RESULT_PATH = path.join(STATE_DIR, 'probe-workflow-result.json');

/** 일반 subagent 동시 실행 상한(MAX_CONCURRENT_AGENTS=10) 초과 → 워크플로우 강한 신호. */
const WORKFLOW_CONCURRENCY_HINT = 11;

export interface ProbeBaseline {
  armedAtMs: number;
  armedIso: string;
}

export interface AgentObservation {
  agentId: string;
  agentType?: string;
  model?: string;
  startedAtMs: number;
  stoppedAtMs?: number;
}

export interface ProbeObservations {
  agents: AgentObservation[];
  /** baseline 이후 modified-files-*.json 이 갱신됨 (PostToolUse 발화 신호). */
  postToolUseFired: boolean;
  /** hook-timing.jsonl 에서 baseline 이후 관측된 event 이름들. */
  hookEvents: string[];
}

export type ProbeOutcome =
  | 'workflow-hooks-fire'
  | 'workflow-hooks-absent'
  | 'inconclusive';

export interface ProbeVerdict {
  subagentStartStopFired: boolean;
  postToolUseFired: boolean;
  agentCount: number;
  maxConcurrency: number;
  agentTypes: string[];
  outcome: ProbeOutcome;
  recommendation: string;
}

/**
 * 구간 [start, stop) 들의 최대 동시 겹침 수. stoppedAt 미지정(진행 중) 은 +∞ 로 간주.
 * sweep-line: start 이벤트 +1, stop 이벤트 -1 을 시간순 정렬 후 누적 최대.
 * 동일 시각에서는 start(+1) 를 stop(-1) 보다 먼저 처리해 겹침을 과소평가하지 않는다.
 */
export function maxConcurrency(agents: AgentObservation[]): number {
  const events: { t: number; delta: number }[] = [];
  for (const a of agents) {
    events.push({ t: a.startedAtMs, delta: 1 });
    events.push({ t: a.stoppedAtMs ?? Number.POSITIVE_INFINITY, delta: -1 });
  }
  events.sort((x, y) => (x.t === y.t ? y.delta - x.delta : x.t - y.t));
  let cur = 0;
  let peak = 0;
  for (const e of events) {
    cur += e.delta;
    if (cur > peak) peak = cur;
  }
  return peak;
}

/**
 * Pure core — baseline + 관측치 → verdict. IO 없음 (단위 테스트 대상).
 *
 * 판정:
 *   - 에이전트 0 → 'workflow-hooks-absent' (단 "워크플로우를 실제로 띄웠는가"
 *     확인 전제 — recommendation 에 명시). §2 는 워크플로우 내부에 도달 못 함.
 *   - 에이전트 >0 → 'workflow-hooks-fire'. 동시 ≥11 이면 워크플로우 강한 신호.
 *     §2(SubagentStop 검증)가 워크플로우까지 커버 가능.
 */
export function analyzeProbe(obs: ProbeObservations): ProbeVerdict {
  const agentCount = obs.agents.length;
  const conc = maxConcurrency(obs.agents);
  const types = [...new Set(obs.agents.map((a) => a.agentType).filter((t): t is string => !!t))];
  const subagentFired = agentCount > 0;

  let outcome: ProbeOutcome;
  let recommendation: string;
  if (!subagentFired) {
    outcome = 'workflow-hooks-absent';
    recommendation =
      'SubagentStart/Stop 신호 0건. 워크플로우를 실제로 실행했다면 → 워크플로우 ' +
      '내부 에이전트는 forgen 훅을 거치지 않음. ADR-009 §2 는 Task-tool/team/swarm ' +
      'subagent 한정으로 제한하고, 워크플로우 품질은 §3 템플릿 라우트로만 달성한다. ' +
      '(워크플로우를 안 띄웠다면 arm 후 재시도 — inconclusive.)';
  } else {
    outcome = 'workflow-hooks-fire';
    const strong = conc >= WORKFLOW_CONCURRENCY_HINT;
    recommendation =
      `SubagentStart/Stop 발화 확인(에이전트 ${agentCount}, 최대 동시 ${conc}` +
      `${strong ? ', 워크플로우 동시성 신호 강함' : ', 동시성 낮음 — 일반 subagent 가능성 검토'}). ` +
      `ADR-009 §2(SubagentStop 검증)가 워크플로우 내부까지 커버 가능. ` +
      `PostToolUse=${obs.postToolUseFired ? '발화(§2d per-agent tool 추적 가능)' : '미관측(§2d 거짓양성 리스크 — 추가 확인 필요)'}.`;
  }

  return {
    subagentStartStopFired: subagentFired,
    postToolUseFired: obs.postToolUseFired,
    agentCount,
    maxConcurrency: conc,
    agentTypes: types,
    outcome,
    recommendation,
  };
}

function parseIsoMs(iso?: string): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/** STATE_DIR 의 prefix-*.json 파일 경로 목록. 실패 시 []. */
function listStateFiles(prefix: string): string[] {
  try {
    return fs
      .readdirSync(STATE_DIR)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
      .map((f) => path.join(STATE_DIR, f));
  } catch {
    return [];
  }
}

/** baseline 이후 신호 수집 (IO 셸). */
export function collectObservations(baselineMs: number): ProbeObservations {
  const agents: AgentObservation[] = [];
  for (const file of listStateFiles('active-agents-')) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
        agents?: { agentId?: string; agentType?: string; model?: string; startedAt?: string; stoppedAt?: string }[];
      };
      for (const a of data.agents ?? []) {
        const startedAtMs = parseIsoMs(a.startedAt);
        if (startedAtMs === undefined || startedAtMs < baselineMs) continue;
        agents.push({
          agentId: a.agentId ?? 'unknown',
          agentType: a.agentType,
          model: a.model,
          startedAtMs,
          stoppedAtMs: parseIsoMs(a.stoppedAt),
        });
      }
    } catch {
      /* skip malformed */
    }
  }

  let postToolUseFired = false;
  for (const file of listStateFiles('modified-files-')) {
    try {
      if (fs.statSync(file).mtimeMs >= baselineMs) {
        postToolUseFired = true;
        break;
      }
    } catch {
      /* skip */
    }
  }

  const hookEvents = collectHookEvents(baselineMs);
  return { agents, postToolUseFired, hookEvents };
}

/** hook-timing.jsonl 에서 baseline 이후 관측된 distinct event 이름 (보조 신호). */
function collectHookEvents(baselineMs: number): string[] {
  const p = path.join(STATE_DIR, 'hook-timing.jsonl');
  try {
    const lines = fs.readFileSync(p, 'utf-8').trim().split('\n');
    const set = new Set<string>();
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as { event?: string; at?: number };
        if (typeof e.at === 'number' && e.at >= baselineMs && e.event) set.add(e.event);
      } catch {
        /* skip */
      }
    }
    return [...set];
  } catch {
    return [];
  }
}

function armProbe(): void {
  const now = Date.now();
  const baseline: ProbeBaseline = { armedAtMs: now, armedIso: new Date(now).toISOString() };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));
  console.log(`
${C.bold}forgen dev probe-workflow — armed${C.reset} ${C.dim}(${baseline.armedIso})${C.reset}

${C.cyan}다음을 정확히 순서대로 실행하세요:${C.reset}
  1. Claude Code (v2.1.154+, workflows 활성) 세션에서 ${C.bold}워크플로우 1회만${C.reset} 실행
     예: ${C.dim}Run a workflow to list files under src/${C.reset}
     또는: ${C.dim}/deep-research <질문>${C.reset}
  2. ${C.yellow}그 사이 다른 Task/subagent 작업은 돌리지 마세요${C.reset} (신호 오염 방지)
  3. 워크플로우가 끝나면: ${C.bold}forgen dev probe-workflow report${C.reset}

${C.dim}전제: forgen 의 SubagentStart/Stop·PostToolUse 훅이 설치/활성 상태여야 합니다.
불확실하면 'forgen config hooks' 로 확인하세요.${C.reset}
`);
}

function loadBaseline(): ProbeBaseline | null {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8')) as ProbeBaseline;
  } catch {
    return null;
  }
}

function colorForOutcome(outcome: ProbeOutcome): string {
  if (outcome === 'workflow-hooks-fire') return C.green;
  if (outcome === 'workflow-hooks-absent') return C.yellow;
  return C.dim;
}

function reportProbe(): void {
  const baseline = loadBaseline();
  if (!baseline) {
    console.log(`\n  ${C.red}✗ armed 상태가 아닙니다.${C.reset} 먼저 ${C.bold}forgen dev probe-workflow arm${C.reset} 를 실행하세요.\n`);
    process.exitCode = 1;
    return;
  }

  const obs = collectObservations(baseline.armedAtMs);
  const verdict = analyzeProbe(obs);
  persistResult(baseline, verdict);

  const oc = colorForOutcome(verdict.outcome);
  console.log(`
${C.bold}forgen dev probe-workflow — report${C.reset} ${C.dim}(armed ${baseline.armedIso})${C.reset}

  SubagentStart/Stop 발화 : ${verdict.subagentStartStopFired ? `${C.green}YES${C.reset}` : `${C.yellow}NO${C.reset}`}
  PostToolUse 발화        : ${verdict.postToolUseFired ? `${C.green}YES${C.reset}` : `${C.yellow}NO${C.reset}`}
  관측 에이전트           : ${verdict.agentCount}  (최대 동시 ${verdict.maxConcurrency})
  agentType               : ${verdict.agentTypes.length ? verdict.agentTypes.join(', ') : `${C.dim}(없음)${C.reset}`}
  보조 hook 이벤트        : ${obs.hookEvents.length ? obs.hookEvents.join(', ') : `${C.dim}(없음)${C.reset}`}

  ${C.bold}판정:${C.reset} ${oc}${verdict.outcome}${C.reset}
  ${verdict.recommendation}

${C.dim}결과 박제: ${RESULT_PATH}${C.reset}
`);
}

function persistResult(baseline: ProbeBaseline, verdict: ProbeVerdict): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(
      RESULT_PATH,
      JSON.stringify({ at: new Date().toISOString(), armedIso: baseline.armedIso, verdict }, null, 2),
    );
  } catch {
    /* best-effort */
  }
}

function statusProbe(): void {
  const baseline = loadBaseline();
  console.log(
    baseline
      ? `\n  armed: ${C.cyan}${baseline.armedIso}${C.reset}\n  → 워크플로우 실행 후 ${C.bold}forgen dev probe-workflow report${C.reset}\n`
      : `\n  ${C.dim}armed 상태 아님.${C.reset} ${C.bold}forgen dev probe-workflow arm${C.reset} 로 시작하세요.\n`,
  );
}

export async function handleProbeWorkflow(args: string[]): Promise<void> {
  const sub = args[0] ?? 'status';
  switch (sub) {
    case 'arm':
      armProbe();
      return;
    case 'report':
      reportProbe();
      return;
    case 'status':
      statusProbe();
      return;
    default:
      console.log(`
  ${C.bold}forgen dev probe-workflow${C.reset} — ADR-009 §1: 워크플로우 훅 발화 실측

  Usage:
    forgen dev probe-workflow arm       baseline 기록 + 안내 (먼저)
    forgen dev probe-workflow report    워크플로우 실행 후 신호 수집 → 판정
    forgen dev probe-workflow status    현재 armed 상태 확인
`);
  }
}
