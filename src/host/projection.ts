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
 * Codex 출력 정규화 — **Codex 0.153.4 hook 출력 스키마 준수** (ADR-015 G1 + 0.5.4 수정).
 *
 * 이 함수의 출력은 *Codex 가 읽는다* (codex-adapter 가 stdout 으로 내보냄). Codex 는 이벤트별 출력
 * 스키마가 `additionalProperties:false` 라서 **허용되지 않은 키가 하나라도 있으면 출력 전체를 버리고
 * "hook returned invalid ... JSON output" → Failed** 로 처리한다 (codex-rs/hooks/src/engine/
 * output_parser.rs `parse_json` + events/stop.rs `parse_completed`; 스키마 사본은
 * tests/fixtures/codex-hook-schemas/). 특히 Stop/SubagentStop 은 `hookSpecificOutput` 자체를
 * 허용하지 않는다 — 0.5.3 의 사영이 모든 출력에 `hookSpecificOutput.hookEventName` 을 붙여 실환경에서
 * Stop 훅 2개가 매 턴 Failed 로 떨어졌다 (0.5.4 에서 수정, 실세션 재현 후).
 *
 * 규칙 (이벤트별 allowlist — CODEX_OUTPUT_SCHEMA):
 *   1. 객체가 아니면 fail-open `{ continue: true }`.
 *   2. universal 키(`continue`/`stopReason`/`suppressOutput`/`systemMessage`) 보존 (Interrupt 는
 *      systemMessage 만).
 *   3. `decision`/`reason` 은 PreToolUse/PostToolUse/UserPromptSubmit/Stop/SubagentStop 에서만 보존.
 *      `decision:"block"` 인데 reason 이 비면 systemMessage → 고정 문구로 보강 (Codex 가 거부).
 *   4. `hookSpecificOutput` 은 허용 이벤트에서만, 허용 하위 키만 남기고 `hookEventName` 을 이벤트명으로
 *      고정한다. Stop/SubagentStop/PreCompact/PostCompact/Interrupt 에서는 통째로 제거. 절대 새로
 *      만들어 붙이지 않는다.
 *   5. PostToolUse 에 forgen 이 `permissionDecision:"deny"` (PreToolUse 형) 를 냈으면 Codex 의
 *      PostToolUse block 형(top-level `decision:"block"` + `reason`) 으로 번역.
 *   6. PreToolUse: `permissionDecision` 이 있으면 `continue:false` 제거 (Codex "unsupported").
 *   7. legacy `approved:false` → `hookSpecificOutput.permissionDecision:"deny"` (PreToolUse 한정).
 *   8. 이벤트명을 모르면(입력에 없음) 키를 깎지 않고 pass-through 한다 — 모르면 건드리지 않는다.
 */

interface EventOutputPolicy {
  universal: ReadonlyArray<string>;
  decision: boolean;
  /** hookSpecificOutput 허용 하위 키. undefined = hookSpecificOutput 자체 불허. */
  hso?: ReadonlyArray<string>;
}

const UNIVERSAL = ['continue', 'stopReason', 'suppressOutput', 'systemMessage'] as const;

/** codex-rs/hooks/schema/generated/*.command.output.schema.json (rust-v0.153.4) 요약. */
export const CODEX_OUTPUT_SCHEMA: Readonly<Record<string, EventOutputPolicy>> = {
  SessionStart: { universal: UNIVERSAL, decision: false, hso: ['hookEventName', 'additionalContext'] },
  SubagentStart: { universal: UNIVERSAL, decision: false, hso: ['hookEventName', 'additionalContext'] },
  UserPromptSubmit: { universal: UNIVERSAL, decision: true, hso: ['hookEventName', 'additionalContext'] },
  PreToolUse: {
    universal: UNIVERSAL,
    decision: true,
    hso: ['hookEventName', 'additionalContext', 'permissionDecision', 'permissionDecisionReason', 'updatedInput'],
  },
  PostToolUse: { universal: UNIVERSAL, decision: true, hso: ['hookEventName', 'additionalContext', 'updatedMCPToolOutput'] },
  PermissionRequest: { universal: UNIVERSAL, decision: false, hso: ['hookEventName', 'decision'] },
  Stop: { universal: UNIVERSAL, decision: true },
  SubagentStop: { universal: UNIVERSAL, decision: true },
  PreCompact: { universal: UNIVERSAL, decision: false },
  PostCompact: { universal: UNIVERSAL, decision: false },
  Interrupt: { universal: ['systemMessage'], decision: false },
};

function resolveEventName(raw: Record<string, unknown>, input: HookEventInput): string | undefined {
  const hso = raw.hookSpecificOutput;
  const fromOutput = hso && typeof hso === 'object' ? (hso as { hookEventName?: unknown }).hookEventName : undefined;
  const candidate =
    input.hookEventName
    ?? (input as { hook_event_name?: string }).hook_event_name // 실 stdin 은 snake_case
    ?? input.event
    ?? (typeof fromOutput === 'string' ? fromOutput : undefined);
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

export const projectCodexToClaude: ProjectToClaudeEvent = (raw, input) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { continue: true };
  const payload = raw as Record<string, unknown>;
  const eventName = resolveEventName(payload, input);
  const policy = eventName ? CODEX_OUTPUT_SCHEMA[eventName] : undefined;

  // 8. 모르는 이벤트 → pass-through (continue 기본값만 보장)
  if (!policy) {
    const out: HookEventOutput = { ...(payload as HookEventOutput) };
    if (typeof out.continue !== 'boolean') out.continue = true;
    return out;
  }

  const result: HookEventOutput = {};
  // 2. universal
  for (const k of policy.universal) {
    const v = payload[k];
    if (v !== undefined && v !== null) (result as Record<string, unknown>)[k] = v;
  }
  if (policy.universal.includes('continue') && typeof result.continue !== 'boolean') result.continue = true;

  // 3. decision / reason
  if (policy.decision) {
    if (typeof payload.decision === 'string') result.decision = payload.decision;
    if (typeof payload.reason === 'string') result.reason = payload.reason;
  }

  // 4. hookSpecificOutput — 허용 이벤트 + 허용 키만
  const rawHso = payload.hookSpecificOutput;
  if (policy.hso && rawHso && typeof rawHso === 'object') {
    const filtered: Record<string, unknown> = { hookEventName: eventName };
    for (const k of policy.hso) {
      if (k === 'hookEventName') continue;
      const v = (rawHso as Record<string, unknown>)[k];
      if (v !== undefined && v !== null) filtered[k] = v;
    }
    // 5. PostToolUse: PreToolUse 형 deny → Codex PostToolUse block 형으로 번역
    if (eventName === 'PostToolUse') {
      const pd = (rawHso as { permissionDecision?: unknown }).permissionDecision;
      if (pd === 'deny' || pd === 'block') {
        result.decision = 'block';
        const pdr = (rawHso as { permissionDecisionReason?: unknown }).permissionDecisionReason;
        if (typeof result.reason !== 'string' && typeof pdr === 'string') result.reason = pdr;
      }
    }
    result.hookSpecificOutput = filtered;
  }

  // 7. legacy approved boolean (PreToolUse 한정)
  if (eventName === 'PreToolUse' && typeof payload.approved === 'boolean' && !result.hookSpecificOutput?.permissionDecision) {
    result.hookSpecificOutput = {
      hookEventName: eventName,
      ...(result.hookSpecificOutput ?? {}),
      permissionDecision: payload.approved ? 'allow' : 'deny',
    };
  }

  // 3b. block 은 non-empty reason 필수
  if (typeof result.decision === 'string' && result.decision.toLowerCase() === 'block') {
    const reason = typeof result.reason === 'string' ? result.reason.trim() : '';
    if (!reason) {
      result.reason = typeof result.systemMessage === 'string' && result.systemMessage.trim()
        ? result.systemMessage
        : '[forgen] hook blocked this step; re-check the rule that fired before continuing.';
    }
  }

  // 6. PreToolUse: continue:false 는 Codex 미지원 — permissionDecision 이 차단을 표현
  if (eventName === 'PreToolUse' && result.continue === false && typeof result.hookSpecificOutput?.permissionDecision === 'string') {
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
