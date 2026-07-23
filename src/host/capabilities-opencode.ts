/**
 * OpenCode HostCapabilities — Multi-Harness Adapter Plan P1
 * (`reports/harness-probe/adapter-plan-2026-07-20.md` §2.2 / §3.1).
 *
 * ⚠️ 검증 수준(정직): verificationLevel='docs' 유지. OpenCode plugin 문서 + context7
 * 실소스 대조(`/anomalyco/opencode`: tool.execute.before(input.tool, output.args), throw=block
 * 확인). codex 의 로컬-schema source-level 과는 다른 축.
 *
 * 2026-07-22 **런타임 부분 검증(opencode v1.1.8, 격리 XDG)**: `forgen install opencode` 배포 후
 *   - plugin(`plugins/forgen.ts`) **로드 성공**(service=plugin loading plugin, 에러 없음),
 *   - MCP(`mcp.forgen-compound`) **등록 + 9 tools** 로드 성공(toolCount=9).
 *   미검증: tool.execute.before 발화(guard block) end-to-end 는 model API 필요(격리 세션에서
 *   401 Missing API key 로 model 단계 미도달) → verificationLevel='docs' 유지가 정직.
 *   plugin-load + MCP 는 runtime-confirmed, guard-firing 은 model-backed 세션 테스트 대기.
 *
 * OpenCode 통합 형태는 Claude/Codex 와 다르다: subprocess-stdin hook 이 아니라
 * **in-process TypeScript plugin**(`.opencode/plugins/`, 25+ 이벤트, tool.execute.before
 * throw-to-block). 이 형태 차이 때문에 P1 은 plugin 슬림이 최대 신규 델타(plan §5 blocker 1).
 *
 * 근거 소스:
 *   - OpenCode plugins docs: https://opencode.ai/docs/plugins/
 *   - plan §2.2 (tool.execute.before throw, session.idle, experimental.session.compacting,
 *     tui.prompt.append, opencode.jsonc MCP, message.updated/session.* event stream)
 */

import type { HostCapabilities } from '../core/trust-layer-intent.js';

export const opencodeCapabilities: HostCapabilities = {
  hostId: 'opencode',
  // docs-level: OpenCode 문서 기반 선언, forgen 배선 미완(plugin 슬림 전). 아래 status 의
  // supported 는 "플랫폼 가능"이지 "forgen 강제"가 아니다 — intentEnforced 로 게이트할 것.
  verificationLevel: 'docs',
  intents: {
    'block-completion': {
      // session.idle 는 발화하나 "완료 강제 차단/재-turn" 계약이 문서에 없다.
      status: 'unsupported',
      expression: 'session.idle 이벤트는 관측 가능하나 force-continue 표면 부재 → advise-only',
      mitigation:
        'ADR-010 F1(frontier blocks=0)과 동일한 advise-mode: tui.toast.show 로 사용자에게 표면화하되 하드 차단은 주장하지 않는다. (model,harness)→policy 축으로 advise 처리.',
      source: 'plan §2.2/§3.1 — OpenCode docs 에 완료 방지 API 미문서화. Cursor 와 동일 한계.',
    },
    'block-tool-use': {
      // tool.execute.before 에서 throw 하면 *모든* tool 차단 (Cursor 의 shell/MCP/read 한정보다 강함).
      status: 'supported',
      expression: 'plugin `tool.execute.before` 훅에서 throw → 해당 tool 실행 차단(전 tool 대상)',
      source:
        'https://opencode.ai/docs/plugins/ — docs 예시가 .env read 를 tool.execute.before throw 로 차단. plan §2.2.',
    },
    'inject-context': {
      // experimental.session.compacting(output.context/prompt) + tui.prompt.append/session.created.
      status: 'partial',
      expression:
        'experimental.session.compacting 로 output.context/prompt 수정 + tui.prompt.append/session.created 로 주입',
      mitigation:
        'experimental 표면이라 안정성 미보장 — 안정 계약 확정 전까지 정적 룰(AGENTS.md/.opencode) 폴백을 1차로 유지하고 동적 주입은 best-effort.',
      source: 'plan §2.2 — experimental.session.compacting / tui.prompt.append (less-stable surface).',
    },
    'observe-only': {
      // 이벤트 스트림(message.updated/session.*) → observer log. host 무관 stdout.
      status: 'supported',
      expression: 'message.updated/session.* 이벤트 스트림 → observer log (denyOrObserve 는 host 무관 stdout)',
      source: 'plan §2.2 event stream; forgen denyOrObserve 는 stdout JSON 만 다뤄 host 무관.',
    },
    'secret-filter': {
      // tool.execute.before(pre-block) + tool.execute.after(post-redact). pre 가드가 1차.
      status: 'supported',
      expression: 'tool.execute.before 로 자격증명 tool 입력 차단(pre) + tool.execute.after 로 결과 redact(post)',
      mitigation:
        'Claude 와 동일하게 PreToolUse 등가(tool.execute.before) 가드가 1차 방어. post-redact 는 after 훅으로 보강.',
      source: 'plan §3.1 — OpenCode 는 pre+post 둘 다 표면 보유(Codex 의 post-only partial 보다 강함).',
    },
    'forge-loop-state-inject': {
      // inject-context 와 동일 표면(experimental) — ≤1KB forge-loop-state.
      status: 'partial',
      expression: '<forge-loop-state> ≤1KB 를 tui.prompt.append/session.created 로 주입(experimental 표면 공유)',
      mitigation: 'inject-context 와 동일한 experimental 한계 — 안정 계약 전까지 best-effort.',
      source: 'plan §2.2/§3.1 — inject-context 와 같은 표면 재사용.',
    },
    'self-evidence-record': {
      // 이벤트 스트림 캡처 → ~/.forgen/state/*.json, host:"opencode" 태그.
      status: 'supported',
      expression: 'session.*/message.updated 캡처 → ~/.forgen/state/*.json (host 무관). evidence 에 host:"opencode" 태그.',
      source: 'plan §2.2 event stream — file-transcript polling 보다 richer. spec §4.2 host-tagged evidence.',
    },
  },
};
