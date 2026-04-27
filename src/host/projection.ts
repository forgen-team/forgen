/**
 * ProjectToClaudeEvent — Multi-Host Core Design §5.2 / §10 우선순위 2
 *
 * Codex (또는 미래의 다른 host) 의 hook 출력을 Claude Hook schema 로 사영하는
 * 정식 계약. spec §17.4 / §18.4 에서 검증되었듯 schema-level 에서 거의 identity 이므로
 * 본 함수는 *형식 정규화* 만 책임진다.
 *
 * - 입력: host-native 출력(JSON object, plaintext, exit-code 등은 별도 layer 에서 처리)
 * - 출력: Claude HookEventOutput 동치 — `continue`, `hookSpecificOutput.permissionDecision`, etc.
 * - 실패 정책: parse 실패 / 알 수 없는 형식 → fail-open (`{ continue: true }`)
 *
 * 본 모듈은 host 측 표면을 *모르고*, 받은 raw 의 형태만으로 동작한다 (1원칙: core 는 Claude
 * semantics 알아도 됨, Codex 표면 모름). 즉 Codex CLI 의 stdout 을 받아 코어가 학습 가능한
 * Claude 형 객체로 변환만 한다.
 */

import type { HookEventInput, HookEventOutput } from '../core/types.js';
import type { HostId } from '../core/trust-layer-intent.js';

export type ProjectToClaudeEvent = (raw: unknown, input: HookEventInput) => HookEventOutput;

interface DecisionView {
  continueFlag: boolean;
  permissionDecision?: string;
}

function parseDecision(raw: unknown): DecisionView {
  if (typeof raw === 'boolean') return { continueFlag: raw };

  if (typeof raw === 'string') {
    const normalized = raw.toLowerCase();
    if (normalized === 'continue') return { continueFlag: true };
    if (
      normalized === 'stop' ||
      normalized === 'deny' ||
      normalized === 'reject' ||
      normalized === 'block'
    ) {
      return { continueFlag: false, permissionDecision: normalized };
    }
    return { continueFlag: true };
  }

  if (typeof raw !== 'object' || raw === null) return { continueFlag: true };

  const decision = (raw as { decision?: unknown }).decision;
  if (typeof decision === 'string') {
    const normalized = decision.toLowerCase();
    if (normalized === 'deny' || normalized === 'reject' || normalized === 'block') {
      return { continueFlag: false, permissionDecision: normalized };
    }
    if (normalized === 'ask' || normalized === 'prompt' || normalized === 'confirm') {
      return { continueFlag: true, permissionDecision: normalized };
    }
  }

  if (typeof (raw as { approved?: unknown }).approved === 'boolean') {
    const approved = (raw as { approved: boolean }).approved;
    return approved
      ? { continueFlag: true, permissionDecision: (raw as { decision?: string }).decision || 'approve' }
      : { continueFlag: false, permissionDecision: 'deny' };
  }

  if (typeof (raw as { continue?: unknown }).continue === 'boolean') {
    return { continueFlag: (raw as { continue: boolean }).continue };
  }

  return { continueFlag: true };
}

/**
 * Codex 출력 → Claude HookEventOutput 정식 사영.
 *
 * spec §18.2 fact #3 에 따라 PreToolUse 의 *이중* decision 필드 중 어댑터는
 * `hookSpecificOutput.permissionDecision` 을 우선한다. 본 함수가 그 규약을 강제.
 */
export const projectCodexToClaude: ProjectToClaudeEvent = (raw, input) => {
  const result: HookEventOutput = { continue: true };
  const decision = parseDecision(raw);
  result.continue = decision.continueFlag;

  if (typeof raw === 'object' && raw !== null) {
    const payload = raw as Record<string, unknown>;
    if (typeof payload.continue === 'boolean') result.continue = payload.continue;
    if (typeof payload.systemMessage === 'string') result.systemMessage = payload.systemMessage;
    if (typeof payload.suppressOutput === 'boolean') result.suppressOutput = payload.suppressOutput;
    if (typeof payload.hookSpecificOutput === 'object' && payload.hookSpecificOutput !== null) {
      result.hookSpecificOutput = { ...(payload.hookSpecificOutput as Record<string, unknown>) };
    }

    // top-level decision (Codex 의 PreToolUse 이중 decision 중 legacy 측 또는 Stop/Post 의 단일 측)
    // 이 있고, hookSpecificOutput.permissionDecision 이 비었을 때만 보존.
    if (
      typeof (payload as { decision?: unknown }).decision === 'string' &&
      !(result.hookSpecificOutput && 'permissionDecision' in result.hookSpecificOutput)
    ) {
      result.hookSpecificOutput = {
        ...(result.hookSpecificOutput ?? {}),
        permissionDecision: (payload as { decision: string }).decision,
      };
    }
  }

  const eventName =
    result.hookSpecificOutput?.hookEventName ?? input.hookEventName ?? input.event;
  if (eventName) {
    result.hookSpecificOutput = {
      hookEventName: eventName,
      ...(result.hookSpecificOutput ?? {}),
    };
  }

  if (!result.continue && !result.hookSpecificOutput?.permissionDecision) {
    if (decision.permissionDecision) {
      result.hookSpecificOutput = {
        ...(result.hookSpecificOutput ?? {}),
        permissionDecision: decision.permissionDecision,
      };
    } else {
      result.hookSpecificOutput = {
        ...(result.hookSpecificOutput ?? {}),
        permissionDecision: 'deny',
      };
    }
  }

  return result;
};

/**
 * Claude 어댑터의 사영. 1원칙(Claude reference) + spec §18.4 (Codex hooks.json schema 동일성)
 * 에 따라 본 함수는 `projectCodexToClaude` 와 *같은 normalize 로직* 을 공유한다.
 * 둘 다 같은 canonical Claude HookEventOutput 형식을 만든다.
 *
 * (왜 두 함수를 별도 export 하는가: 향후 schema 가 다른 host 가 추가될 때 본 binding 만
 * 교체하면 되도록 — `getProjection(host)` 가 단일 진입점.)
 */
export const projectClaudeToClaude: ProjectToClaudeEvent = (raw, input) =>
  projectCodexToClaude(raw, input);

const PROJECTIONS: Record<HostId, ProjectToClaudeEvent> = {
  claude: projectClaudeToClaude,
  codex: projectCodexToClaude,
};

export function getProjection(host: HostId): ProjectToClaudeEvent {
  const fn = PROJECTIONS[host];
  if (!fn) throw new Error(`No ProjectToClaudeEvent registered for host: ${host}`);
  return fn;
}
