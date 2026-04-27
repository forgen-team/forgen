# Forgen Multi-Host Core Design

> 작성일: 2026-04-27
> 목적: `forgen`을 Claude 전용 하네스에서 `Claude + Codex`를 공식 지원하는 다중 호스트 하네스로 확장하기 위한 제품/아키텍처 설계

---

## Executive Summary

`forgen`은 계속 하나의 제품으로 남는다. 사용자는 여전히 `forgen` 하나를 설치하고 실행하지만, 내부 구조는 `shared core + host adapters`로 재편한다. 공통 코어는 사용자 프로필, compound 학습, rule lifecycle, 공용 MCP와 같은 장기 지식과 판단 체계를 책임진다. 호스트 어댑터는 Claude/Codex 각각의 설치 경로, 훅 스키마, 권한 체계, 세션 기록 수집, 실행 런처를 책임진다.

사용자 메모리는 호스트별로 분리하지 않는다. 프로필, 공용 규칙, 축적된 솔루션은 하나의 `forgen` 기억으로 유지한다. 대신 실행 증거와 세션 로그에는 `host` 태그를 붙여 어느 호스트에서 나온 신호인지 보존한다. 이 구조는 사용자의 판단 철학을 유지하면서도 호스트별 특이성과 노이즈를 분리할 수 있게 한다.

교차 호스트 협업은 1급 기능으로 설계한다. 기본 모드는 한 호스트가 주 에이전트로 작업하고 필요할 때만 다른 호스트를 `consult`, `review`, `verify`, `execute` 역할로 호출하는 방식이다. 병렬 `dual-run`은 기본값이 아니라 난도가 높고 병렬 이득이 명확한 상황에서만 승격 모드로 사용한다.

---

## 1. 목표와 비목표

### 목표

- `forgen` 하나의 제품 경험을 유지하면서 Claude와 Codex를 둘 다 공식 지원한다.
- 장기 사용자 메모리와 판단 철학을 두 호스트가 공통으로 사용한다.
- 현재의 임시 `runtime === 'codex'` 분기 구조를 `host contract` 기반 구조로 치환한다.
- Claude와 Codex가 필요할 때 서로를 호출해 더 나은 결과를 낼 수 있는 오케스트레이션 기반을 만든다.
- 외부 UX를 급격히 바꾸지 않고, 내부 구조부터 패키지 분리 가능한 상태로 재편한다.

### 비목표

- 첫 릴리스에서 Gemini 등 제3의 호스트까지 지원하지 않는다.
- 처음부터 npm 패키지를 `forgen-core`, `forgen-claude`, `forgen-codex`로 분리 배포하지 않는다.
- 기본 모드를 항상 병렬 다중 호스트 실행으로 만들지 않는다.
- 다중 호스트 자유 대화방이나 무제한 모델 합성 기능을 1차 범위에 넣지 않는다.

---

## 2. 결정 사항

### 2.1 제품 경계

- 외부 제품은 계속 `forgen` 하나로 유지한다.
- 내부 구조는 `shared core + host adapters + umbrella CLI`로 분리한다.
- 초기 배포는 단일 패키지를 유지하고, 실제 패키지 분리는 구조 안정화 이후 단계적으로 검토한다.

### 2.2 메모리 전략

- 사용자 프로필, 공용 규칙, 축적된 솔루션은 하나의 공용 메모리로 유지한다.
- 실행 증거, 세션 메타데이터, 호스트별 판정 흔적은 `host-tagged evidence`로 저장한다.
- 검색은 공용 인덱스를 사용하되, 현재 호스트와 같은 provenance에 약한 가중치를 준다.

### 2.3 협업 전략

- 기본 모드는 `single driver host`다.
- 다른 호스트 호출은 필요할 때만 수행한다.
- 병렬 협업은 `dual-run` 승격 모드로 제한한다.

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

### 3.2 Shared Core

공용 코어는 호스트 중립 계층이다.

- Profile, preset, trust policy
- Rule model, lifecycle, enforcement intent
- Compound extraction, solution index, promotion/demotion
- Shared MCP and retrieval domain
- Session domain, evidence domain, analytics
- Cross-host orchestration policy

이 계층은 `.claude/`, `.codex/`, 특정 훅 JSON 스키마, 실행 파일명, 개별 CLI 옵션을 몰라야 한다.

### 3.3 Host Adapters

각 어댑터는 해당 호스트에 붙는 법만 책임진다.

- 환경 감지와 설치 위치 계산
- settings/hooks/commands/agents 자산 주입
- 런타임 실행
- 호스트 이벤트를 공통 이벤트로 정규화
- 세션 산출물을 공통 세션 레코드로 변환
- peer host 호출을 위한 입출력 직렬화

초기 대상 어댑터:

- `host-claude`
- `host-codex`

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
- 규칙 lifecycle에는 `by_host` 통계 관점을 추가한다.
- 솔루션 검색은 공용 검색을 기본으로 하되, 현재 호스트에서 검증된 결과에 가벼운 우선순위를 준다.
- 호스트별 위반률 차이는 규칙 복제가 아니라 evidence 해석과 threshold 튜닝으로 다룬다.

핵심 원칙은 `판단 철학은 하나, 실행 증거는 host-tagged`다.

---

## 5. Core와 Adapter 인터페이스 계약

폴더 분리보다 중요한 것은 양쪽이 서로 무엇을 몰라야 하는지 명확히 하는 것이다.

### 5.1 Core가 제공하는 계약

코어는 다음 계약을 제공한다.

- `PolicyBundle`
  - 이번 세션에 필요한 규칙, 가드, 프롬프트 조각, 권한 의도
- `CrossHostTask`
  - peer host에게 전달할 구조화된 작업 brief
- `MergePolicy`
  - peer verdict를 어떻게 합성할지에 대한 정책
- `SessionLearningInput`
  - 세션 종료 후 학습에 필요한 공통 이벤트 집합

### 5.2 Adapter가 제공하는 계약

어댑터는 다음 계약을 제공한다.

- `HostCapabilities`
  - 지원 이벤트, block/ask/allow 표현 가능 여부, 설치 가능한 자산 종류
- `InstallPlan`
  - settings/hooks/commands/agents를 어디에 어떤 형식으로 설치할지
- `LaunchPlan`
  - 어떤 런처와 인자로 세션을 시작할지
- `NormalizedEvent`
  - 호스트 이벤트를 공통 스키마로 정규화한 결과
- `SessionRecord`
  - transcript/tool/hook 결과를 코어가 학습 가능한 형태로 요약한 결과

### 5.3 경계 규칙

- core는 `hosts/*`를 import하지 않는다.
- adapter는 profile scoring, lifecycle transition, solution promotion 로직을 구현하지 않는다.
- adapter는 host-native artifact를 다루고, core는 host-neutral domain object만 다룬다.

---

## 6. Claude ↔ Codex 상호 호출 모델

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

### Phase 1: Host Contract 정리

- core와 adapter 인터페이스 도입
- 기존 `runtime === 'codex'` 분기를 계약 기반 구조로 밀어냄
- Claude 전용 자산과 로직의 경계를 명확히 함

### Phase 2: Codex 단독 공식 지원

- 공용 메모리와 host-tagged evidence 위에서 Codex 단독 실행 안정화
- Codex settings/hook/session normalization 정식화
- Claude와 동일한 수준의 profile/rule/compound 흐름 연결

### Phase 3: 교차 호스트 호출

- `consult/review/verify/execute` 호출 도입
- 구조화된 cross-host brief/verdict 도입
- 기본 single-driver + 선택적 dual-run 모델 적용

이 순서를 바꾸지 않는다. Codex 단독 실행이 안정화되기 전에 교차 호스트 협업을 먼저 열면 디버깅 표면이 과도하게 커진다.

---

## 9. 성공 기준

### 기술 성공 기준

- Claude와 Codex가 같은 사용자 메모리를 공유한다.
- evidence와 세션 메타는 host-tagged로 기록된다.
- core가 host-specific 경로와 스키마를 직접 알지 않는다.
- peer host 호출 결과가 구조화된 verdict로 돌아온다.
- 새 호스트 추가 시 core 수정량이 제한적이다.

### 제품 성공 기준

- 사용자는 `forgen` 하나로 설치하고 사용할 수 있다.
- 어느 호스트를 쓰더라도 판단 철학과 축적 지식이 이어진다.
- 기본 모드에서 비용과 지연이 불필요하게 커지지 않는다.
- 필요한 순간에는 다른 호스트를 전략적으로 불러 품질을 높일 수 있다.

### 실패 기준

- 사실상 호스트별 메모리가 분리된다.
- cross-host 호출이 구조화 계약 없이 긴 텍스트 복붙 수준에 머문다.
- 기본 사용 흐름에서 peer 호출이 너무 자주 일어나 비용과 복잡도가 폭증한다.
- core와 adapter 경계가 약해 다시 런타임 분기 덩어리로 회귀한다.

---

## 10. 구현 우선순위

1. core/adapter 계약 정의와 타입 도입
2. Claude 전용 로직과 자산 분리
3. Codex adapter를 같은 계약 위로 재구성
4. host-tagged evidence와 retrieval bias 도입
5. cross-host `consult/review/verify/execute` 흐름 도입
6. 제한적 `dual-run` 승격 모드 도입

우선순위 1~4가 완료되기 전에는 `dual-run`을 열지 않는다.

---

## 11. 설계 원칙 요약

- 제품은 하나, 내부 구조는 하나가 아니다.
- 메모리는 하나, 증거는 host-tagged다.
- 기본은 single driver, 병렬은 승격 모드다.
- core는 판단을 알고, adapter는 연결 방법만 안다.
- 패키지 분리는 목표가 아니라, 분리 가능한 구조가 목표다.

