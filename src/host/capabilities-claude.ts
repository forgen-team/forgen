/**
 * Claude HostCapabilities — Multi-Host Core Design §9.0
 *
 * Claude 는 reference host. 모든 TrustLayerIntent 가 supported (identity binding).
 * 본 선언은 *spec 정의 그 자체* 의 코드 표현 — 변경 시 spec §9.0 도 같이 갱신해야 한다.
 */

import type { HostCapabilities } from '../core/trust-layer-intent.js';

export const claudeCapabilities: HostCapabilities = {
  hostId: 'claude',
  verificationLevel: 'runtime', // 레퍼런스 host — forgen 이 실제로 강제/실행.
  intents: {
    'block-completion': {
      status: 'supported',
      expression: 'Stop hook + `decision:"block"` + `reason`',
      source: 'forgen v0.4.0 stop-guard, src/hooks/stop-guard.ts',
    },
    'block-tool-use': {
      status: 'supported',
      expression: 'PreToolUse + `hookSpecificOutput.permissionDecision:"deny"` + `permissionDecisionReason`',
      source: 'forgen v0.4.0 pre-tool-use, src/hooks/pre-tool-use.ts',
    },
    'inject-context': {
      status: 'supported',
      expression: 'SessionStart/UserPromptSubmit + `hookSpecificOutput.additionalContext`',
      source: 'forgen v0.4.2 M1, src/hooks/session-recovery.ts + forge-loop-progress.ts',
    },
    'observe-only': {
      status: 'supported',
      expression: 'non-allowlist hook approve + observer log (denyOrObserve)',
      source: 'forgen v0.4.2 P3\', src/hooks/shared/blocking-allowlist.ts + hook-response.ts',
    },
    'secret-filter': {
      status: 'supported',
      expression: 'PreToolUse 가드 + (선택) PostToolUse 차단/redact',
      source: 'forgen v0.4.0 secret-filter, src/hooks/secret-filter.ts',
    },
    'forge-loop-state-inject': {
      status: 'supported',
      expression: 'SessionStart/UserPromptSubmit + `<forge-loop-state>` ≤1KB additionalContext',
      source: 'forgen v0.4.2 M1, src/hooks/shared/forge-loop-state.ts',
    },
    'self-evidence-record': {
      status: 'supported',
      expression: 'hook 결과 → ~/.forgen/state/*.json (host 무관)',
      source: 'forgen v0.4.2, ~/.forgen/state/e2e-result.json 외',
    },
  },
};
