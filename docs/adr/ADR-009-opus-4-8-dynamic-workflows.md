# ADR-009: Claude Opus 4.8 + Dynamic Workflows 대응 — 검증 커버리지·동시성·effort 축·워크플로우 통합

**Status**: Proposed (2026-05-29)
**Date**: 2026-05-29
**Reversibility**: Type 2 (구현 가역. 단 §1 probe 결과가 §2/§3 라우트 선택을 게이트 — probe 전 구현 착수는 비가역적 잘못된 가정 위험)
**Related ADR**: ADR-001 (Mech-A/B/C 아키텍처, stop-guard), ADR-002 (rule lifecycle / stuck-loop), [multi-host core design](../superpowers/specs/2026-04-27-forgen-multi-host-core-design.md) §9.0
**Affected**: `src/hooks/subagent-tracker.ts`, `src/hooks/stop-guard.ts`(→ 디스패처 추출), `src/checks/*`, `src/host/capabilities-claude.ts`/`capabilities-codex.ts`, `~/.forgen/state/active-agents-*.json` + `modified-files-*.json` schema, `.claude/workflows/`(신규 자산), `forge-loop`/compound-extraction effort 권고

## Context

2026-05-28 Claude Opus 4.8 (`claude-opus-4-8`) GA. forgen 0.4.10 → 0.4.11 출시 직전에 도착한 신기능 중 forgen 아키텍처에 직접 영향을 주는 것:

1. **effort 기본값 = `high`** (Claude Code 포함 전 표면). `xhigh`(=extra)/`max` 선택 가능. `ultracode` = `xhigh` + 자동 워크플로우 판단.
2. **Dynamic Workflows** (research preview, v2.1.154+): Claude이 작업을 JS 스크립트로 작성 → 런타임이 **대화와 분리된 격리 환경에서 백그라운드 실행**. 최대 1,000 에이전트/런, **동시 16**. 서브에이전트는 **항상 `acceptEdits`**, tool allowlist 상속. "독립 각도 풀이 → 다른 에이전트가 반박 → 수렴까지 반복" (adversarial verify-until-converge가 네이티브). 중간 결과는 **스크립트 변수에만 존재, Claude 컨텍스트에 안 들어감**. 동일 세션 내 resumable.
3. **품질**: 코드 결함 4× 덜 놓침, 자기 오류 캐치, 불건전한 계획 반박, tool 호출 누락 감소.
4. **기타**: mid-conversation `role:"system"` 메시지(캐시 보존), 캐시 최소 1,024토큰, fast mode, refusal `stop_details`.

### 핵심 긴장

forgen의 가치(검증·증거 게이팅)는 **메인 대화 턴의 Stop hook**에 묶여 있다 (`Stop → stop-guard.js`). dynamic workflow는 작업의 대부분을 **대화 밖 격리 런타임**으로 옮긴다. 즉 ultracode가 켜질수록 forgen이 관측·검증하는 영역이 줄어든다. 이건 단순 신기능 흡수가 아니라 **forgen 존재 이유의 커버리지 문제**다.

### 코드에서 확정한 사실 (2026-05-29)

- `assets/shared/hook-registry.json`: `Stop → stop-guard.js`(Mech-B 전체), `SubagentStop → subagent-tracker.js stop`(카운팅만, **검증 미적용**).
- `stop-guard.ts:530-604`: TEST-1/2/3 + DANGEROUS 메타 가드 디스패처가 `main()` 안에 인라인. `recentTools`는 `modified-files-{sessionId}.json`(post-tool-use 작성)에서 로드. block-count는 `(sessionId, ruleId)` 키.
- `subagent-tracker.ts:20`: `MAX_CONCURRENT_AGENTS = 10` 초과 시 경고.
- `capabilities-claude.ts`: TrustLayerIntent capability 모델. `CapabilityStatus = 'supported'|'partial'|'unsupported'` (미확인 상태 어휘 없음).

### 공식 문서에서 확정한 사실

- **SubagentStop은 `decision:"block"`+`reason` 지원** → "subagent continues working". Mech-B 메커니즘이 subagent에 작동 **가능**.
- SubagentStop 입력 필드: `session_id, transcript_path, cwd, permission_mode, hook_event_name, agent_id, agent_type`. **`last_assistant_message` 없음** → transcript_path 파싱 폴백 필요.
- SubagentStart/Stop은 **Task-tool / `--agent` 서브에이전트**에 발화함(문서 확인).
- 그러나 **워크플로우 내부 에이전트에 대한 훅 발화 여부는 문서가 침묵**. 런타임이 "isolated environment, separate from your conversation, background"로 명시 → 발화 안 할 개연성이 높음. **미확인.**

## Decision

### §1. (P0-blocker) 결정적 미확인 변수를 probe로 먼저 해소

> **질문**: dynamic workflow **내부** 에이전트에 대해 `SubagentStart/Stop` 및 `PostToolUse` 훅이 발화하는가?

이 답이 §2(훅 라우트)와 §3(템플릿 라우트)의 선택을 가른다. forgen 프로젝트 룰("가정/mock으로 완료 선언 금지, 실행 증거 필수")상 **가정 위에 §2를 구현하는 것 자체가 룰 위반**이다.

**Probe 절차** (저비용, 사용자 1회 실행):
1. Claude Code v2.1.154+ + workflows 활성 환경에서 forgen 설치 상태로,
2. 최소 워크플로우 트리거: `Run a workflow to list files under src/` (또는 `/deep-research`),
3. 관측: `~/.forgen/state/active-agents-*.json`(SubagentStart/Stop tracker 기록), `hook-timing` 로그, `modified-files-*.json`(PostToolUse) 에 워크플로우 에이전트 항목이 생기는가.
4. (선택) forgen에 `forgen probe-workflow` 진단 커맨드를 추가해 위 관측을 자동화.

**Gate 결과**:
- **발화함** → §2(훅 라우트)가 워크플로우까지 커버. §2 우선.
- **발화 안 함** → §2는 Task-tool/team/swarm subagent에만 유효. 워크플로우 품질은 **오직 §3(템플릿 라우트)로만** 도달 가능.

probe 전까지 새 TrustLayerIntent(`workflow-verify`)는 **선언하지 않는다** (capability 모델은 검증된 사실만 담는 게 codex 선언의 원칙 — "source-level verified").

#### Probe 결과 (2026-05-29 실측, `forgen probe-workflow`)

baseline 02:04:12.415Z arm → 최소 워크플로우(agent 3, `parallel`) 1회 실행 → report:

- **`workflow-hooks-fire` 확정**: 워크플로우 내부 에이전트가 forgen의 SubagentStart/Stop + Pre/PostToolUse 훅을 발화함. `active-agents-{sessionId}.json`에 `agentType:"workflow-subagent"` 엔트리가 startedAt/stoppedAt과 함께 기록됨. hook-timing 에 baseline 이후 `PostToolUse×3, PreToolUse×3`.
- **→ §2 라우트(SubagentStop 검증)가 워크플로우 내부까지 도달 가능.** 템플릿(§3) 전용이 아님.
- **워크플로우 에이전트는 `agentType:"workflow-subagent"`로 라벨링** → §4 면제/§2 맞춤 검증에 활용.

##### 🔴 부수 발견 — subagent-tracker 동시쓰기 레이스 (§2/§4 선결 조건으로 격상)

**3개를 띄웠는데 active-agents엔 2개만 기록됨**(워크플로우 결과는 `agents:3`). 원인: `subagent-tracker.ts`의 `loadAgentsState → push → saveAgentsState`가 **파일 락 없는 read-modify-write** → 동시 SubagentStart 간 lost-update. 동시 16 워크플로우에서 대량 누락.

영향:
- §2: 누락된 SubagentStop = **검증 누락** (forgen 사각지대 재발).
- §4: 동시성 카운트 부정확.
- §2d: `modified-files-{sessionId}.json`도 sessionId 키 → **동일 레이스** → 동시 에이전트가 recentTools 상호 덮어씀 → TEST-2 거짓양성.
- forgen에 이미 `src/hooks/shared/file-lock.ts` 존재하나 tracker 미사용.

**결정**: §2 본체(stop-guard 확장) 착수 **전에** subagent-tracker / modified-files 쓰기에 file-lock 또는 per-agent 파일 분리를 적용한다(§4와 묶음). 단 "2-of-3 누락"이 락 부재 lost-update임은 §실측 1회 관찰 — 구현 시 동시 N=16 재현으로 확정한다(과주장 금지).

### §2. (probe-gated, 단 Task-tool/team/swarm에는 무조건 유효) SubagentStop 검증 확장

`SubagentStop`에서 stop-guard의 메타 가드 디스패처를 실행한다. 선행 리팩터 + 4개 하위 수정:

- **2a. 디스패처 추출**: `stop-guard.ts:537-603`의 `checks[]` + for-loop를 `src/checks/_shared/meta-guard-dispatch.ts`(가칭) 순수 모듈로 추출. `Stop`과 `SubagentStop`이 공유. *(anti-pattern 룰: stop-guard 3회+ 편집 금지 → 추출을 한 번에 설계)*
- **2b. subagent 최종 텍스트**: SubagentStop엔 `last_assistant_message`가 없으므로 `readLastAssistantMessage`의 transcript_path 폴백을 재사용. subagent transcript가 subagent 메시지를 담는지 probe 시 함께 확인.
- **2c. per-agent block-count 키**: 현재 `(sessionId, ruleId)`. subagent는 부모 session_id를 공유 → 동시 다수 subagent가 같은 카운터를 공유해 **조기 stuck-loop force-approve** 발생. 키를 `(sessionId, agent_id?, ruleId)`로 확장.
- **2d. per-agent recentTools**: `modified-files`가 sessionId만으로 키잉되면 subagent의 tool 호출이 부모 윈도우에 섞이거나 비어, **TEST-2 거짓 양성**(subagent가 점수 선언했는데 "tool 0회"로 오판)이 dominant 리스크. post-tool-use가 `agent_id`를 받으면 per-agent 윈도우로 분리. *(probe로 PostToolUse 발화/agent_id 유무 먼저 확인)*
- **비용 경계**: 가드는 regex-only(LLM 없음)라 1,000 에이전트에도 저렴. block 재시도는 `STUCK_LOOP_THRESHOLD`로 상한 유지.

### §3. (무조건 + 신기능 흡수) 워크플로우 템플릿 + forgen-verify agentType

워크플로우는 Claude이 짜는 JS이고 `.claude/workflows/`에 저장 가능. forgen이 **canonical 스크립트 자산**을 동봉한다. 워크플로우는 adversarial verify-until-converge를 이미 네이티브로 하므로, forgen의 기여는 *패턴이 아니라 forgen의 기준*:
- **(i) 증거 게이팅 verify 스테이지**: v1-rules의 "mock 금지·실제 실행 증거" 기준을 워크플로우 verify 스테이지로 (e2e-result.json 신선도 체크 등).
- **(ii) compound recall → fan-out**: 워크플로우 시작 전 MCP `compound-search`로 관련 솔루션 주입.
- **(iii) synthesis → compound 흡수**: 워크플로우 산출 findings를 compound store에 적재 (워크플로우는 findings 대량 생산 → 복리화 소스 최적).

템플릿 후보: `evidence-gate-audit`, `compound-extraction-as-workflow`, `prove-it-review`. + 워크플로우 author가 호출할 `forgen-verify` 커스텀 subagent 정의.

### §4. (확정 결함, 무조건) 동시성 임계값 워크플로우 인지

`MAX_CONCURRENT_AGENTS = 10` → 워크플로우(동시 16) 및 team/swarm/ultrawork(>10)에서 **매 실행 경고 스팸**. 수정:
- `FORGEN_MAX_CONCURRENT_AGENTS` env로 설정화, 기본 **16**.
- 워크플로우 컨텍스트 감지 시 경고 억제(또는 임계값 상향).

### §5. (P1 feature) effort 라우팅 축

forgen엔 현재 effort 차원도, 렌더된 routing 자산도 없음. forgen은 Claude의 effort를 **프로그램적으로 설정할 수 없다**(해당 hook API 없음) → **권고/넛지만 가능, 정직하게 그렇게 문서화**한다. forge-loop / compound-extraction 같은 long-running 경로에서 `xhigh`/`ultracode` 권고를 doctor·health 또는 주입 컨텍스트로 노출.

### §6. Multi-host 파리티

Codex엔 dynamic-workflows 등가물 없음 → `workflow-verify` intent는 Codex에서 `unsupported` 선언(graceful degrade). Claude는 reference host 유지. §2 subagent 검증은 Codex subagent 모델 차이로 별도 probe 필요(probe 전 미선언).

### §7. 포지셔닝 / 재캘리브레이션

4.8이 결함 4× 덜 놓침 + 자기 교정을 네이티브로 → forgen 메타 가드의 **거짓 양성 비용이 상승**. v0.4.5 통계(δ>0)는 **sonnet/codex 기준이지 opus-4.8이 아님**. 4.8 baseline에 대해 calibrate/forgen-eval **재측정 전까지 효과 불변을 주장하지 않는다**(프로젝트 룰). forgen 차별점은 유효: 세션 간 compound 메모리, 개인화 룰, 실행-증거 게이팅, multi-host.

## Consequences

**긍정**: (a) §4/§5/§3는 probe와 무관하게 즉시 가치; (b) §3는 forgen을 "워크플로우 시대"에 재포지셔닝(검증 래퍼 → 워크플로우 품질 공급자); (c) §2는 team/swarm/ultrawork 스킬에 오늘 당장 검증 확대.

**부정/리스크**: (a) §2의 거짓 양성(2d)이 최대 리스크 — per-agent tool 추적 없이는 TEST-2 오탐; (b) 워크플로우 토큰 비용(사용자 고지 필요); (c) §1 probe가 0.4.11 스코프를 게이트 → §2는 probe 결과에 종속.

## 구현 현황 (2026-05-29)

§1 probe 후 사용자 결정으로 A+B+C 동시 착수, 구현 완료(테스트 그린, 전체 2712 passed):

- **§A 레이스 수정** — `subagent-tracker.ts`: `recordAgentEvent()` 추출 + `withFileLock` 으로 RMW 보호, 락 안 fresh re-read. in-process 동시성 테스트(12 동시 → 전수 보존)로 박제. probe 의 "3-of-3 → 2" lost-update 해소 확인(실 subprocess 8 동시 → 8 보존).
- **§B 동시성** — `maxConcurrentAgents()` env(`FORGEN_MAX_CONCURRENT_AGENTS`, 기본 16) + `shouldWarnConcurrency()` 로 workflow-subagent 면제. 순수 함수 테스트.
- **§2a 디스패처 추출** — `checks/_shared/meta-guard-dispatch.runMetaGuards()`. stop-guard 가 위임(동작 불변 — stop-guard 110 회귀 그린). 8-case 동등성 테스트.
- **§2 SubagentStop 검증** — 신규 `hooks/subagent-stop-guard.ts` + registry 등록. transcript 폴백 리더(2b), `(sessionId, agentId)` block-count(2c), per-agent recentTools(2d, `post-tool-use` 가 agent_id 있을 때 `modified-files-{sessionId}.agent-{agentId}` 로 분리).
- 잔여: §3 워크플로우 템플릿, §5 effort 권고, §7 재캘리브레이션. **릴리스 완료 게이트**: Docker e2e(`e2e-result.json` 1h) 미실행.

## 0.4.11 스코프 (사용자 결정: 전부 0.4.11)

| 항목 | probe 종속? | 비고 |
|---|---|---|
| §1 probe (+`forgen probe-workflow`) | — | **선행 필수** |
| §4 동시성 임계값 | ✗ 무조건 | 가장 단순, 확정 결함 |
| §3 워크플로우 템플릿/agentType | ✗ 무조건 | 신기능 흡수 핵심 |
| §5 effort 권고 | ✗ 무조건 | 넛지-only |
| §2 SubagentStop 검증 | ✓ probe-gated | 발화 확인 시 워크플로우까지, 아니면 Task-tool 한정 |
| §6 파리티 선언 | ✓ probe 후 | capability는 검증 후 선언 |
| §7 재캘리브레이션 | ✗ 권장 | 출시 주장 정직성 |

## Open Questions (probe로 해소)

1. 워크플로우 내부 에이전트에 SubagentStart/Stop·PostToolUse 훅이 발화하는가? (§1)
2. SubagentStop transcript_path가 subagent 메시지를 담는가? (§2b)
3. PostToolUse가 subagent tool에 발화하며 `agent_id`를 제공하는가? (§2d)
4. `CapabilityStatus`에 `unverified` 추가가 필요한가, 아니면 probe-선행으로 충분한가? (§1)
