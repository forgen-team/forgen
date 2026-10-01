# ADR-014: Codex 동등화 2차 — 개인화 룰 주입 + 서브에이전트 + 훅 신뢰 감사

**Status**: Accepted (2026-10-01) — 구현 대상 문서. 구현 증거는 CHANGELOG 0.5.3 참조.
**Reversibility**: Type 2 (가역 — 훅 스크립트 내부 분기 + install 산출물 추가, 롤백 용이)
**관련**: ADR-010(플랫폼 수렴), docs/codex-integration.md, multi-host core design §9

## Context (2026-10-01 현황 조사)

오너가 오늘부터 Codex 를 유료로 일상 사용. "Claude 에서의 forgen 경험이 Codex 에서도 동일한가"
를 코드·실세션 대조로 조사한 결과:

**동등 (실증)**: hooks.json 22종 동일 생성, Codex 0.153.4 실세션(2026-09-07 rollout)에서
`hooks.additional_context` 주입·MCP compound-search 호출·AGENTS.md 블록 로드 확인. 스킬 24개 설치.

**비동등 (근본 원인)**:
1. **개인화 룰 미전달**. Claude 는 `prepareClaudeSession` 이 `.claude/rules/{v1-rules,project-context,
   forge-behavioral,user-profile}.md` 를 쓰고 Claude Code 가 매 턴 로드. Codex 는 `prepareCodexSession`
   이 hooks.json 신선도만 확인. `install-codex.ts` 의 "실 rule 은 hook chain 이 inject" 주석은 사실이
   아니었음(어떤 훅도 `renderedRules` 를 주입하지 않음). → Codex 는 Must-Not/Working-Defaults 를
   사전에 모르고 stop-guard/pre-tool-use 의 사후 차단만 받는다.
2. **서브에이전트 14종 부재**. `.claude/agents/ch-*.md` 의 Codex 등가물이 없는데, Codex 에 설치된
   forge-loop 스킬 본문은 `ch-planner → ch-executor → ch-verifier` 사이클을 지시.
3. **훅 신뢰(trust) 상태 미관리**. Codex 0.153 은 `[hooks.state."<hooks.json>:<event>:<i>:<j>"]
   trusted_hash` 로 훅별 신뢰를 기록하고, 공식 문서상 "new or changed hooks are marked for review and
   skipped until trusted". forgen 은 hooks.json 을 다시 쓰기만 하고 신뢰 상태를 보지 않음.
4. 측정 부재: evidence claude 431 / codex 6, parity e2e 미실행, hook-timing 에 runtime 필드 없음.

## Decision

### D1. 개인화 룰은 *기존 훅 스크립트 내부* 에서 Codex 전용 분기로 주입한다 (hooks.json 불변)
- 주입 표면: `SessionStart`(session-recovery) 의 `additionalContext`. Codex 가 AGENTS.md 를 세션 시작
  developer 메시지로 넣는 것과 동일 의미론. 공식 문서: 컴팩션 중 SessionStart 추가 컨텍스트는 즉시
  continuation 에 전달.
- 컴팩션 후 재주입: 별도 경로 없음. Claude Code 와 Codex 모두 컴팩션 시 SessionStart 를
  `source="compact"` 로 다시 발화하므로 같은 경로가 한 번 더 돈다. (초안의 PreCompact 플래그 →
  UserPromptSubmit 재주입 경로는 critic 리뷰에서 2중 주입으로 판정되어 제거.)
- 내용·캡: Claude 와 동일한 `generateClaudeRuleFiles(cwd, renderedRules)` 산출을 동일 캡
  (`RULE_FILE_CAPS` per 3000 / total 15000) 으로 `<forgen-rules host="codex">` 블록에 담는다.
  Claude 와 *같은 소스, 같은 캡* 이므로 룰 의미론이 호스트 간 갈라지지 않는다.
- 왜 새 훅이 아닌가: hooks.json 에 엔트리를 추가/삭제하면 Codex 가 변경 훅을 "review 전까지 skip".
  글로벌 npm 업그레이드는 경로가 동일(`/node_modules/@wooojin/forgen/`)하므로 hooks.json 을 바이트
  동일하게 유지하면 기존 신뢰가 그대로 유효 → 오늘 바로 적용 가능. (PostToolUseFailure 가 Codex 에
  없어 dead 엔트리지만 같은 이유로 제거하지 않는다.)
- 왜 AGENTS.md 파일이 아닌가: 프로젝트 AGENTS.md 는 사용자 저장소에 커밋될 수 있어 user-profile
  같은 개인 룰이 유출된다. 훅 주입은 파일을 남기지 않는다.

### D2. Codex 커스텀 에이전트를 `~/.codex/agents/ch-*.toml` 로 생성한다
- 소스: `assets/claude/agents/*.md` (단일 소스). 매핑: `name`=`ch-<file>` (Claude 설치명과 동일 →
  스킬 본문의 ch-* 참조가 그대로 해석됨), `description`=frontmatter, `developer_instructions`=본문,
  `sandbox_mode`= tools 에 Write/Edit 없으면 `read-only` 아니면 `workspace-write`,
  `model_reasoning_effort`= opus→high / sonnet→medium / haiku→low. `model` 은 생략(Codex 기본).
- 공식 스키마(필수 name/description/developer_instructions, 선택 model/model_reasoning_effort/
  sandbox_mode/nickname_candidates) 외 필드는 쓰지 않는다 — Codex 가 unknown field 를 거부.
- 읽기전용 판정은 `tools:` 목록(Write/Edit 부재) *또는* `disallowedTools:` 목록(Write/Edit 포함) 둘 다 본다
  — 14종 중 7종이 후자 형식 (critic 리뷰 반영).
- idempotent: 첫 줄 `# forgen-managed` 마커. 마커 있는 stale ch-*.toml 만 정리, 사용자 파일 보존.
- 멀티에이전트 기능 플래그(`[features] multi_agent`) 는 사용자 설정이라 건드리지 않고, install 출력에서
  없으면 ⚠ 안내만 (`multiAgentEnabled`).

### D3. 스킬 본문 Codex 적응
- `$ARGUMENTS` 는 Codex 스킬에 없는 변수 → 설치 시 자연어 치환.
- 스킬 끝에 "Codex host note" 를 붙여 ch-* 에이전트가 `~/.codex/agents` 커스텀 에이전트로 존재함과,
  spawn 이 불가한 환경에서는 `invoke-agent` MCP 도구 또는 인라인 수행으로 대체함을 명시.

### D4. 훅 신뢰 감사 (수정이 아닌 가시화)
- `auditCodexHookTrust()` 가 hooks.json 의 forgen 엔트리별 `hooks.state` 키 존재를 대조. Codex 가
  모르는 이벤트(PostToolUseFailure)는 조용히 무시되어 trust 키가 생기지 않으므로 total 에서 제외하고
  `ignoredByCodex` 로 따로 보고 (안 그러면 영원히 "1 untrusted").
  `forgen install codex` 출력과 `forgen doctor` 의 [Codex] 섹션에 "N/M trusted, 미신뢰 시 codex 안에서
  `/hooks` 로 승인" 안내. trusted_hash 를 forgen 이 직접 쓰지 않는다(신뢰 모델 우회 금지).

### D5. 측정: hook-timing.jsonl 에 `rt` 필드 추가 (claude|codex). doctor 가 호스트별 발화를 구분 가능.

## Out of scope
- Codex 전용 이벤트(SessionEnd/PostCompact/Interrupt) 활용 — hooks.json 변경이 필요하므로 다음 메이저.
- Claude agents 의 model 지정을 Codex 모델로 매핑 — 기본 subagent 모델 사용.

## Verification plan
- vitest: rules-context 빌더(캡·태그·null), agents TOML 생성/idempotent/사용자 보존/disallowedTools,
  스킬 치환, trust 감사(미지원 이벤트 제외), multi_agent 감지, hook-timing rt.
- 격리 라이브: `CODEX_HOME`/`FORGEN_HOME` 임시 + `codex exec` 실행 후 rollout 에 `<forgen-rules` 주입
  확인. 미신뢰 훅이 exec 에서 skip 되는지도 같은 실험으로 관측.
- fresh-context critic (fable) 1라운드: MAJOR 3 (읽기전용 샌드박스, 영구 untrusted, 2중 주입) + MINOR 6
  → 전부 반영 (frontmatter `description: >` 다중행은 현 자산에 없어 미대응, 단일행 가정 명시).
