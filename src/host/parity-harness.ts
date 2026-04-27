/**
 * BehavioralParityScenario harness — Multi-Host Core Design §10 우선순위 4
 *
 * "Claude 와 Codex 양쪽에서 같은 입력을 흘려보냈을 때 evidence 가 의미적으로 같다" 를
 * 검증하는 골격. P4 단계에서는 *projection 사영 후 등가성* 만 검증한다 — 실 모델 호출은
 * P6 (실 Codex CLI) 트랙.
 *
 * 본 harness 가 verify 하는 것:
 *   1. 같은 forgen hook 입력에 대해 양쪽 host 의 raw 출력을 사영하면 의미 동치한 객체가 된다.
 *   2. 사영 결과가 1원칙 (Claude reference) 의 행동 의도와 일치한다.
 *
 * verify 하지 않는 것 (P6 별도 트랙):
 *   - 실제 Codex 모델이 같은 prompt 에 같은 행동을 보이는지
 *   - 실제 Claude 모델과의 동작 동등성
 */

import { equal as deepEqual } from 'node:assert/strict';
import type { HookEventInput, HookEventOutput } from '../core/types.js';
import type { HostId, TrustLayerIntent } from '../core/trust-layer-intent.js';
import { getProjection } from './projection.js';

export interface BehavioralParityScenario {
  readonly id: string;
  /** 검증하려는 Trust Layer 의도. */
  readonly intent: TrustLayerIntent;
  readonly description: string;
  /** hook 입력 (HookEventInput 동치). */
  readonly input: HookEventInput;
  /**
   * 각 host 가 *내보낼 것으로 가정* 하는 raw 출력. P4 단계에서는 spec §18 source schema
   * 기반 직접 작성. P6 단계에서는 실 Codex CLI 출력으로 대체.
   */
  readonly hostRaw: Record<HostId, unknown>;
  /**
   * 사영 후 의미 동치성을 검증할 키들.
   * 예: ['continue', 'hookSpecificOutput.permissionDecision'].
   * 각 key 는 . 으로 nested path 표현.
   */
  readonly compareKeys: ReadonlyArray<string>;
}

export interface ParityCheckResult {
  readonly scenarioId: string;
  readonly intent: TrustLayerIntent;
  readonly passed: boolean;
  readonly diffs: ReadonlyArray<{ key: string; claude: unknown; codex: unknown }>;
  /** 사영 결과 자체 (디버깅용). */
  readonly projected: Readonly<Record<HostId, HookEventOutput>>;
}

function pickPath(obj: unknown, dotted: string): unknown {
  const parts = dotted.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function valuesSemanticEqual(a: unknown, b: unknown): boolean {
  try {
    deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

export function runScenario(scenario: BehavioralParityScenario): ParityCheckResult {
  const projected: Record<HostId, HookEventOutput> = {
    claude: getProjection('claude')(scenario.hostRaw.claude, scenario.input),
    codex: getProjection('codex')(scenario.hostRaw.codex, scenario.input),
  };

  const diffs: Array<{ key: string; claude: unknown; codex: unknown }> = [];
  for (const key of scenario.compareKeys) {
    const cv = pickPath(projected.claude, key);
    const xv = pickPath(projected.codex, key);
    if (!valuesSemanticEqual(cv, xv)) {
      diffs.push({ key, claude: cv, codex: xv });
    }
  }

  return {
    scenarioId: scenario.id,
    intent: scenario.intent,
    passed: diffs.length === 0,
    diffs,
    projected,
  };
}

/**
 * P4 1차 시나리오 corpus — Trust Layer 7 의도 중 hook 출력으로 직접 관측 가능한 5종.
 * (`forge-loop-state-inject` 는 inject-context 의 특수 케이스, `self-evidence-record` 는
 * 파일 시스템 사이드이펙트라 본 corpus 가 아닌 별도 e2e 트랙.)
 */
export const SCENARIO_CORPUS: ReadonlyArray<BehavioralParityScenario> = [
  {
    id: 'block-completion-stop',
    intent: 'block-completion',
    description: 'Stop hook 이 block + reason 으로 자동 continuation 트리거',
    input: { hookEventName: 'Stop', stop_hook_active: false },
    hostRaw: {
      claude: { decision: 'block', reason: 'tests not yet executed' },
      codex: { decision: 'block', reason: 'tests not yet executed' },
    },
    compareKeys: [
      'continue',
      'hookSpecificOutput.permissionDecision',
    ],
  },
  {
    id: 'block-tool-use-pretool-deny',
    intent: 'block-tool-use',
    description: 'PreToolUse 가 permissionDecision:deny + reason 으로 도구 차단',
    input: { hookEventName: 'PreToolUse', tool_name: 'Bash' },
    hostRaw: {
      claude: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'rm -rf / matched',
        },
      },
      codex: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'rm -rf / matched',
        },
      },
    },
    compareKeys: [
      'hookSpecificOutput.permissionDecision',
      'hookSpecificOutput.permissionDecisionReason',
    ],
  },
  {
    id: 'inject-context-session-start',
    intent: 'inject-context',
    description: 'SessionStart 가 additionalContext 로 forge-loop state 주입',
    input: { hookEventName: 'SessionStart' },
    hostRaw: {
      claude: {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: '<forge-loop-state>...</forge-loop-state>',
        },
      },
      codex: {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: '<forge-loop-state>...</forge-loop-state>',
        },
      },
    },
    compareKeys: [
      'continue',
      'hookSpecificOutput.additionalContext',
    ],
  },
  {
    id: 'observe-only-non-allowlist',
    intent: 'observe-only',
    description: 'ALLOW-LIST 외 hook 이 deny 시도 시 approve 강등',
    input: { hookEventName: 'PreToolUse' },
    hostRaw: {
      claude: { continue: true },
      codex: { continue: true },
    },
    compareKeys: ['continue'],
  },
  {
    id: 'secret-filter-pretooluse-block',
    intent: 'secret-filter',
    description: 'API 키 노출 차단 — PreToolUse 가드 (양쪽 동일 경로)',
    input: { hookEventName: 'PreToolUse', tool_name: 'Bash' },
    hostRaw: {
      claude: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'API_KEY=... matched',
        },
      },
      codex: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'API_KEY=... matched',
        },
      },
    },
    compareKeys: [
      'hookSpecificOutput.permissionDecision',
      'hookSpecificOutput.permissionDecisionReason',
    ],
  },
];
