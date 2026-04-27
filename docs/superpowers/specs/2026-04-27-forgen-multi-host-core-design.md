# Forgen Multi-Host Core Design

> 작성일: 2026-04-27
> 목적: `forgen`을 Claude 전용 하네스에서 `Claude + Codex`를 공식 지원하는 다중 호스트 하네스로 확장하기 위한 제품/아키텍처 설계

---

## Executive Summary

`forgen`은 계속 하나의 제품으로 남는다. 사용자는 여전히 `forgen` 하나를 설치하고 실행하지만, 내부 구조는 `Claude-canonical core + host adapters`로 재편한다.

**제 1원칙: Claude 동작이 reference, Codex는 등가성을 확보하는 확장이다.** 현재 forgen이 Claude 위에서 보장하는 행동(Trust Layer block, 컨텍스트 inject, 자기증거 박제, observe-only 강등 등)이 forgen 의 *행동 spec* 그 자체다. Codex 어댑터의 책임은 이 행동을 Codex 표면 위에서 같은 의미로 재현하는 것이다. 행동을 추상화한 호스트 중립 코어가 아니라, **Claude 의미를 알고 있는 코어**를 명시적으로 선택한다. 비대칭 의존(core ↔ Claude 는 알아도 됨, core ↔ Codex 는 모른다)이 본 설계의 출발점이다.

사용자 메모리는 호스트별로 분리하지 않는다. 프로필, 공용 규칙, 축적된 솔루션은 하나의 `forgen` 기억으로 유지한다. 실행 증거와 세션 로그에는 `host` 태그를 붙여 어느 호스트에서 나온 신호인지 보존한다. 이 구조는 사용자의 판단 철학을 유지하면서도 호스트별 특이성과 노이즈를 분리할 수 있게 한다.

교차 호스트 협업(`consult/review/verify/execute/dual-run`)은 1원칙과 별 트랙으로 다룬다. 1차 마일스톤은 "두 호스트가 단독으로 같은 행동" 까지이며, cross-host 호출은 그 위에 얹는 옵션이다.

---

## 1. 목표와 비목표

### 목표

- `forgen` 하나의 제품 경험을 유지하면서 Claude(canonical reference)와 Codex(등가 확장)를 둘 다 공식 지원한다.
- **Claude 위에서 forgen 이 보장하는 행동(Trust Layer 의도, 컨텍스트 inject, 자기증거 박제 등)을 Codex 단독 실행에서도 의미 보존하여 재현한다.** 이 등가성을 자동 검증하는 behavioral parity test 를 1차 산출물로 갖는다.
- 장기 사용자 메모리와 판단 철학을 두 호스트가 공통으로 사용한다.
- 현재의 임시 `runtime === 'codex'` 분기 구조를 `Claude-canonical contract + Codex projection adapter` 구조로 치환한다.
- 외부 UX를 급격히 바꾸지 않고, 내부 구조부터 패키지 분리 가능한 상태로 재편한다.

### 비목표

- 첫 릴리스에서 Gemini 등 제3의 호스트까지 지원하지 않는다.
- 처음부터 npm 패키지를 `forgen-core`, `forgen-claude`, `forgen-codex`로 분리 배포하지 않는다.
- **호스트 중립 추상 스키마를 새로 만들지 않는다.** Claude Hook schema 가 사실상 contract 다. Codex 어댑터의 책임은 이 schema 로의 사영(projection)이다.
- 기본 모드를 항상 병렬 다중 호스트 실행으로 만들지 않는다.
- 다중 호스트 자유 대화방이나 무제한 모델 합성 기능을 1차 범위에 넣지 않는다.
- 1차 마일스톤에 cross-host 호출(`consult/review/verify/execute/dual-run`)을 포함하지 않는다. 이는 "두 호스트 단독 등가성" 이후 별 트랙.

---

## 2. 결정 사항

### 2.0 제 1원칙 — Claude canonical reference

- **Claude 동작 = forgen 의 행동 spec.** 현재 Trust Layer / hook / inject / 박제 흐름은 추상이 아니라 정의 그 자체.
- Codex 어댑터의 책임은 이 행동을 Codex 표면 위에서 같은 의미로 재현(projection) 하는 것.
- 비대칭 의존: core 가 Claude semantics 를 직접 알고 있는 것은 OK. core 가 알지 말아야 할 것은 *Codex 의 표면*(`.codex/` 경로, codex hook schema 등) 뿐이다.
- 이는 spec 9 의 성공기준을 "새 호스트 추가 시 core 수정량이 작다" 가 아니라 "**새 호스트 어댑터가 behavioral parity test 를 통과한다**" 로 재정의한다는 의미이기도 하다.

### 2.1 제품 경계

- 외부 제품은 계속 `forgen` 하나로 유지한다.
- 내부 구조는 `Claude-canonical core + Codex projection adapter + umbrella CLI`로 분리한다.
- 초기 배포는 단일 패키지를 유지하고, 실제 패키지 분리는 구조 안정화 이후 단계적으로 검토한다.

### 2.2 메모리 전략

- 사용자 프로필, 공용 규칙, 축적된 솔루션은 하나의 공용 메모리로 유지한다.
- 실행 증거, 세션 메타데이터, 호스트별 판정 흔적은 `host-tagged evidence`로 저장한다.
- 검색은 호스트 가중치 없이 공용 인덱스를 그대로 사용한다. **Claude 에서 검증된 솔루션은 Codex 에서도 통해야 한다는 것이 1원칙의 따름정리**. 호스트별 신호는 가중치가 아니라 *불일치 demote*(같은 솔루션이 한 호스트에서만 자주 깨지면 그 호스트에서 demote/suppress) 로만 사용한다.

### 2.3 협업 전략

- 1차 마일스톤: 두 호스트가 단독으로 같은 행동을 보장하는 것까지.
- Cross-host 호출(`consult/review/verify/execute`) 과 `dual-run` 은 1차 이후 별 트랙으로 도입.

---

## 3. 아키텍처 개요

전체 구조는 세 층으로 나눈다.

1. `forgen` umbrella CLI
2. shared core
3. host adapters

### 3.1 Umbrella CLI

`forgen` CLI는 사용자가 접하는 단일 진입점이다.

- 설치/초기화 UX를 유지한다.
- 사용 가능한 호스트를 탐지한다.
- 하나 이상의 호스트 설치를 관리한다.
- 세션 시작 시 어떤 호스트를 driver로 쓸지 결정한다.
- 필요한 경우 peer host 호출을 조정한다.

### 3.2 Claude-Canonical Core

코어는 Claude 의 행동 의미(Trust Layer 의도, Hook schema 의 의미적 사영, Stop/PreToolUse/SessionStart/UserPromptSubmit 이벤트 의미)를 *알고 있는* 계층이다.

- Profile, preset, trust policy
- Rule model, lifecycle, enforcement intent (intent 정의는 Claude hook 의미를 그대로 사용)
- Compound extraction, solution index, promotion/demotion
- Shared MCP and retrieval domain
- Session domain, evidence domain, analytics
- Behavioral parity test harness

이 계층이 *몰라야 하는 것*은 다음이다.

- `.codex/` 경로, Codex 고유 CLI 옵션, Codex hook JSON 스키마의 raw 형태
- Codex 실행 파일명, Codex 권한 모델의 표면 표현

즉 비대칭 경계: Claude 의미는 직접 사용 가능, Codex 의 표면만 차단.

### 3.3 Host Adapters

각 어댑터는 해당 호스트에 붙는 법만 책임진다.

- 환경 감지와 설치 위치 계산
- settings/hooks/commands/agents 자산 주입
- 런타임 실행
- 호스트 이벤트를 **Claude Hook schema 로 사영(projection)** — 호스트 중립 추상 스키마는 도입하지 않는다.
- 세션 산출물을 코어가 학습 가능한 형태(Claude 세션 레코드 동치) 로 변환
- 1원칙 등가성 책임: Trust Layer 의도(블록/허용/관찰/inject) 가 Codex 표면에서 같은 의미로 재현되도록 보장

초기 대상 어댑터:

- `host-claude` — projection 이 사실상 identity. 어댑터라기보다 reference binding.
- `host-codex` — projection + 미지원 의도에 대한 mitigation 책임

---

## 4. 공유 메모리와 Host-Tagged Evidence

### 4.1 공유되는 것

다음 상태는 호스트와 무관하게 하나만 유지한다.

- `Profile`
- `base_packs`
- `trust_preferences`
- `Rule`
- `Solution`
- 장기 recommendation/history

이 데이터는 사용자의 판단 철학을 대표하므로 호스트별 복제본을 만들지 않는다.

### 4.2 태그가 붙는 것

다음 상태는 호스트 태그를 포함한다.

- `Evidence`
- session log
- tool/hook verdict
- permission decision
- transcript provenance
- cross-host delegation record

권장 필드:

- `host: 'claude' | 'codex'`
- `host_session_id`
- `adapter_version`
- `source_surface`
- `normalization_confidence`

### 4.3 규칙과 검색 해석

- 규칙은 공유 규칙으로 유지한다.
- 규칙 lifecycle 에는 `by_host` 통계 관점을 추가한다.
- 솔루션 검색은 호스트 가중치 없이 공용 인덱스를 그대로 사용한다 — Claude 에서 검증된 솔루션은 Codex 에서도 통해야 한다는 1원칙의 따름정리.
- 호스트별 신호는 가중치가 아니라 *불일치 demote* 로 사용한다. 같은 솔루션이 한 호스트에서만 반복적으로 깨지면 그 호스트 한정으로 demote/suppress 하고 lifecycle 에 사유 박제. 양호한 호스트에서는 변화 없음.
- 호스트별 위반률 차이는 규칙 복제가 아니라 evidence 해석과 threshold 튜닝으로 다룬다.

핵심 원칙은 `행동 reference 는 Claude, 증거는 host-tagged, 어댑터는 등가성 책임`이다.

---

## 5. Core와 Adapter 인터페이스 계약

폴더 분리보다 중요한 것은 양쪽이 서로 무엇을 몰라야 하는지 명확히 하는 것이다. **추상 스키마를 새로 만들지 않는다 — Claude Hook schema 가 contract 이다.**

### 5.1 Core가 제공하는 계약

코어는 다음 계약을 제공한다.

- `PolicyBundle`
  - 이번 세션에 필요한 규칙, 가드, 프롬프트 조각, 권한 의도(Claude hook 의미 그대로)
- `TrustLayerIntent`
  - forgen 이 보장하는 행동 의도의 enum (block-completion / block-tool-use / inject-context / observe-only / secret-filter / forge-loop-state-inject / self-evidence-record). 본 문서의 §9 Capability Matrix 와 1:1.
- `SessionLearningInput`
  - 세션 종료 후 학습에 필요한 이벤트 집합 (Claude 세션 레코드 형태)
- `BehavioralParityScenario`
  - "Claude 와 Codex 양쪽에서 같은 의미의 evidence 를 만들어야 한다" 를 검증하는 골든 시나리오 정의

### 5.2 Adapter가 제공하는 계약

어댑터는 다음 계약을 제공한다.

- `HostCapabilities`
  - 호스트가 표현 가능한 `TrustLayerIntent` 집합 (`supported` / `partial` / `unsupported`) + partial/unsupported 시 mitigation 핸들
- `InstallPlan`
  - settings/hooks/commands/agents 를 어디에 어떤 형식으로 설치할지
- `LaunchPlan`
  - 어떤 런처와 인자로 세션을 시작할지
- `ProjectToClaudeEvent`
  - 호스트 이벤트를 Claude Hook schema 로 사영하는 함수 (현재 `src/host/codex-adapter.ts` 의 `normalizeOutput` 이 이 역할의 prototype)
- `SessionRecord`
  - transcript/tool/hook 결과를 Claude 세션 레코드 동치로 변환한 결과

### 5.3 경계 규칙 (비대칭)

- core 는 `hosts/codex/*` 를 import 하지 않는다.
- core 는 `hosts/claude/*` 의 *행동 의미* 는 직접 참조해도 된다. host-claude 어댑터는 사실상 reference binding 이며, 그 의미가 곧 contract 다.
- adapter 는 profile scoring, lifecycle transition, solution promotion 로직을 구현하지 않는다.
- Codex adapter 는 host-native artifact 를 다루고, Claude semantics 로 사영한 결과만 core 에 전달한다.
- *어떤 `TrustLayerIntent` 가 Codex 에서 unsupported 인지* 는 어댑터의 `HostCapabilities` 에서 명시적으로 노출하며, 미선언은 빌드 fail.

---

## 6. Claude ↔ Codex 상호 호출 모델 (별 트랙, 1차 범위 외)

> **이 섹션은 1차 마일스톤 범위 밖이다.** 1원칙(두 호스트가 단독으로 같은 행동) 이 충족된 이후 Phase 4 에서 도입한다. 본 섹션은 미래 인터페이스 의도를 박제해 두는 용도.

### 6.1 기본 모드

기본 모드는 `single driver host`다.

- 현재 세션의 주 호스트가 작업을 진행한다.
- 필요할 때만 다른 호스트를 peer로 호출한다.
- 사용자는 기본적으로 한 호스트와 작업하는 느낌을 유지한다.

### 6.2 Peer 호출 유형

Peer 호출은 구조화된 작업 단위로 나눈다.

- `consult`: 설계/접근법 대안 비교
- `review`: 구현 후 결함/회귀 검토
- `verify`: 테스트/반례/재현 검증
- `execute`: 특정 호스트가 더 잘하는 작업의 부분 실행
- `dual-run`: 병렬 가치가 큰 고난도 작업에서만 활성화

### 6.3 Cross-Host 메시지 계약

주 호스트는 peer 호출 시 짧은 구조화 brief를 보낸다.

- task summary
- current constraints
- relevant files or artifacts
- requested role
- expected output shape

Peer 호스트는 구조화된 verdict를 반환한다.

- recommendation
- evidence
- confidence
- concrete patch or test suggestion
- remaining risks

이 결과를 주 호스트가 `MergeDecision`으로 합성하고 최종 행동을 결정한다.

### 6.4 기본 트리거

다음 상황에서 peer 호출을 고려한다.

- 설계 대안이 2개 이상이며 trade-off가 큰 경우
- 구현은 끝났지만 회귀 가능성이 큰 경우
- 특정 호스트가 더 강한 작업 유형이 분명한 경우
- 검증 비용이 높아 주체와 검증자를 분리할 가치가 있는 경우

병렬 `dual-run`은 다음 조건이 동시에 맞을 때만 허용한다.

- 문제 난도가 높다
- 병렬 가치가 분명하다
- 결과 merge 비용이 감당 가능하다
- 사용자 선호와 비용 정책이 허용한다

---

## 7. 저장소 구조와 단계적 패키지 분리

### 7.1 1차 목표 구조

초기 리팩터링은 현재 저장소 안에서 경계를 만드는 데 집중한다.

- `src/core-domain`
- `src/core-app`
- `src/hosts/claude`
- `src/hosts/codex`
- `src/cli`

현재의 `store`, `engine`, `preset`, `renderer`, `mcp`는 대부분 `core-domain`에 해당한다. 현재 `settings-injector`, `spawn`, `hooks-generator`, `plugin.json`, `agents/`, `commands/`처럼 Claude/Codex와 직접 얽힌 부분은 `core-app` 또는 `hosts/*`로 이동해야 한다.

### 7.2 자산 구조

정적 자산도 호스트별로 나눈다.

- `assets/claude/...`
- `assets/codex/...`

예:

- Claude plugin manifest
- Claude agents/commands/hooks
- Codex 전용 settings or runtime templates

설치 시에는 어댑터가 필요한 자산만 선택적으로 주입한다.

### 7.3 패키지 전략

단계는 다음 순서를 따른다.

1. 단일 패키지 유지, 내부 경계 정리
2. Codex adapter를 동일 계약 위로 재구성
3. 릴리스와 테스트가 안정화되면 실 패키지 분리 검토
4. 필요 시 `forgen-core`, `forgen-host-claude`, `forgen-host-codex`, `forgen` 메타 패키지로 전환

이 설계의 핵심은 처음부터 패키지를 쪼개는 것이 아니라, 언제든 쪼갤 수 있는 구조를 먼저 만드는 것이다.

---

## 8. 릴리스 전략

### Phase 1: Trust Layer Capability Matrix + Parity Test 골격

- §9 Capability Matrix 채우기 — `TrustLayerIntent` 7종에 대해 Codex 표면의 supported/partial/unsupported 분류 + mitigation 명시
- `BehavioralParityScenario` 골격 도입 — 같은 입력을 두 호스트에서 돌렸을 때 evidence stream 의 *의미적 동치성* 을 검증하는 골든 테스트
- `HostCapabilities` 인터페이스 + 빌드시 unsupported 미선언 fail

### Phase 2: Claude semantics 의 코어 노출 + Codex projection 정리

- 기존 `runtime === 'codex'` 분기 6 개소를 `host-codex` 어댑터로 흡수
- `src/host/codex-adapter.ts` 의 normalizeOutput 을 정식 `ProjectToClaudeEvent` 계약으로 승격
- Claude 전용 자산(`assets/claude/`) 과 codex 자산(`assets/codex/`) 분리, 공통 자산은 `assets/shared/`

### Phase 3: Codex 단독 등가성 (1차 마일스톤 종결)

- Phase 1 의 parity test 가 Codex 단독에서 모두 pass
- Codex 환경의 host-tagged evidence 가 정상 누적, profile/rule/compound 흐름이 Claude 와 의미 동치
- 이 시점에 1원칙 달성 선언

### Phase 4: 교차 호스트 호출 (별 트랙)

- §6 의 `consult/review/verify/execute` 도입
- `dual-run` 승격 모드 도입
- 1원칙이 보장된 위에서만 진행

순서를 바꾸지 않는다. Codex 단독 등가성이 박제되기 전에 cross-host 를 열면 행동 reference 가 흐려진다.

---

## 9. 성공 기준 + Trust Layer Capability Matrix

### 9.0 Trust Layer Capability Matrix (Phase 1 산출물)

`TrustLayerIntent` 7종에 대해 어댑터가 채워야 할 표. *미선언은 빌드 fail.*

> **출처**: Codex CLI 공식 docs (`developers.openai.com/codex/hooks`) 와 deepwiki 분석 (2026-04-27 조사). Codex hook 스키마는 SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop 5종에서 Claude 와 거의 1:1 으로 정렬된다. PermissionRequest 는 Codex 단독 hook (forgen 1차 미사용).

| Intent | Claude 표현 | Codex 대응 | 상태 | Mitigation / 메모 |
|---|---|---|---|---|
| `block-completion` | Stop + `decision:"block"` + `reason` | Stop + `decision:"block"` + `reason` (reason 이 다음 턴 prompt 로 자동 주입) | **supported** | 의미 동치. `stop_hook_active` 무한루프 가드 동치성 확인 필요. |
| `block-tool-use` | PreToolUse + `permissionDecision:"deny"` + reason | PreToolUse + `permissionDecision:"deny"`(allow/deny/ask) + `permissionDecisionReason` | **supported** | 의미 동치. Codex 추가 `ask` 값은 forgen `denyOrObserve` 의 ask 의도와 합치 (향후 활용). |
| `inject-context` (M1) | SessionStart/UserPromptSubmit + `hookSpecificOutput.additionalContext` | SessionStart/UserPromptSubmit + `additionalContext` | **supported** | 사영(projection) 거의 identity. 위치/계층(hookSpecificOutput nesting) 차이만 보정. |
| `observe-only` (P3') | non-allowlist hook approve + observer log | 어떤 hook 이든 approve 출력 + log only | **supported** | 어댑터 책임은 `denyOrObserve` 결과의 stdout JSON 사영뿐. |
| `secret-filter` | PostToolUse + 차단/redact (현재는 PreToolUse 가드) | **MCP tool 한정**: PostToolUse + `hookSpecificOutput.updatedMCPToolOutput` 으로 명시 redact. **일반 shell/edit tool**: `decision:"block"` + `reason` 만 가능, 결과 replace 는 미보장 | **supported (조건부)** | Codex self-validation FIX#4: 일반 tool redact 계약은 없음. forgen 1차는 기존 PreToolUse 가드 유지 + MCP tool 결과에 한해 PostToolUse redact 도입. |
| `forge-loop-state-inject` | SessionStart/UserPromptSubmit + `<forge-loop-state>` ≤1KB | 동일 (additionalContext 텍스트) | **supported** | 1KB cap 정책 그대로 적용 가능. |
| `self-evidence-record` | hook 결과 → `~/.forgen/state/*.json` 박제 | host 무관 | **supported** | 박제 경로는 host 와 무관, 단 evidence 에 `host` 필드 추가 필요 (마이그레이션 대상). |

요약: **Codex 어댑터의 projection 은 사실상 identity 에 가깝다.** 진짜 어려움은 schema 사영이 아니라 *환경 감지 / hook 등록 위치 / 자산 배치* 쪽임. 다음 우선 산출물은 InstallPlan + 환경 감지.

#### Hook 출력 계약 (Codex self-validation FIX#16/#17)

- **stdin**: 모든 hook 이 JSON object 1건 수신. (OK)
- **stdout**: event 별 JSON object 가 기본 계약. SessionStart/UserPromptSubmit 의 plaintext 입력이 있다고 해서 *모든 hook 이 stdout 으로 plaintext 를 보낼 수 있는 것은 아님*.
- **exit code 2 + stderr**: 각 event 별로 의미가 다름. "단일한 blocking 규약" 으로 묶으면 안 됨. forgen 어댑터는 event 별 사양에 맞춰 출력해야 한다 (현재 `codex-adapter.ts` 의 normalizeOutput 은 stdout JSON 만 다루므로 안전).

### 9.1 기술 성공 기준

- Claude 와 Codex 가 같은 사용자 메모리를 공유한다.
- evidence 와 세션 메타는 host-tagged 로 기록된다.
- core 가 *Codex 의 표면* 을 직접 알지 않는다 (Claude semantics 는 알아도 됨 — 비대칭).
- **Codex 어댑터가 §9.0 의 `supported` 항목 모두를 BehavioralParityScenario 로 통과한다.** `partial`/`unsupported` 항목은 mitigation 의 효과가 동일 시나리오에서 측정·박제된다.
- 새 Trust Layer 의도가 추가될 때마다 어댑터의 `HostCapabilities` 미선언 시 빌드 fail.

### 9.2 제품 성공 기준

- 사용자는 `forgen` 하나로 설치하고 사용할 수 있다.
- 어느 호스트를 쓰더라도 판단 철학과 축적 지식이 이어진다.
- Claude 든 Codex 든 forgen 의 핵심 행동(블록/inject/박제)이 의미 동등하게 작동한다.

### 9.3 실패 기준

- 사실상 호스트별 메모리가 분리된다.
- Codex 단독에서 forgen 의 핵심 행동(특히 `block-completion`, `inject-context`) 이 약화·생략·noop 으로 끝난다.
- core 가 Codex 표면을 직접 알게 되어 다시 런타임 분기 덩어리로 회귀한다.
- Capability Matrix 가 채워지지 않은 채 Phase 2 가 시작된다.

---

## 10. 구현 우선순위

✅ = 본 문서에서 결정 완료. 코드 작업은 다음 순서.

- ✅ **0a. §9.0 Trust Layer Capability Matrix** — schema 매트릭스 (7/7 supported)
- ✅ **0b. §13 권한 모델 매핑** — forgen default `--full-auto`, `--yolo` opt-in, hook 은 sandbox 와 직교
- ✅ **0c. §14 자산 배치 매트릭스** — manifest 위치만 host 별, hook 본체는 공유. `CODEX_HOME` e2e 격리
- ✅ **0d. §15 Stop hook 동치성** + ✅ **§16 PermissionRequest 1차 미사용**
- **1. `TrustLayerIntent` enum + `HostCapabilities` 인터페이스 + 빌드시 미선언 fail** ← 다음 코드 작업
- **2. `ProjectToClaudeEvent` 계약 도입 + 현재 `src/host/codex-adapter.ts` 승격**
- **3. Codex `InstallPlan` 구현** — `~/.codex/hooks.json` 머지 (idempotent + managed marker), `~/.codex/config.toml [mcp_servers]` 등록
- **4. `BehavioralParityScenario` harness 도입** — Claude/Codex 동일 시나리오 evidence 동치 검증
- **5. host-tagged evidence + 불일치 demote** (가중치 X)
- **6. Phase 3 종결 — Codex 단독 parity test green** → 1원칙 달성 선언
- (Phase 4) **7. cross-host `consult/review/verify/execute`**
- (Phase 4) **8. 제한적 `dual-run` 승격 모드**

우선순위 1~6 이 완료되기 전에는 cross-host 와 `dual-run` 을 열지 않는다.

---

## 11. 설계 원칙 요약

- **행동 reference 는 Claude, 어댑터는 등가성 책임이다.**
- 제품은 하나, 내부 구조는 비대칭(core ↔ Claude 의미는 알아도 됨, Codex 표면은 모름) 이다.
- 메모리는 하나, 증거는 host-tagged 다.
- 추상 스키마를 새로 만들지 않는다 — Claude Hook schema 가 contract 다.
- 1차 마일스톤은 두 호스트 단독 등가성. cross-host 는 그 위에 얹는 별 트랙.
- 패키지 분리는 목표가 아니라, 분리 가능한 구조가 목표다.

---

## 12. 거꾸로 검증 결과 (2026-04-27)

§9.0 Capability Matrix 를 외부 docs 기반으로 1차 채운 결과로 spec 의 가정이 어디서 검증되고 어디서 약해지는지 박제한다.

### 12.1 강해진 가정

- **"Claude Hook schema 가 contract"**: Codex 의 5종 hook (SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop) 이 schema-level 에서 거의 1:1 정렬. `ProjectToClaudeEvent` 가 *식별 사상에 가까운* 함수가 됨. spec §5.2 의 의도가 예상보다 적은 비용으로 달성됨.
- **"비대칭 코어"**: Codex 어댑터의 부피가 작다는 것은 곧 core 가 Claude semantics 를 직접 사용하는 것이 자연스럽다는 의미. spec §5.3 의 비대칭 경계가 옳은 선택.
- **"1차 마일스톤은 단독 등가성"**: schema 동치성이 강하므로 등가성 달성이 빠름. cross-host 를 별 트랙으로 미룬 결정이 더 강한 의미를 가짐.

### 12.2 약해지거나 재정의된 가정

- **§4.3 "불일치 demote"**: schema 가 거의 동치이므로 행동 차이가 작을 가능성. demote 신호원은 "솔루션이 깨졌다" 보다 *모델 행동의 2차 신호*(채택률, 재시도 횟수, drift event 빈도) 가 되어야 의미 있음. 이 부분 1차 구현 시 측정 기반으로 정의.
- **§3.3 "host-codex 가 projection + mitigation 책임"**: supported 가 7/7 이므로 mitigation 트랙은 거의 비어 있음. 어댑터 부피의 70% 이상은 schema 사영이 아니라 **환경 감지 / hook 등록 위치 / 자산 배치 / 권한 모델 매핑** 이 차지함.

### 12.3 새로 드러난 미정 결정 — 1차 결정 결과

매트릭스가 schema 사영을 거의 해결한 결과 부상한 5개 중 4개를 §13~§16 에서 닫았다.

1. ✅ **권한 모델 매핑** → §13. forgen default = `--full-auto`, `--yolo` 는 명시 opt-in. forgen Trust Layer hook 은 sandbox 와 직교 — 항상 작동.
2. ✅ **자산 배치** → §14. hook 스크립트 본체는 host 무관 dir 재사용, manifest 위치만 host 별 inject. `CODEX_HOME` 으로 e2e 격리.
3. ✅ **Stop hook 무한루프 가드** → §15. Codex `stop_hook_active` 가 Claude 와 동일 의미. 마이그레이션 불필요.
4. ✅ **`PermissionRequest` hook** → §16. 1차 미사용 (1원칙 위반 위험). Phase 4 에서 observe-only signal 로 재고려.
5. ⏳ **enterprise `requirements.toml`** — 1차 비지원 결정 (§14.3). Phase 2+ 에서 admin install 채널로 활용 검토.

### 12.4 우선순위 재배치 (적용 완료)

- 본래 §10 우선순위 1 ("Capability Matrix") 의 **schema-level 부분은 §9.0 에서 완료**, 권한 모델은 §13, 자산 배치는 §14, Stop guard 동치성은 §15 에서 닫혔다.
- 다음 우선순위는 §10 의 2~6 (`TrustLayerIntent` enum, ProjectToClaudeEvent 승격, host-tagged evidence, parity test) 으로 자연 이동한다.
- §10 을 본 결정 결과로 업데이트했다.

### 12.5 외부 출처

- [Hooks – Codex | OpenAI Developers](https://developers.openai.com/codex/hooks)
- [Hooks System | openai/codex DeepWiki](https://deepwiki.com/openai/codex/3.11-hooks-system)
- [Agent approvals & security – Codex](https://developers.openai.com/codex/agent-approvals-security)
- [Codex CLI Configuration Reference](https://codex.danielvaughan.com/2026/04/08/codex-cli-configuration-reference/)
- [PR #9796 — Comprehensive hooks system](https://github.com/openai/codex/pull/9796)
- [Issue #14882 — PreToolUse/PostToolUse lifecycle hooks proposal](https://github.com/openai/codex/issues/14882)

---

## 13. 권한 모델 매핑 (Phase 1 산출물 #2)

forgen 은 Trust Layer 의도(§9.0)를 hook level 에서 강제한다. Codex 의 `approval_policy` × `sandbox_mode` 는 그 *위 layer* 의 환경 신뢰 모델이며, hook 차단과 직교한다. 즉 forgen 의 `block-tool-use` 는 sandbox 가 무엇이든 작동한다.

### 13.1 Codex 권한 축

source 확정 (`AskForApproval.ts` 5 값, §18.3):

- `approval_policy` (5종): `untrusted` / `on-failure` *(deprecated)* / `on-request` / `granular { sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations }` / `never`
- `sandbox_mode`: `read-only` / `workspace-write` / `danger-full-access`
- 편의 플래그 (source `cli/src/main.rs` 확정):
  - `--full-auto` ⟺ `approval_policy=on-request` + `sandbox_mode=workspace-write`
  - `--dangerously-bypass-approvals-and-sandbox` ⟺ `approval_policy=never` + `sandbox_mode=danger-full-access`. `conflicts_with = "full_auto"`. 0.125.0 에 `--yolo` 별칭 없음.

### 13.2 forgen trust policy ↔ Codex 매핑

| forgen trust policy | Codex 권장 조합 | 이유 |
|---|---|---|
| **가드레일 우선** | `--full-auto` (network 비활성 workspace-write + low-friction approval) | destructive/외부 네트워크/workspace 외 변경에 prompt. forgen `block-tool-use` 는 그 위에서 추가 가드. |
| **자율 우선** | `--full-auto` (그대로) | sandbox 는 동일하게 두고 forgen `denyOrObserve` 정책으로만 흔들기. **`--dangerously-bypass-approvals-and-sandbox` 는 권장하지 않는다** — Trust Layer 가 형해화됨. |
| (특수) **읽기 전용 검토 세션** | `-s read-only` (`-a untrusted` 와 조합 가능) | code review / security review 같은 read-only 흐름. |

**결정**: forgen 1차는 `--full-auto` 를 default 로 inject 하고, `--dangerously-bypass-approvals-and-sandbox` 는 `forgen --runtime codex --bypass` 같은 명시 opt-in 시에만 통과시킨다. 그 경우에도 forgen Trust Layer hook 들은 항상 작동(사용자가 sandbox 를 끈 것이지 Trust Layer 를 끈 것이 아님).

### 13.3 권한 모델 - hook 직교성 정리

- forgen `block-tool-use` (PreToolUse `permissionDecision:"deny"`) 는 sandbox/approval 과 **독립적으로** 작동한다.
- 즉 사용자가 `--dangerously-bypass-approvals-and-sandbox` 를 켜도 forgen 의 `pre-tool-use` 가드(rm -rf, dangerous patterns), `db-guard`, `secret-filter` 는 그대로 작동.
- 이는 v1-rules.md 의 "사용자 confirm 없는 rm -rf 실행 금지" 와 같은 forgen 자체 규칙이 Codex 에서도 Claude 와 동일하게 보장된다는 의미.

---

## 14. 자산 배치 매트릭스 (Phase 1 산출물 #3)

### 14.1 Codex 자산 위치 (전체 layer)

Codex hook 은 다음 위치 중 활성 layer 에서 로드된다 (Codex self-validation FIX#12/#13 으로 system 레이어 추가 박제).

**Hook 등록 가능 위치**:
1. `~/.codex/hooks.json` (user, default `$CODEX_HOME=~/.codex/`)
2. `~/.codex/config.toml` 의 `[hooks]` 테이블 (user)
3. `<repo>/.codex/hooks.json` (project-local, trust 필요)
4. `<repo>/.codex/config.toml` 의 `[hooks]` 테이블 (project-local, trust 필요)
5. `/etc/codex/config.toml` 의 `[hooks]` 테이블 (system, root 권한 자산)
6. *(enterprise)* `requirements.toml` / legacy `managed_config.toml` — admin-enforced

**Precedence (binary 문자열 + docs 종합)**: CLI flags > Profile (`--profile`) > Project (closest `.codex/config.toml`) > User (`$CODEX_HOME/config.toml`) > System (`/etc/codex/config.toml`) > Built-in defaults. **enterprise `requirements.toml` 는 이 스택 위에 존재하지만 (사용자 우회 불가), 정확한 layer 순서는 Codex 자체 검증 GAP#13 으로 문서 미확정** — 결정에는 영향 없음 (forgen 1차는 user/project layer 만 사용).

`CODEX_HOME` 으로 user 디렉토리 재배치 가능 — **forgen e2e 격리/CI 에 그대로 활용**. binary 문자열에서도 user config 경로가 `$CODEX_HOME/config.toml` 로 일관 (FIX#14 OK).

### 14.2 forgen 의 매핑 결정

| 자산 | Claude 위치 | Codex 위치 | 결정 사유 |
|---|---|---|---|
| hook 스크립트 (dist/hooks/*.js) | `~/.claude/plugins/cache/forgen-local/forgen/{ver}/dist/hooks/` | 동일 디렉토리 재사용 (path 만 absolute 로 inject) | hook 본체는 host 무관 node 스크립트. *위치만 inject 경로가 다름.* |
| hook 등록 manifest | `~/.claude/plugins/cache/forgen-local/forgen/{ver}/hooks/hooks.json` | `~/.codex/hooks.json` (단일 파일 형식) 또는 `~/.codex/config.toml [hooks]` 머지 | 1차는 `~/.codex/hooks.json` direct write. 사용자가 이미 `[hooks]` 를 쓰고 있으면 보존(머지). |
| skills/ commands/ agents/ | `~/.claude/plugins/cache/forgen-local/forgen/{ver}/{skills,commands,agents}/` | 1차 skip — Codex 에 동등 표면 부재 | Codex 의 prompt 자산 모델은 `AGENTS.md` / `requirements.toml` 중심. forgen 자산 매핑은 Phase 2 InstallPlan 에서. |
| MCP 등록 | Claude `settings.json` mcpServers + `~/.claude.json` | `~/.codex/config.toml` `[mcp_servers]` (Codex 별도 등록) | 양쪽 모두 register, 단일 MCP 서버는 그대로 동작. |
| 자기증거 박제 | `~/.forgen/state/*.json` | 동일 (host 무관) | host 무관 — evidence 파일에 host 필드만 추가. |

### 14.3 자산 배치 결정

- forgen 의 InstallPlan 은 host 별로 **manifest 위치만** 다르게 inject 하고, **hook 스크립트 본체는 동일 디렉토리** 를 가리키게 한다 (이미 `dist/hooks/*.js` 는 host 무관 node).
- Codex `~/.codex/hooks.json` 머지 정책: forgen 이 채울 부분에 `# managed by forgen — do not edit between markers` 주석 블록 + idempotent 재생성 (현재 Claude 측 `hooks.json` 패턴과 동일).
- `CODEX_HOME` 인식: forgen 의 e2e Docker harness 는 `CODEX_HOME=/tmp/codex-e2e` 패턴으로 격리한다 (현재 `FORGEN_HOME` 격리 패턴과 일관).
- enterprise `requirements.toml` 는 1차 미지원. forgen 자체 자산을 admin-enforced 로 강제하지 않는다(사용자 권한 침해).

---

## 15. Stop hook 무한루프 가드 동치성

**결정 (외부 docs 확인)**: Codex Stop hook 의 input 에 `stop_hook_active: boolean` 필드가 존재하며 의미는 Claude 와 **동일** (재진입 시 true). 따라서 현재 forgen `stop-guard` 의 `stop_hook_active` early-return 로직은 host 무관. 별도 마이그레이션 불필요.

---

## 16. PermissionRequest hook — 1차 결정

**결정**: forgen 1차에서 **미사용**.

**근거**:
- Codex hook 시스템에 `PermissionRequest` event 가 존재함은 외부 docs (developers.openai.com/codex/hooks, deepwiki) 로 확인 (Codex self-validation OK).
- "Claude 에 동치 hook 없음" 주장은 Codex 자체 검증으로는 직접 입증되지 않음 (GAP#7). Claude docs 측 별도 확인 필요. 1차 결정에는 영향 없음 — 어느 쪽이든 1원칙 (Claude reference) 의 비대칭 행동을 피하기 위해 미사용 결정 유지.
- approval prompt 는 사용자 경험 영역이며 forgen 의 Trust Layer 의도와 직교.

향후 Phase 4 cross-host 트랙에서 *observe-only signal* 로 재고려 (사용자가 어떤 작업에 confirm 을 망설였는지가 학습 신호가 될 수 있음).

---

## 17. Codex self-validation 결과 (2026-04-27, 0.125.0)

§9.0/§13/§14/§15/§16 의 사실 주장 17건을 Codex CLI 0.125.0 자체에게 검증시킨 결과 (`codex exec -s read-only -c approval_policy="never" --ephemeral`). Codex 가 자신의 binary 문자열을 직접 추출해 답한 결과를 그대로 박제.

### 17.1 OK (사실 부합) — 8/17

| # | 항목 | Codex 근거 |
|---|---|---|
| 1 | SessionStart `additionalContext` inject | `session-start.command.output` 에 `hookSpecificOutput.additionalContext` |
| 2 | UserPromptSubmit `additionalContext` + `decision:"block"` | `user-prompt-submit.command.output` 에 둘 다 정의 |
| 3 | PreToolUse `permissionDecision` (allow/deny/ask) + `permissionDecisionReason` | `pre-tool-use.command.output.hookSpecificOutput` enum 일치 |
| 5 | Stop `decision:"block"` + `reason` 자동 continuation | binary 가 reason 을 continuation prompt 로 처리 |
| 6 | Stop input 의 `stop_hook_active: boolean` | `stop.command.input` required 필드 |
| 9 | sandbox_mode 3종 (read-only/workspace-write/danger-full-access) | CLI help 일치 |
| 14 | `CODEX_HOME` user 디렉토리 재배치 | binary + help 가 `$CODEX_HOME/config.toml` 사용 |
| 15 | project-local `.codex/` trust 필요 | binary 문자열에 "project config is marked as untrusted" |

### 17.2 FIX (정정 적용 완료) — 7/17

| # | 잘못 | 정정 | 적용 위치 |
|---|---|---|---|
| 4 | PostToolUse 가 일반 tool 결과 replace | **MCP tool 한정** (`hookSpecificOutput.updatedMCPToolOutput`). 일반 tool redact 미보장 | §9.0 row 5 |
| 8 | approval_policy 3종 | **4종**: `untrusted` / `on-failure`(deprecated) / `on-request` / `never` | §13.1 |
| 10 | `--full-auto = workspace-write + on-request` 별칭 | 0.125.0 help 표현은 "low-friction sandboxed automatic execution / writable network-disabled sandbox". docs 와 binary help 가 다름 — 둘 다 박제 | §13.1 |
| 11 | `--yolo` 별칭 | 0.125.0 에 `--yolo` 별칭 없음. 실 플래그는 `--dangerously-bypass-approvals-and-sandbox` (승인 + sandbox 둘 다 우회) | §13.1, §13.2, §13.3 |
| 12 | hook 위치 4곳만 | system layer (`/etc/codex/config.toml [hooks]`) 추가, 5+곳 | §14.1 |
| 16 | stdout = JSON or plaintext (event-specific) | stdout 기본은 event 별 JSON. plaintext 가 *일반 stdout 대체경로* 가 아님. plaintext 입력 ≠ plaintext 출력 | §9.0 부속 |
| 17 | exit code 2 + stderr = blocking decision (alternative) | exit2 의 의미가 event 별로 다름. 단일 blocking 규약 아님 | §9.0 부속 |

### 17.3 GAP (입증 미정) — 2/17

| # | 항목 | 메모 |
|---|---|---|
| 7 | "Claude 에 동치 PermissionRequest hook 없음" | Codex 자료만으론 직접 입증 불가. 1차 결정 (미사용) 에 영향 없음 — §16 에 명시 박제 |
| 13 | precedence 6단계 단정 | `requirements.toml` / legacy `managed_config.toml` 같은 추가 layer 가 binary 에 보임. exact precedence 단정은 보류 — forgen 1차는 user/project layer 만 사용하므로 결정 영향 없음 — §14.1 에 박제 |

### 17.4 결론

- **schema 정합성 (1~6, 8~9, 14~15)**: 외부 docs 와 Codex 자체 binary 가 *대부분 일치*. forgen 1원칙(Claude canonical reference) 의 projection 이 타당함이 self-validation 으로도 확인됨.
- **표면 정정 7건**: spec 결정의 *방향* 은 영향 없음. 표기/범위만 정정. 모두 본 갱신에 반영.
- **GAP 2건**: 1차 결정에 영향 없음으로 박제.
- **결과**: 1원칙 + Phase 1 산출물 (capability matrix, 권한 모델, 자산 배치, parity test) 은 *그대로 진행 가능*.

---

## 18. Source-level verification (2026-04-27, openai/codex Apache-2.0)

§17 의 self-validation 을 보강하기 위해 Codex 의 *오픈소스 자체* 에서 hook schema 12 종 (input/output × 6 events) 과 권한/CLI 정의를 직접 추출. Apache-2.0 코드라 인용 가능.

### 18.1 결정적 1원칙 증거 — Codex 가 Claude 를 reference 로 명시

`codex-rs/hooks/schema/generated/stop.command.output.schema.json` 의 `reason` 필드 description (생성된 schema 에 그대로 박힘):

> "Claude requires `reason` when `decision` is `block`; we enforce that semantic rule during output parsing rather than in the JSON schema."

즉 **Codex hook 시스템은 자체 schema 에서 Claude 를 reference 로 직접 호출**하고 있다. forgen 1원칙(Claude canonical reference)은 우리만의 가정이 아니라 *Codex 측에서도 명시적으로 채택된 설계 방침*. 이는 §2.0 의 비대칭 의존을 외부 증거로 강화.

추가 증거: 모든 hook input schema 의 `permission_mode` enum 이 **Claude 명명** 그대로 — `["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"]`. 출처: `codex-rs/hooks/schema/generated/{session-start,user-prompt-submit,pre-tool-use,post-tool-use,stop,permission-request}.command.input.schema.json` (6 파일 모두 동일 enum).

### 18.2 Hook schema 정합 — 7 fact 모두 source 확정

| spec fact | 증거 (codex-rs/hooks/schema/generated/) |
|---|---|
| 1. SessionStart `hookSpecificOutput.additionalContext: string` | session-start.command.output.schema.json#SessionStartHookSpecificOutputWire |
| 2. UserPromptSubmit `decision:"block"` + `hookSpecificOutput.additionalContext` | user-prompt-submit.command.output.schema.json#BlockDecisionWire + UserPromptSubmitHookSpecificOutputWire |
| 3. PreToolUse `hookSpecificOutput.permissionDecision` enum `["allow","deny","ask"]` + `permissionDecisionReason` | pre-tool-use.command.output.schema.json#PreToolUsePermissionDecisionWire + PreToolUseHookSpecificOutputWire. **추가 발견**: top-level `decision` 필드도 별도로 존재 (`["approve","block"]`) — 어댑터는 hookSpecificOutput.permissionDecision 을 사용해야 함 |
| 4. PostToolUse 일반 redact 미보장, MCP 한정 `updatedMCPToolOutput` | post-tool-use.command.output.schema.json#PostToolUseHookSpecificOutputWire — `updatedMCPToolOutput` 만 정의, 일반 tool output replace 필드 부재 ✓ FIX#4 정정 옳음 |
| 5. Stop `decision:"block"` + `reason` | stop.command.output.schema.json + 위 §18.1 description |
| 6. Stop input `stop_hook_active: boolean` (REQUIRED) | stop.command.input.schema.json `required` 배열에 `stop_hook_active` 포함 ✓ |
| 7. PermissionRequest 가 별도 hook | permission-request.command.{input,output}.schema.json 별도 파일 + `behavior: "allow"\|"deny"` enum. forgen 1차 미사용 결정 유지 |

### 18.3 권한 모델 — source 정정 (FIX#8 추가 정정)

`codex-rs/app-server-protocol/schema/typescript/v2/AskForApproval.ts`:

```ts
export type AskForApproval = "untrusted" | "on-failure" | "on-request" | { "granular": { sandbox_approval: boolean, rules: boolean, skill_approval: boolean, request_permissions: boolean, mcp_elicitations: boolean, } } | "never";
```

→ **5 값** (4 단순 string + 1 granular object). Codex self-validation 의 "4 값" 도 부정확. spec §13.1 을 5 값 (granular 포함) 으로 정정 필요.

`codex-rs/utils/cli/src/shared_options.rs`:
- `--full-auto`: comment "Convenience alias for low-friction sandboxed automatic execution"
- `--dangerously-bypass-approvals-and-sandbox`: `conflicts_with = "full_auto"`

`codex-rs/cli/src/main.rs` 에서의 resolve 로직:
```rust
let approval_policy = if shared.full_auto { Some(AskForApproval::OnRequest) }
                      else if shared.dangerously_bypass_approvals_and_sandbox { Some(AskForApproval::Never) }
                      else { interactive.approval_policy.map(Into::into) };
let sandbox_mode = if shared.full_auto { Some(SandboxMode::WorkspaceWrite) }
                   else if shared.dangerously_bypass_approvals_and_sandbox { Some(SandboxMode::DangerFullAccess) }
                   else { ... };
```

→ **`--full-auto` ⟺ OnRequest + WorkspaceWrite** (docs 표현 정확). Codex self-validation FIX#10 의 binary help 문구 정확성 지적은 맞지만, 실 동작은 spec/docs 와 일치. 결론: spec §13.1 의 docs 표현 유지, binary help 의 모호한 wording 은 박제만.

### 18.4 hooks.json 호환성 — *결정적 발견*

`codex-rs/config/src/hook_config.rs` 의 `HooksFile` 정의:

```rust
pub struct HooksFile { pub hooks: HookEventsToml }
pub struct HookEventsToml { 
    pub pre_tool_use: Vec<MatcherGroup>, 
    pub permission_request: Vec<MatcherGroup>, 
    pub post_tool_use: Vec<MatcherGroup>, 
    pub session_start: Vec<MatcherGroup>, 
    pub user_prompt_submit: Vec<MatcherGroup>, 
    pub stop: Vec<MatcherGroup> 
}
pub struct MatcherGroup { pub matcher: Option<String>, pub hooks: Vec<HookHandlerConfig> }
pub enum HookHandlerConfig { Command { command, timeout, async, statusMessage }, Prompt {}, Agent {} }
```

→ **forgen 의 현재 `hooks/hooks.json` 형식이 Codex `~/.codex/hooks.json` schema 와 *완전 동일***. 1차 InstallPlan 에서 *동일 파일을 양쪽에 그대로 복사* 하면 schema 검증 통과.

### 18.5 Hook 실행 환경 — 새 발견 (Phase 2 InstallPlan 영향)

`codex-rs/hooks/src/engine/command_runner.rs`:

```rust
fn default_shell_command() -> Command {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut command = Command::new(shell);
    command.arg("-lc");  // 또는 Windows: COMSPEC + "/C"
    command
}
```

→ Codex 는 hook 명령을 `$SHELL -lc "<command>"` 로 실행. **`${CLAUDE_PLUGIN_ROOT}` 같은 Claude 전용 env var 는 Codex 측에서 자동 설정되지 않음.**

forgen 의 현재 `hooks.json` 이 `${CLAUDE_PLUGIN_ROOT}/dist/hooks/foo.js` 형태이므로, Codex 등록 시 다음 중 하나 필요:

1. **InstallPlan 에서 절대경로로 pre-expand**: `${CLAUDE_PLUGIN_ROOT}` → `/Users/.../forgen/dist/hooks/foo.js`. (가장 단순)
2. **forgen 자체 env var 도입**: `FORGEN_HOOKS_DIR=...` 를 양쪽 hosts.json 에 사용 + 사용자 shell 에 export 책임 위임. (config 의존성 증가)
3. **wrapper script 도입**: forgen 이 `forgen-hook-runner foo` 같은 단일 진입점 제공, 내부에서 path resolve. (런타임 layer 추가)

**1차 결정**: 옵션 1 (InstallPlan 에서 절대경로 pre-expand). 이유: Phase 1 산출물 부피 최소화, 추가 환경 변수 의존성 0, 디버깅 단순.

### 18.6 새로 드러난 finding (spec 영향)

- **§14.2 의 "hook 스크립트 본체는 host 무관 dir 재사용" 결정 강화**: schema 가 동일하므로 하나의 디렉토리를 양쪽에서 가리킴 + 절대경로 inject. 이 결정이 source 로 검증됨.
- **Stop input `last_assistant_message: NullableString` (REQUIRED)**: forgen 의 `stop-guard` 가 transcript 파싱 없이 직접 사용 가능. Phase 2 hook 마이그레이션 시 활용. (Claude 도 동치 필드 제공)
- **PreToolUse output 의 *이중* decision 필드** (top-level `decision: approve|block` + `hookSpecificOutput.permissionDecision: allow|deny|ask`): 어댑터/forgen 측은 항상 `hookSpecificOutput.permissionDecision` 사용. 현재 `src/host/codex-adapter.ts` 의 normalizeOutput 이 이미 후자 패턴이므로 회귀 없음.

### 18.7 출처

- `https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated/` — 12 hook schemas
- `https://github.com/openai/codex/blob/main/codex-rs/config/src/hook_config.rs` — HooksFile struct
- `https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/command_runner.rs` — shell wrapping
- `https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/AskForApproval.ts` — 5 approval values
- `https://github.com/openai/codex/blob/main/codex-rs/utils/cli/src/shared_options.rs` — full-auto / bypass flags
- `https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs` — flag → policy resolution

### 18.8 최종 결론

- **schema-level 1~7 모두 source 확정**. PostToolUse redact 범위 정정 외 잘못된 가정 없음.
- **hooks.json schema 동일성**: forgen 의 현재 manifest 가 Codex 와 schema-compatible. 1차 InstallPlan 에서 직접 복사 가능.
- **Hook 실행 환경**: `${CLAUDE_PLUGIN_ROOT}` 미설정 — InstallPlan 에서 절대경로로 pre-expand (옵션 1) 채택.
- **권한 모델**: `AskForApproval` 5 값 (granular 포함) 으로 §13.1 갱신. forgen default `--full-auto` 결정 유지.
- **다음 작업 진입 가능**: §10 우선순위 1 (`TrustLayerIntent` enum + `HostCapabilities`) 이 더 이상 차단 요인 없음.

