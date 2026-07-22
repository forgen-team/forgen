/**
 * Codex HostCapabilities — Multi-Host Core Design §9.0 + §18 (source-level verified)
 *
 * Codex 는 1원칙 (Claude reference) 의 등가 확장 host. schema-level 에서 7/7 supported.
 * 단, secret-filter 는 PostToolUse `hookSpecificOutput.updatedMCPToolOutput` 이 MCP tool 한정이므로
 * partial. 일반 shell/edit tool 의 결과 redact 는 미보장 — PreToolUse 가드 유지로 mitigation.
 *
 * source-of-truth: codex-rs/hooks/schema/generated/* (Apache-2.0). spec §17/§18 이 박제한 검증 결과.
 */

import type { HostCapabilities } from '../core/trust-layer-intent.js';

export const codexCapabilities: HostCapabilities = {
  hostId: 'codex',
  verificationLevel: 'source', // hook schema 소스 검증 + forgen 배선 완료.
  intents: {
    'block-completion': {
      status: 'supported',
      expression: 'Stop + `decision:"block"` + `reason` (Codex 가 reason 을 다음 turn prompt 로 자동 주입)',
      source:
        'codex-rs/hooks/schema/generated/stop.command.output.schema.json — description 에 "Claude requires `reason` when `decision` is `block`" 명시',
    },
    'block-tool-use': {
      status: 'supported',
      expression: 'PreToolUse + `hookSpecificOutput.permissionDecision:"deny"` + `permissionDecisionReason`',
      source:
        'codex-rs/hooks/schema/generated/pre-tool-use.command.output.schema.json — PreToolUsePermissionDecisionWire enum ["allow","deny","ask"]',
    },
    'inject-context': {
      status: 'supported',
      expression: 'SessionStart/UserPromptSubmit + `hookSpecificOutput.additionalContext`',
      source:
        'codex-rs/hooks/schema/generated/{session-start,user-prompt-submit}.command.output.schema.json — additionalContext: string',
    },
    'observe-only': {
      status: 'supported',
      expression: 'non-allowlist hook approve + observer log (denyOrObserve 그대로)',
      source: 'forgen denyOrObserve 가 stdout JSON 만 다루므로 host 무관 — spec §17.2 확인',
    },
    'secret-filter': {
      status: 'partial',
      expression:
        'MCP tool 한정: PostToolUse + `hookSpecificOutput.updatedMCPToolOutput`. 일반 shell/edit tool 결과 redact 계약 부재.',
      mitigation:
        '1차는 PreToolUse 단계의 secret-filter 가드 유지 (Claude 와 동일 경로). 일반 tool 결과 redact 는 향후 PostToolUse 도입 시 MCP tool 에 한해 강화.',
      source: 'codex-rs/hooks/schema/generated/post-tool-use.command.output.schema.json — updatedMCPToolOutput 만 정의',
    },
    'forge-loop-state-inject': {
      status: 'supported',
      expression: 'SessionStart/UserPromptSubmit + `<forge-loop-state>` ≤1KB additionalContext',
      source: 'spec §9.0 row 6 — schema 가 Claude 와 동치하므로 1KB cap 정책 그대로 적용',
    },
    'self-evidence-record': {
      status: 'supported',
      expression: 'hook 결과 → ~/.forgen/state/*.json (host 무관). evidence 에 host:"codex" 태그 추가만 필요.',
      source: 'spec §4.2 host-tagged evidence',
    },
  },
};
