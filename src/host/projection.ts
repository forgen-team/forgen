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

// parseDecision 은 구 사영(결정 → continue:false 변환) 의 잔재. ADR-015 G1 이후 Codex 사영은
// 호스트 스키마를 보존하므로 사용하지 않는다. 다른 host binding 이 참고할 수 있어 export 만 유지.
export function parseDecision(raw: unknown): DecisionView {
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
 * Codex 출력 정규화 (ADR-015 G1, 2026-10-01 재설계).
 *
 * 이 함수의 출력은 *Codex 가 읽는다* (codex-adapter 가 stdout 으로 내보냄). Codex 의 hook 출력
 * 스키마는 Claude 와 동일하게 **top-level `decision`/`reason`** (Stop/SubagentStop/UserPromptSubmit/
 * PostToolUse) 과 `hookSpecificOutput.permissionDecision` (PreToolUse) 을 읽고, `continue:false` 는
 * "continuation" 이 아니라 "처리 중단" 이다 (learn.chatgpt.com/docs/hooks; binary: `hook returned
 * decision:block without a non-empty reason`, `PreToolUse hook returned unsupported continue:false`).
 *
 * 이전 구현은 `decision:block` 을 `continue:false + hookSpecificOutput.permissionDecision:"block"` 으로
 * 바꿔 **Stop block 이 Codex 에 전혀 전달되지 않았다** (reason 유실 → 자기검증 continuation 0건).
 * gap-codex 분석(fable) 에서 발견, dist 실행으로 재현.
 *
 * 규칙:
 *   1. 객체가 아니면 fail-open `{ continue: true }`.
 *   2. 객체면 top-level 필드(`continue`/`decision`/`reason`/`stopReason`/`systemMessage`/
 *      `suppressOutput`/`hookSpecificOutput`) 를 **그대로 보존**.
 *   3. 이벤트명을 알면 `hookSpecificOutput.hookEventName` 을 항상 보강 (구 사영과 동일).
 *   4. `decision:"block"` 인데 `reason` 이 비면 `systemMessage` → 고정 문구 순으로 보강
 *      (Codex 가 reason 없는 block 을 거부).
 *   5. PreToolUse 에서 `permissionDecision` 이 있으면 `continue:false` 를 제거 (Codex 미지원 경고;
 *      차단은 permissionDecision 이 이미 표현).
 *   6. legacy `approved:false` (구 codex 형) → `hookSpecificOutput.permissionDecision:"deny"`.
 */
export const projectCodexToClaude: ProjectToClaudeEvent = (raw, input) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { continue: true };
  const payload = raw as Record<string, unknown>;
  const result: HookEventOutput = { continue: true };

  if (typeof payload.continue === 'boolean') result.continue = payload.continue;
  for (const k of ['decision', 'reason', 'stopReason', 'systemMessage', 'suppressOutput'] as const) {
    const v = payload[k];
    if (v !== undefined && v !== null) (result as Record<string, unknown>)[k] = v;
  }
  if (typeof payload.hookSpecificOutput === 'object' && payload.hookSpecificOutput !== null) {
    result.hookSpecificOutput = { ...(payload.hookSpecificOutput as Record<string, unknown>) };
  }

  // 6. legacy approved boolean
  if (typeof payload.approved === 'boolean' && !result.hookSpecificOutput?.permissionDecision) {
    result.hookSpecificOutput = {
      ...(result.hookSpecificOutput ?? {}),
      permissionDecision: payload.approved
        ? (typeof payload.decision === 'string' ? payload.decision : 'allow')
        : 'deny',
    };
    if (!payload.approved) result.continue = false;
  }

  // 3. hookEventName 보강
  const eventName =
    (result.hookSpecificOutput?.hookEventName as string | undefined)
    ?? input.hookEventName
    ?? (input as { hook_event_name?: string }).hook_event_name // 실 stdin 은 snake_case (critic #7)
    ?? input.event;
  if (eventName) {
    // 이벤트명을 알면 항상 달아 둔다 (구 사영과 동일; Codex 실세션에서 approve 출력에도 문제 없음 확인).
    result.hookSpecificOutput = { hookEventName: eventName, ...(result.hookSpecificOutput ?? {}) };
  }

  // 4. block 은 non-empty reason 필수
  if (typeof result.decision === 'string' && result.decision.toLowerCase() === 'block') {
    const reason = typeof result.reason === 'string' ? result.reason.trim() : '';
    if (!reason) {
      result.reason = typeof result.systemMessage === 'string' && result.systemMessage.trim()
        ? result.systemMessage
        : '[forgen] hook blocked this step; re-check the rule that fired before continuing.';
    }
  }

  // 5. PreToolUse: continue:false 는 Codex 미지원 — permissionDecision 이 차단을 표현
  const pd = result.hookSpecificOutput?.permissionDecision;
  if (eventName === 'PreToolUse' && typeof pd === 'string' && result.continue === false) {
    result.continue = true;
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

/**
 * OpenCode projection — P1 파운데이션 fail-loud 스텁.
 * OpenCode 는 in-process plugin(throw/return)이라 subprocess stdout projection 과 형태가
 * 다르다(plan §5 blocker 1). 실제 translation 은 plugin 슬림이 착지할 때 구현한다. 그 전까지
 * 이 함수는 도달 불가(install-opencode 미구현 → getProjection('opencode') 미호출)이며,
 * 혹시 호출되면 조용히 잘못된 결과를 내는 대신 명시적으로 실패한다.
 */
const projectOpencodeToClaude: ProjectToClaudeEvent = () => {
  throw new Error(
    '[forgen] OpenCode projection 미구현 — P1 plugin 슬림 착지 후 구현 예정 (plan §4.1 in-process-plugin binding).',
  );
};

const PROJECTIONS: Record<HostId, ProjectToClaudeEvent> = {
  claude: projectClaudeToClaude,
  codex: projectCodexToClaude,
  opencode: projectOpencodeToClaude,
};

export function getProjection(host: HostId): ProjectToClaudeEvent {
  const fn = PROJECTIONS[host];
  if (!fn) throw new Error(`No ProjectToClaudeEvent registered for host: ${host}`);
  return fn;
}
