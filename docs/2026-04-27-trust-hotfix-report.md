# Forgen 신뢰 핫픽스 진단서

> 작성일: 2026-04-27
> 목적: 사용자 신뢰를 깨는 실제 오작동과 주장-현실 불일치를 제거하기 위한 내부용 핫픽스 기준 문서

## 이 문서의 기준

- 이 문서는 "아키텍처를 더 예쁘게 만드는 것"보다 "사용자가 기대한 동작과 실제 동작이 어긋나는 지점"을 우선한다.
- 범위는 설치, 온보딩, 에이전트/스킬 노출 계약, 훅 산출물, 릴리스 검증 신뢰성이다.
- 범위 밖은 `solution-matcher`, `compound-extractor`, `stop-guard` 같은 대형 파일의 구조적 리팩토링이다. 이들은 문제지만 지금 당장 사용자 신뢰를 가장 먼저 깨는 종류는 아니다.
- 2026-04-27 현재 워크트리는 더티 상태다. 일부 훅 관련 문제는 작업 중 수정이 섞여 있다. 따라서 아래 항목은 `커밋된 기준선`, `현재 워크트리`, `구조적 재발 위험`을 구분해서 읽어야 한다.

## 관찰 스냅샷

- `npm test` 전체 실행은 2026-04-27 11:19경 `tests/hooks-generator.test.ts`, `tests/plugin-coexistence.test.ts` 2건 실패를 보고했다.
- 같은 세션에서 개별 재실행한 `npm test -- tests/hooks-generator.test.ts`, `npm test -- tests/plugin-coexistence.test.ts` 는 통과했다.
- 해석: 훅 계약 드리프트는 실제로 발생했고, 현재 워크트리에서 부분 수정이 진행 중이다. "재현 안 됨"이 아니라 "고쳐지는 중"에 가깝다.

## 전체 약점 맵

| ID | 약점 | 심각도 | 왜 신뢰를 깨는가 | 현재 판단 |
|----|------|--------|------------------|-----------|
| W1 | 한국어 README 설치 명령 오타 | Critical | 복붙 설치가 바로 실패한다 | 활성, 미해결 |
| W2 | 온보딩 계약 드리프트 (2문항 vs 4문항) | Critical | CLI 도움말과 실제 동작이 다르다 | 활성, 미해결 |
| W3 | 에이전트 인벤토리 드리프트 (12 vs 13) | High | 문서와 패키지/검증 스크립트가 다른 제품을 설명한다 | 활성, 미해결 |
| W4 | 환경 의존적 훅 산출물 생성 | Critical | 개발자 머신 환경에 따라 배포 훅이 달라질 수 있다 | 구조적 위험, 부분 완화 중 |
| W5 | 비결정적 검증 + 하드코딩된 개수 계약 | High | 드리프트를 늦게 잡거나 잘못된 안전 신호를 준다 | 활성, 미해결 |
| W6 | 대형 휴리스틱 핫패스 집중 (`solution-matcher`, `compound-extractor`, `stop-guard`) | Medium | 유지보수와 회귀 가능성이 높다 | 핫픽스 대상 아님 |
| W7 | 공개 계약 파일이 여러 곳에 중복됨 (README/help/tests/scripts/json) | Medium | 한 곳 수정 후 다른 곳이 쉽게 stale 된다 | 핫픽스와 함께 줄여야 함 |

## 우선순위

1. W1 한국어 README 설치 명령 오타
2. W2 온보딩 계약 드리프트
3. W4 환경 의존적 훅 산출물 생성
4. W3 에이전트 인벤토리 드리프트
5. W5 비결정적 검증 + 하드코딩된 개수 계약

---

## Hotfix 1. 한국어 README 설치 명령 오타

### 무엇이 깨졌는가

한국어 README가 설치 명령을 `npm install -g /forgen` 으로 안내한다. 이 명령은 패키지 이름이 아니라 잘못된 경로 형태다.

### 증거

- `README.ko.md:85-88`
- `README.ko.md:145-149`
- 비교 기준으로 영문 README는 `README.md:127-129`, `README.md:187-191` 에서 `npm install -g @wooojin/forgen` 을 사용한다.

### 사용자 영향

- 한국어 사용자는 가장 첫 단계에서 복붙 설치가 실패한다.
- 이 단계에서 실패하면 이후 온보딩, 훅, compound 같은 핵심 가치를 체험하기 전에 신뢰를 잃는다.
- README의 가장 기본 명령이 틀렸다는 사실 자체가 "나머지 설명도 믿기 어렵다"는 신호가 된다.

### 주장-현실 불일치

- 제품은 다국어 README를 제공한다고 주장하지만, 적어도 한국어 README는 설치 계약을 깨고 있다.

### 권장 핫픽스 범위

- `README.ko.md` 의 두 설치 명령을 모두 `npm install -g @wooojin/forgen` 으로 수정한다.
- 모든 로케일 README에서 install command를 grep으로 다시 확인한다.
- 가능하면 README install command를 검증하는 아주 작은 계약 테스트나 스크립트를 추가한다.

### Claude 작업 프롬프트

```text
Fix the broken install commands in README.ko.md.

Requirements:
- Replace every `npm install -g /forgen` with `npm install -g @wooojin/forgen`.
- Search README.md, README.ko.md, README.ja.md, README.zh.md for all install commands and confirm they are consistent.
- If there is no regression check for this, add a lightweight test or script that fails when a localized README uses a different install command than the English README.
- Do not make unrelated README edits.
```

### 완료 판정 질문

- 한국어 README 사용자가 첫 설치 명령을 그대로 복붙했을 때 성공하는가?
- 모든 로케일 README의 install command가 같은 패키지명을 가리키는가?

---

## Hotfix 2. 온보딩 계약 드리프트

### 무엇이 깨졌는가

실제 온보딩은 4문항인데, CLI 설명과 도움말은 여전히 2문항이라고 말한다. 내부 주석도 일부는 2문항 기준으로 남아 있다.

### 증거

- 실제 4문항 온보딩:
  - `README.md:132-147`
  - `README.md:190-191`
  - `README.ko.md:90-105`
  - `README.ko.md:148-149`
  - `src/forge/onboarding-cli.ts:69-75`
- 여전히 2문항이라고 말하는 사용자 노출 문자열:
  - `src/cli.ts:163-167`
  - `src/cli.ts:467-470`
- 내부 구현 코멘트도 stale:
  - `src/forge/onboarding.ts:1-5`

### 사용자 영향

- 사용자는 `forgen onboarding` 도움말을 보고 2문항만 예상하지만 실제로는 4문항을 받는다.
- 문서/도움말/실행 결과가 서로 다르면 "프로필 계산이 어디까지 반영되는지"를 믿기 어려워진다.
- 온보딩이 제품 개인화의 시작점인 만큼, 여기서 계약이 흐리면 이후 모든 personalization 주장도 약해진다.

### 주장-현실 불일치

- README는 4문항 온보딩을 설명한다.
- CLI는 같은 기능을 2문항으로 소개한다.
- 코드 주석도 2문항/4문항이 혼재한다.

### 권장 핫픽스 범위

- 사용자에게 보이는 설명 문자열을 전부 4문항 기준으로 통일한다.
- 내부 stale 주석도 같이 정리한다. 주석을 핫픽스 범위 밖이라고 보면 이 문제가 반복된다.
- 온보딩 문항 수를 단일 소스에서 읽는 계약 테스트를 추가한다. 예를 들어 help text, README, onboarding CLI가 같은 기준을 따르는지 점검한다.

### Claude 작업 프롬프트

```text
Fix the onboarding contract drift.

Requirements:
- Align all user-visible onboarding descriptions to the actual 4-question flow.
- Update stale CLI descriptions/help text that still say "2-question onboarding".
- Update stale code comments that still describe onboarding as 2 questions.
- Add a regression check so future changes cannot leave CLI/help/docs saying 2 questions while the runtime asks 4.
- Keep the actual onboarding behavior unchanged unless you find a real behavioral bug.
```

### 완료 판정 질문

- `forgen --help` 와 `forgen onboarding` 설명이 모두 4문항 기준인가?
- README와 실제 `runOnboarding()` 흐름이 같은 문항 수를 설명하는가?

---

## Hotfix 3. 환경 의존적 훅 산출물 생성

### 무엇이 깨졌는가

체크인 가능한 `hooks/hooks.json` 생성 로직이 개발자 머신의 플러그인 상태에 영향을 받는다. 즉, 로컬에 다른 플러그인이 있으면 workflow 훅이 빠진 산출물을 커밋할 수 있다.

### 증거

- 훅 생성 시 실제 환경의 플러그인 감지 결과를 읽는다:
  - `src/hooks/hooks-generator.ts:84-107`
- 플러그인 감지는 실제 `~/.claude/plugins` 와 로컬 시그니처를 본다:
  - `src/core/plugin-detector.ts:7-15`
  - `src/core/plugin-detector.ts:55-65`
  - `src/core/plugin-detector.ts:141-158`
- 회귀 테스트 주석 자체가 과거 shipping incident를 문서화한다:
  - `tests/hooks-generator.test.ts:144-156`
- 빠지면 실제로 깨지는 사용자 계약:
  - `src/hooks/keyword-detector.ts:87-94`
  - `tests/keyword-patterns.test.ts:78-89`

### 사용자 영향

- `intent-classifier`, `keyword-detector` 같은 workflow 훅이 배포 산출물에서 누락되면, 키워드 기반 스킬 활성화가 조용히 사라질 수 있다.
- 사용자는 README에서 본 `"code review"`, `"forge-loop"` 같은 진입 경로를 기대하지만 실제 런타임은 반응하지 않을 수 있다.
- 더 나쁜 점은 이 문제가 "특정 개발자 머신에서 생성한 패키지"에만 생길 수 있어 재현성이 낮다는 것이다.

### 주장-현실 불일치

- 제품은 "다른 플러그인과 공존하면서도 핵심 흐름은 유지된다"고 말한다.
- 하지만 릴리스 산출물 생성 자체가 다른 플러그인 존재에 오염될 수 있으면, 공존 로직이 런타임이 아니라 배포물에까지 새겨진다.

### 권장 핫픽스 범위

- `runtime hooks generation` 과 `checked-in release artifact generation` 을 분리한다.
- 배포용 훅 스냅샷은 clean env 기준으로만 생성되게 하거나, 더 강하게는 아예 환경 독립적으로 생성한다.
- 로컬 공존 로직은 런타임에서만 적용되게 한다.
- 릴리스 직전 `hooks/hooks.json` 이 모든 훅을 포함하는지 검증하는 명시적 스텝을 둔다.

### Claude 작업 프롬프트

```text
Fix the release-artifact drift in hooks generation.

Requirements:
- Prevent checked-in/package hooks artifacts from depending on the developer's local plugin environment.
- Keep runtime coexistence behavior, but make release artifact generation deterministic.
- Add or update tests so a machine with `.omc` or other known plugin signatures cannot accidentally produce a crippled checked-in `hooks/hooks.json`.
- Verify that workflow hooks such as `intent-classifier` and `keyword-detector` remain present in the release artifact.
- Do not remove coexistence behavior from runtime unless necessary; separate release-time and runtime concerns.
```

### 완료 판정 질문

- `.omc` 가 있는 머신과 없는 머신에서 배포용 `hooks/hooks.json` 생성 결과가 같은가?
- release artifact 기준으로 `intent-classifier`, `keyword-detector`, `forge-loop-progress` 가 모두 존재하는가?

---

## Hotfix 4. 에이전트 인벤토리 드리프트

### 무엇이 깨졌는가

README는 12 built-in agents 라고 설명하지만, 패키지 검증 스크립트와 실제 `agents/` 디렉토리는 13개를 기준으로 움직인다. `ch-solution-evolver` 가 공개 계약에 포함되는지 아닌지가 불명확하다.

### 증거

- README 주장:
  - `README.md:381-410`
- 실제 추가 에이전트 파일:
  - `agents/solution-evolver.md:1-19`
- 패키지 검증 스크립트는 13개를 기대:
  - `tests/e2e/docker/verify-v3.sh:39-41`

### 사용자 영향

- 사용자는 "12 built-in agents" 라는 문구를 믿고 문서를 읽지만, 실제 패키지는 다른 인벤토리를 제공한다.
- 내부적으로도 어떤 에이전트가 public surface 인지 불분명해진다.
- 나중에 agent docs, install, uninstall, release notes가 계속 엇갈릴 가능성이 높다.

### 주장-현실 불일치

- README는 12개라고 설명한다.
- 패키지 검증은 13개라고 본다.
- 실제 디스크에도 13번째 에이전트 파일이 있다.

### 권장 핫픽스 범위

- `ch-solution-evolver` 를 public built-in agent로 인정할지, 내부/실험용으로 숨길지 먼저 결정한다.
- 결정 후 README, 검증 스크립트, 설치/언인스톨 계약을 한 값으로 맞춘다.
- 향후 개수 하드코딩 대신 manifest 기반 검증으로 바꾼다.

### Claude 작업 프롬프트

```text
Fix the built-in agent inventory drift.

Requirements:
- Decide whether `ch-solution-evolver` is part of the public built-in agent surface.
- Align README, package verification scripts, and any install/uninstall expectations to that single decision.
- Remove hardcoded conflicting counts where possible and replace them with a single source of truth.
- Do not silently change runtime behavior without also changing the public docs.
```

### 완료 판정 질문

- README, package verification, and installed agent inventory all agree on the same count?
- `ch-solution-evolver` 의 공개 여부가 문서와 검증에 같은 의미로 반영되었는가?

---

## Hotfix 5. 비결정적 검증과 하드코딩된 계약 개수

### 무엇이 깨졌는가

검증 코드 일부가 실제 homedir 환경에 의존하고, 일부는 개수를 하드코딩한다. 이런 구조에서는 드리프트가 조용히 누적되다가 늦게 터지거나, 반대로 특정 개발자 환경에서만 실패한다.

### 증거

- 테스트가 실제 homedir 플러그인 상태를 읽는다고 스스로 밝힌다:
  - `tests/plugin-coexistence.test.ts:2-9`
- 같은 테스트가 훅 개수를 하드코딩했다가 이번 세션에서 20 -> 21로 수정 중이다:
  - `tests/plugin-coexistence.test.ts:84-93`
- `tests/hooks-generator.test.ts` 주석/문구도 `19/19` 라는 과거 수치를 계속 언급한다:
  - `tests/hooks-generator.test.ts:153-170`

### 사용자 영향

- 내부 검증이 불안정하면 잘못된 패키지가 통과하거나, 반대로 정상 패키지가 환경 때문에 실패한다.
- 이 문제는 최종 사용자 버그라기보다 "버그를 잡지 못한 채 배포하게 만드는 버그"다.

### 주장-현실 불일치

- "single source of truth" 라고 말하지만, 실제 계약 수치는 README, tests, e2e shell script, json, help text에 중복 저장되어 있다.

### 권장 핫픽스 범위

- pure contract test 와 environment smoke test 를 분리한다.
- 계약 개수는 단일 manifest 또는 단일 source file 에서 읽게 바꾼다.
- 실제 homedir 를 읽는 테스트는 opt-in smoke test 로 격리한다.
- help/README/manifest/json 간 일관성 검증을 자동화한다.

### Claude 작업 프롬프트

```text
Make the trust-surface verification hermetic.

Requirements:
- Separate deterministic contract tests from real-environment smoke tests.
- Remove hardcoded counts where a single source of truth can be read instead.
- Keep one explicit smoke/integration path if needed, but it must not be the primary contract check.
- Add a regression check that compares public contract surfaces such as README/help/inventory counts against the chosen source of truth.
```

### 완료 판정 질문

- 주요 계약 테스트가 실제 homedir 상태 없이도 CI에서 안정적으로 통과하는가?
- 개수 변경 시 한 곳만 고치면 나머지 계약 검증도 자동으로 따라오는가?

---

## 지금 당장 건드리지 말 것

아래는 문제지만, 이번 문서의 "신뢰 회복용 핫픽스" 범위는 아니다.

- `src/engine/solution-matcher.ts` 의 대형화
- `src/engine/compound-extractor.ts` 의 대형화
- `src/hooks/stop-guard.ts` 의 책임 집중
- compound 성능/정확도 튜닝
- dashboard, 비용/토큰 추적, 장기적인 learning metrics

이 항목들은 핫픽스와 같이 잡기 시작하면 범위가 바로 커진다. 지금은 계약 불일치 제거가 먼저다.

## Claude에 넘길 때의 권장 순서

1. `README.ko.md` 설치 명령 수정
2. 온보딩 2문항/4문항 계약 통일
3. 훅 release artifact 생성 결정론화
4. 에이전트 인벤토리 공개 계약 정리
5. 계약 테스트/스모크 테스트 분리

## 최종 판정 기준

아래 질문에 모두 "예"라고 답할 수 있어야 이번 라운드 핫픽스를 끝냈다고 볼 수 있다.

- 한국어 사용자가 README만 보고 설치를 성공할 수 있는가?
- `forgen --help`, README, 실제 온보딩 흐름이 같은 제품을 설명하는가?
- built-in agent 개수와 공개 범위가 README, 패키지, 검증 스크립트에서 일치하는가?
- 개발자 머신에 다른 Claude 플러그인이 설치되어 있어도 배포 훅 산출물이 오염되지 않는가?
- CI가 실제 홈 디렉토리 상태 없이도 공개 계약 드리프트를 안정적으로 잡아내는가?
