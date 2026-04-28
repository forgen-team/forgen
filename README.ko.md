<p align="center">
  <img src="https://raw.githubusercontent.com/wooo-jin/forgen/main/assets/banner.png" alt="Forgen" width="100%"/>
</p>

<p align="center">
  <strong>Claude Code 개인화 하네스.</strong><br/>
  <strong>쓸수록 나를 더 잘 아는 Claude.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package//forgen"><img src="https://img.shields.io/npm/v//forgen.svg" alt="npm version"/></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"/></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js >= 20"/></a>
</p>

<p align="center">
  <a href="#하네스가-당신을-담고-간다">비전</a> &middot;
  <a href="#forgen를-쓰면-일어나는-일">동작 흐름</a> &middot;
  <a href="#빠른-시작">빠른 시작</a> &middot;
  <a href="#동작-방식">동작 방식</a> &middot;
  <a href="#4축-개인화">4축 개인화</a> &middot;
  <a href="#명령어">명령어</a> &middot;
  <a href="#아키텍처">아키텍처</a> &middot;
  <a href="#안전">안전</a>
</p>

<p align="center">
  <a href="README.md">English</a> &middot;
  한국어 &middot;
  <a href="README.ja.md">日本語</a> &middot;
  <a href="README.zh.md">简体中文</a>
</p>

---

## 두 개발자. 같은 Claude. 완전히 다른 행동.

개발자 A는 신중합니다. Claude가 모든 테스트를 돌리고, 이유를 설명하고, 현재 파일 밖의 것은 손대기 전에 물어봐야 합니다.

개발자 B는 빠릅니다. Claude가 가정하고, 관련 파일까지 바로 고치고, 결과를 두 줄로 보고하면 됩니다.

forgen 없이는 두 개발자 모두 같은 범용 Claude를 받습니다. forgen를 쓰면, 각자 자기 방식대로 일하는 Claude를 받습니다.

```
개발자 A의 Claude:                      개발자 B의 Claude:
"관련 이슈 3개를 발견했습니다.             "로그인 + 관련 파일 2개 수정 완료.
진행하기 전에 세션 핸들러도                  테스트 통과. 리스크 1건: 세션
함께 수정할까요? 각각의 분석은               타임아웃 미커버. 끝."
다음과 같습니다..."
```

forgen가 이것을 가능하게 합니다. 작업 스타일을 프로파일링하고, 교정에서 학습하고, Claude가 매 세션마다 따르는 개인화 규칙을 렌더링합니다.

---

## 하네스가 당신을 담고 간다

개인화는 표면입니다. 더 깊은 아이디어: **매 세션이 흔적을 남기고, 그 흔적들이 쌓여 당신처럼 판단하는 하네스가 됩니다.** 교정, 컨벤션, 트레이드오프 선호 — 대화에서 추출되어 `~/.forgen/me/` 에 저장되고, 다음 세션마다 Claude 에 다시 주입됩니다.

```
대화       ──►  추출: solution / rule / behavior / profile 업데이트
                 ──────────────────────────────────────────────
                                   │
                                   ▼
다음 세션  ◄──  주입: UserPromptSubmit 컨텍스트 + 렌더된 규칙
                 + 당신의 기준에 맞춘 Stop-hook 가드
```

몇 주가 지나면 이 하네스는 "규칙을 강제하는 도구"가 아니라 **당신이 일을 판단하는 방식이 담긴 휴대 가능한 번들** 이 됩니다. 한 줄로 export:

```bash
forgen compound export    # → forgen-knowledge-YYYY-MM-DD.tar.gz
                          #   (rules + solutions + behavior — 당신의 철학)
forgen compound import <path>   # 다른 머신에서 그대로 재연
```

그게 북극성입니다: *노트북 위에 있는, 당신처럼 판단하는 Claude, 그리고 들고 다닐 수 있는 tarball.*

---

## forgen를 쓰면 일어나는 일

### 첫 실행 (1회, 약 1분)

```bash
npm install -g @wooojin/forgen
forgen
```

첫 실행을 감지하면 4문항 온보딩이 시작됩니다. 각 질문은 구체적인 시나리오입니다:

```
  질문 1: 애매한 구현 요청

  "로그인 기능을 개선해줘"라는 요청을 받았습니다.
  요구사항이 명확하지 않고, 인접 모듈에 영향을 줄 수 있습니다.

  A) 먼저 요구사항/범위를 확인하고, 범위 확대 가능성이 있으면 물어본다
  B) 같은 흐름 안이면 진행하되, 큰 범위 확대가 보이면 확인한다
  C) 합리적으로 가정하고 인접 파일까지 바로 수정한다

  선택 (A/B/C):
```

4개의 질문. 4개의 축 측정. 각 축에 팩과 세밀한 facet이 포함된 프로필이 생성됩니다. 개인화된 규칙 파일이 렌더링되어 Claude가 읽는 위치에 배치됩니다.

### 매 세션 (일상 사용)

```bash
forgen                    # `claude` 대신 사용
```

내부 동작:

1. 하네스가 `~/.forgen/me/forge-profile.json`에서 프로필 로드
2. 프리셋 매니저가 세션 합성: 글로벌 안전 규칙 + 팩 기본 규칙 + 개인 오버레이 + 세션 오버레이
3. 규칙 렌더러가 모든 것을 자연어로 변환하여 `~/.claude/rules/v1-rules.md`에 기록
4. Claude Code가 시작되어 해당 규칙을 행동 지침으로 읽음
5. 안전 훅 활성화: 위험 명령 차단, 시크릿 필터링, 프롬프트 인젝션 탐지

### Claude를 교정할 때

당신이 말합니다: "내가 요청하지 않은 파일은 리팩토링하지 마."

Claude가 `correction-record` MCP 도구를 호출합니다. 교정은 축 분류(`judgment_philosophy`), 종류(`avoid-this`), 신뢰도 점수가 포함된 구조화된 evidence로 저장됩니다. 현재 세션에 즉시 효과를 주는 임시 규칙이 생성됩니다.

### 세션 사이 (자동)

세션이 끝나면 auto-compound가 추출합니다:
- 솔루션 (맥락이 포함된 재사용 가능한 패턴)
- 행동 관찰 (당신의 작업 방식)
- 세션 학습 요약

축적된 evidence를 기반으로 facet이 미세 조정됩니다. 교정이 지속적으로 현재 팩과 다른 방향을 가리키면, 3세션 후 mismatch 감지가 트리거되어 팩 변경을 추천합니다.

### 다음 세션

교정이 반영된 업데이트 규칙이 렌더링됩니다. Compound 지식이 MCP를 통해 검색 가능합니다. Claude가 *당신의* Claude가 되어갑니다.

---

## 빠른 시작

```bash
# 1. 설치 (반드시 -g — forgen 은 글로벌 CLI)
npm install -g @wooojin/forgen

# 2. 호스트 등록 — Claude Code / Codex / 양쪽
forgen install both          # 3지선다 인터랙티브: claude / codex / both
# 또는 비대화형:
forgen install claude
forgen install codex

# 3. 첫 실행 — 4문항 온보딩 (영어/한국어 선택)
forgen                        # 기본: Claude
forgen --runtime codex        # Codex 로 실행
forgen config default-host codex   # 영구 기본 호스트 설정
```

### 사전 요구사항

- **Node.js** >= 20 (SQLite 세션 검색은 >= 22 권장)
- **하나 이상의 호스트** 설치 및 인증:
  - **Claude Code** — `npm i -g @anthropic-ai/claude-code`
  - **Codex CLI** — [Codex docs](https://github.com/openai/codex) 참고
  - 둘 다 사용 가능 — `forgen install both` 가 양쪽에 hook/MCP 를 대칭 등록

> **벤더 의존성:** forgen 은 Claude Code 와 Codex CLI 를 대칭 래핑합니다 (Claude 가 동작 기준, Codex 가 동등성 확장). 상위 API/CLI 변경이 동작에 영향을 줄 수 있습니다. Claude Code 1.0.x / 2.1.x, Codex 0.x 에서 테스트됨.

### 격리 / CI / Docker 사용

forgen 홈은 기본 `~/.forgen` 이지만 프로세스별 override 가능:

```bash
# 깨끗한 격리 홈 — 실제 ~/.forgen 은 건드리지 않음
FORGEN_HOME=/tmp/forgen-clean forgen init    # starter-pack 15개 자동 배포
FORGEN_HOME=/tmp/forgen-clean forgen stats   # 격리 홈의 통계만 표시
FORGEN_HOME=/tmp/forgen-clean claude -p "…"  # 훅이 env 상속 → 격리된 로그
```

Claude Code 훅 프로세스가 부모 env 를 상속하므로 `FORGEN_HOME=...` 프리픽스
하나면 모든 상태(rules/solutions/behavior/enforcement)가 해당 디렉터리로 격리.
쓰임새:

- CI 파이프라인에서 고정 시드로 forgen 검증
- 실 홈 오염 없이 "신규 사용자 첫날 경험" 재현
- 한 머신에서 여러 페르소나 운영

**Docker / 원격 서버 (OAuth 제약):** Claude Code 는 OAuth 세션을 **OS 키체인**
(macOS Keychain / libsecret / Windows Credential Manager) 에 저장하므로, 새
Linux 컨테이너에서 `~/.claude.json` 만 마운트하면 refresh 토큰이 없어서 인증이
안 됩니다. 컨테이너 환경에서는 `ANTHROPIC_API_KEY` env 를 사용하세요. 호스트
기반 사용(macOS/Linux 워크스테이션) 은 `claude login` 흐름 그대로 동작 — API
키 불필요.

### 마이그레이션

`forgen migrate implicit-feedback` — pre-v0.4.1 로그의 `category` 필드 백필.
멱등(idempotent) — 여러 번 실행 안전.

---

## 왜 forgen인가

|                        | Generic Claude Code | oh-my-claudecode | forgen          |
|------------------------|:-------------------:|:----------------:|:---------------:|
| 모두에게 동일           | Yes                 | Yes              | **No**          |
| 교정에서 학습           | No                  | No               | **Yes**         |
| Evidence 기반 라이프사이클| No               | No               | **Yes**         |
| 나쁜 패턴 자동 은퇴      | No                  | No               | **Yes**         |
| 개인화된 규칙           | No                  | No               | **Yes**         |
| 런타임 의존성           | -                   | many             | **3**           |

### 언제 사용하면 좋은가

**잘 맞는 경우:**
- 몇 주에 걸쳐 Claude가 패턴을 학습하는 장기 프로젝트
- AI 행동 방식에 강한 선호가 있는 개발자
- Compound 지식의 혜택을 받는 반복 패턴이 있는 코드베이스

**맞지 않는 경우:**
- 일회성 스크립트나 임시 프로토타입
- Claude Code가 없는 환경
- 모든 구성원이 동일한 AI 행동이 필요한 팀 (forgen은 개인용이지, 팀용이 아님)

**forgen + oh-my-claudecode:** 함께 사용할 수 있습니다. OMC는 오케스트레이션(에이전트, 워크플로우)을, forgen은 개인화(프로필, 학습)를 담당합니다. [공존 가이드](docs/guides/with-omc.md)를 참고하세요.

---

## 동작 방식

### 학습 루프

```
                          +-------------------+
                          |     온보딩         |
                          |   (4문항)          |
                          +--------+----------+
                                   |
                                   v
                   +-------------------------------+
                   |       프로필 생성               |
                   |  4축 x 팩 + facet + trust       |
                   +-------------------------------+
                                   |
           +-----------------------+------------------------+
           |                                                |
           v                                                |
  +------------------+                                      |
  |  규칙 렌더링      |   ~/.claude/rules/v1-rules.md        |
  |  Claude 형식으로  |                                      |
  +--------+---------+                                      |
           |                                                |
           v                                                |
  +------------------+                                      |
  |  세션 진행        |   Claude가 개인화 규칙을 따름          |
  |   교정하면       | ---> correction-record MCP            |
  |   Claude 학습    |      Evidence 저장                    |
  +--------+---------+      임시 규칙 생성                    |
           |                                                |
           v                                                |
  +------------------+                                      |
  |  세션 종료        |   auto-compound 추출:                 |
  |                  |   솔루션 + 관찰 + 요약                  |
  +--------+---------+                                      |
           |                                                |
           v                                                |
  +------------------+                                      |
  |  Facet 조정      |   프로필 미세 조정                     |
  |  Mismatch 확인   |   최근 3세션 rolling 분석              |
  +--------+---------+                                      |
           |                                                |
           +------------------------------------------------+
                    (다음 세션: 업데이트된 규칙)
```

### Compound 지식

지식은 세션을 거치며 신뢰도 기반 라이프사이클로 축적됩니다:

```
experiment (0.30) → candidate (0.55) → verified (0.75) → mature (0.90)
```

각 솔루션은 `experiment`로 시작합니다. 세션을 거치며 코드에 반영될수록 자동 승격됩니다. 부정적 evidence는 서킷 브레이커를 작동시켜 자동 은퇴시킵니다. 실제로 당신에게 맞는 패턴만 살아남습니다.

| 유형 | 출처 | Claude 활용 방법 |
|------|------|-----------------|
| **솔루션** | 세션에서 추출 | 프롬프트와 관련 있을 때 자동 주입 (TF-IDF + BM25 + bigram 앙상블) |
| **스킬** | 10개 내장 + 검증된 솔루션에서 승격 | 키워드로 활성화 (`deep-interview`, `forge-loop`, `ship` 등) |
| **행동 패턴** | 3회 이상 관찰 시 자동 감지 | `forge-behavioral.md`에 적용 |
| **Evidence** | 교정 + 관찰 | facet 조정 및 규칙 생성의 근거 |

### Solution 자동 주입

입력하는 모든 프롬프트가 축적된 솔루션과 매칭됩니다. 관련 솔루션은 Claude의 컨텍스트에 자동 주입됩니다 — 직접 찾아볼 필요가 없습니다.

```
입력: "API의 에러 핸들링을 고쳐줘"
                    ↓
solution-injector 매칭: starter-error-handling-patterns (0.70)
                    ↓
Claude에게 전달: "매칭된 솔루션: error-handling-patterns [pattern|0.70]
             특정 에러 타입으로 try/catch 사용. 원본 에러는 반드시 로깅..."
                    ↓
Claude가 축적된 패턴을 바탕으로 더 나은 에러 핸들링 코드를 작성합니다.
```

### 10개 내장 스킬

엄선된 compound-native 스킬. 모든 스킬이 축적된 지식과 연동 — 쓸수록 정확해집니다.

**핵심 체인** (빌드 → 학습):

| 스킬 | 트리거 | 기능 |
|------|--------|------|
| `deep-interview` | "deep-interview", "딥인터뷰" | 가중 4차원 ambiguity 점수, 3개 챌린지 모드 (Contrarian/Simplifier/Ontologist), 온톨로지 추적 |
| `forge-loop` | "forge-loop", "끝까지" | PRD 기반 반복 루프. Stop 훅이 polite-stop 방지. Verifier가 fresh evidence 강제 |
| `compound` | "복리화", "compound" | 5-Question 품질 필터로 패턴 추출. Health dashboard 포함 |

**관리 체인** (리뷰 → 튜닝):

| 스킬 | 트리거 | 기능 |
|------|--------|------|
| `retro` | "retro", "회고" | 주간 회고: git 분석 + compound 건강도 + 학습 추세 + 3가지 추천 |
| `learn` | "learn prune", "compound 정리" | 5개 서브커맨드: search/stats/prune/export/import. Stale & 중복 자동 감지 |
| `calibrate` | "calibrate", "프로필 보정" | Evidence 기반 프로필 조정. 한 번에 최대 2개 축. 임계값: 같은 방향 3건+ |

**독립 스킬**:

| 스킬 | 트리거 | 기능 |
|------|--------|------|
| `ship` | "ship", "배포" | 15단계 파이프라인. "Never ask, just do" 철학. Review Readiness Dashboard + Verification Gate |
| `code-review` | "code review", "리뷰" | 신뢰도 1-10 보정, Critical 5개 카테고리 (SQL/race/LLM trust/secrets/enum), auto-fix |
| `architecture-decision` | "adr" | 가중 트레이드오프 매트릭스, ADR 라이프사이클, 가역성 분류 |
| `docker` | "docker", "컨테이너" | 멀티스테이지 빌드, 보안 강화, 10개 failure modes |

### 세션 관리

| 기능 | 동작 |
|------|------|
| **세션 브리프** | 컨텍스트 압축 전 구조화된 브리프 저장 → 다음 세션에서 복원 |
| **drift 감지** | EWMA 기반 편집 속도 추적 → 15회 편집 시 경고, 30회 위험, 50회 강제 정지 |
| **에이전트 출력 검증** | Claude가 서브 에이전트를 실행할 때 출력 품질 자동 검증 |
| **자동 압축** | 누적 12만 자 초과 시 Claude에게 컨텍스트 압축 지시 |
| **pending compound** | 20회 이상 프롬프트 세션 후 다음 세션에서 compound 추출 자동 트리거 |

---

## 4축 개인화

각 축에는 3개의 팩이 있습니다. 각 팩에는 세밀한 facet(0-1 수치)이 포함되어 있으며, 교정에 따라 시간이 지나면서 미세 조정됩니다.

### 품질/안전

| 팩 | Claude의 행동 |
|----|-------------|
| **보수형** | 완료 보고 전 모든 테스트를 실행. 타입 체크. 엣지 케이스 검증. 모든 검사가 통과해야 "완료"라고 말함. |
| **균형형** | 핵심 검증을 실행하고, 남은 리스크를 요약. 철저함과 속도의 균형. |
| **속도형** | 빠른 smoke 테스트. 결과와 리스크를 즉시 보고. 전달을 우선. |

### 자율성

| 팩 | Claude의 행동 |
|----|-------------|
| **확인 우선형** | 인접 파일을 수정하기 전 확인. 애매한 요구사항 명확화. 범위 확장에 승인 요청. |
| **균형형** | 같은 흐름 안이면 진행. 큰 범위 확대가 보이면 확인. |
| **자율 실행형** | 합리적으로 가정. 관련 파일을 바로 수정. 완료 후 무엇을 했는지 보고. |

### 판단 철학

| 팩 | Claude의 행동 |
|----|-------------|
| **최소변경형** | 기존 구조 유지. 동작하는 코드를 리팩토링하지 않음. 수정 범위를 최소한으로 유지. |
| **균형형** | 현재 작업에 집중. 명확한 개선 기회가 보이면 제안. |
| **구조적접근형** | 반복 패턴이나 기술 부채를 발견하면 적극적으로 구조 개선 제안. 추상화와 재사용 설계 선호. 아키텍처 일관성 유지. |

### 커뮤니케이션

| 팩 | Claude의 행동 |
|----|-------------|
| **간결형** | 코드와 결과만. 선제적으로 설명하지 않음. 물어볼 때만 부연. |
| **균형형** | 핵심 변경과 이유를 요약. 필요하면 추가 질문 유도. |
| **상세형** | 무엇을, 왜, 영향 범위, 대안까지 설명. 교육적 맥락 제공. 보고서를 섹션별로 구조화. |

---

## 렌더링된 규칙의 실제 모습

forgen가 세션을 합성하면 Claude가 읽는 `v1-rules.md` 파일을 렌더링합니다. 서로 다른 프로필이 완전히 다른 Claude 행동을 만드는 두 가지 실제 예시입니다.

### 예시 1: 보수형 + 확인 우선형 + 구조적접근형 + 상세형

```markdown
[보수형 quality / 확인 우선형 autonomy / 구조적접근형 judgment / 상세형 communication]

## Must Not
- .env, credentials, API 키를 절대 커밋하거나 노출하지 마라.
- 파괴적 명령(rm -rf, DROP, force-push)은 사용자 확인 없이 실행하지 마라.

## Working Defaults
- Trust: 위험 우회 비활성. 파괴적 명령, 민감 경로 접근 시 항상 확인.
- 반복되는 패턴이나 기술 부채를 발견하면 적극적으로 구조 개선을 제안하라.
- 추상화와 재사용 가능한 설계를 선호하라. 단, 과도한 추상화는 피한다.
- 변경 시 전체 아키텍처 관점에서 일관성을 유지하라.

## When To Ask
- 애매한 작업은 시작 전 요구사항을 명확히 하라.
- 명시적으로 요청된 범위 밖의 파일을 수정하기 전에 확인하라.

## How To Validate
- 완료 보고 전 관련 테스트, 타입 체크, 핵심 검증을 모두 완료하라.
- 모든 검사가 통과하기 전에는 "완료"라고 하지 마라.

## How To Report
- 변경 이유, 대안 검토, 영향 범위를 함께 설명하라.
- 교육적 맥락을 제공하라 — 왜 이 접근이 좋은지, 다른 방법과 비교.
- 보고는 구조화하라 (변경 사항, 이유, 영향, 다음 단계).

## Evidence Collection
- 사용자가 행동을 교정하면("하지마", "그렇게 말고", "앞으로는 이렇게") 반드시 correction-record MCP 도구를 호출하여 evidence로 기록하라.
- kind 선택: fix-now(즉시 수정), prefer-from-now(앞으로 이렇게), avoid-this(하지 마라)
- axis_hint: quality_safety(품질/검증), autonomy(자율/확인), judgment_philosophy(변경 접근법), communication_style(설명 스타일)
- 교정이 아닌 일반 피드백은 기록하지 않는다.
```

### 예시 2: 속도형 + 자율 실행형 + 최소변경형 + 간결형

```markdown
[속도형 quality / 자율 실행형 autonomy / 최소변경형 judgment / 간결형 communication]

## Must Not
- .env, credentials, API 키를 절대 커밋하거나 노출하지 마라.
- 파괴적 명령(rm -rf, DROP, force-push)은 사용자 확인 없이 실행하지 마라.

## Working Defaults
- Trust: 런타임 마찰 최소화. 명시적 금지와 파괴적 명령 외에는 자유 실행.
- 기존 코드 구조를 최대한 유지하라. 동작하는 코드를 불필요하게 리팩토링하지 마라.
- 수정 범위를 최소한으로 유지하라. 인접 파일 변경은 꼭 필요한 경우에만.
- 변경 전 근거(테스트, 에러 로그)를 먼저 확보하라.

## How To Validate
- 최소 smoke만 보고 빠르게 결과와 리스크만 보고하라.

## How To Report
- 응답은 짧고 핵심만. 코드와 결과 위주로 보고하라.
- 부연 설명은 물어볼 때만. 선제적으로 길게 설명하지 마라.

## Evidence Collection
- 사용자가 행동을 교정하면("하지마", "그렇게 말고", "앞으로는 이렇게") 반드시 correction-record MCP 도구를 호출하여 evidence로 기록하라.
- kind 선택: fix-now(즉시 수정), prefer-from-now(앞으로 이렇게), avoid-this(하지 마라)
- axis_hint: quality_safety(품질/검증), autonomy(자율/확인), judgment_philosophy(변경 접근법), communication_style(설명 스타일)
- 교정이 아닌 일반 피드백은 기록하지 않는다.
```

같은 Claude. 같은 코드베이스. 완전히 다른 작업 스타일. 1분짜리 온보딩이 만든 차이입니다.

---

## 명령어

### 핵심

```bash
forgen                          # 개인화된 Claude Code 시작
forgen "로그인 버그 수정해줘"     # 프롬프트와 함께 시작
forgen --resume                 # 이전 세션 이어서
```

### 개인화

```bash
forgen onboarding               # 4문항 온보딩 실행
forgen forge --profile          # 현재 프로필 확인
forgen forge --reset soft       # 프로필 초기화 (soft / learning / full)
forgen forge --export           # 프로필 내보내기
```

### 상태 확인

```bash
forgen stats                    # 한 화면 Trust Layer 대시보드 (규칙·교정·block 7일)
forgen last-block               # 가장 최근 block 이벤트와 rule 상세
forgen inspect profile          # 4축 프로필 + 팩 + facet
forgen inspect rules            # 활성/비활성 규칙
forgen inspect corrections      # 교정 기록 (alias: evidence)
forgen inspect session          # 현재 세션 상태
forgen inspect violations       # 최근 block 기록 (--last N)
forgen me                       # 개인 대시보드 (inspect profile 단축키)
```

### 규칙 관리

```bash
forgen rule list                # 활성 + suppressed 규칙 목록
forgen rule suppress <id>       # 규칙 비활성화 (hard 규칙은 거부)
forgen rule activate <id>       # suppressed 규칙 재활성화
forgen rule scan [--apply]      # 수명주기 트리거 실행 (승격/강등/은퇴)
forgen rule health-scan         # drift → Mech 강등 후보 스캔
forgen rule classify            # 레거시 규칙에 enforce_via 자동 제안
```

### 지식 관리

```bash
forgen compound                 # 축적된 지식 미리보기
forgen compound --save          # 자동 분석된 패턴 저장
forgen compound list            # 상태가 포함된 솔루션 전체 목록
forgen compound inspect <이름>  # 솔루션 전체 내용 확인
forgen compound --lifecycle     # 승격/강등 검사 실행
forgen compound --verify <이름> # 수동으로 verified 승격
forgen compound export          # 지식을 tar.gz로 내보내기
forgen compound import <경로>   # 지식 아카이브 가져오기
forgen skill promote <이름>     # 검증된 솔루션을 스킬로 승격
forgen skill list               # 승격된 스킬 목록
```

### 시스템

```bash
forgen init                     # 프로젝트 초기화
forgen doctor                   # 시스템 진단 (10개 항목 + 하네스 성숙도)
forgen dashboard                # 지식 현황 대시보드 (6개 섹션)
forgen config hooks             # 훅 상태 + 컨텍스트 예산 확인
forgen config hooks --regenerate # 훅 재생성
forgen mcp list                 # 설치된 MCP 서버 목록
forgen mcp add <이름>           # 템플릿에서 MCP 서버 추가
forgen mcp templates            # 사용 가능한 템플릿 목록
forgen notepad show             # 세션 노트패드 보기
forgen uninstall                # forgen 깔끔하게 제거
```

### MCP 도구 (세션 중 Claude가 사용)

| 도구 | 용도 |
|------|------|
| `compound-search` | 축적된 지식을 쿼리로 검색 (TF-IDF + BM25 + bigram 앙상블) |
| `compound-read` | 솔루션 전문 읽기 (Progressive Disclosure Tier 3) |
| `compound-list` | 상태/유형/범위 필터가 있는 솔루션 목록 |
| `compound-stats` | 상태, 유형, 범위별 통계 현황 |
| `session-search` | 이전 세션 대화 검색 (SQLite FTS5, Node.js 22+) |
| `correction-record` | 사용자 교정을 구조화된 evidence로 기록 |
| `profile-read` | 현재 개인화 프로필 읽기 |
| `rule-list` | 카테고리별 활성 개인화 규칙 목록 |

---

## 아키텍처

```
~/.forgen/                           개인화 홈
|-- me/
|   |-- forge-profile.json           4축 프로필 (팩 + facet + trust)
|   |-- rules/                       규칙 저장소 (규칙별 JSON 파일)
|   |-- behavior/                    Evidence 저장소 (교정 + 관찰)
|   |-- recommendations/             팩 추천 (온보딩 + mismatch)
|   +-- solutions/                   Compound 지식
|-- state/
|   |-- sessions/                    세션 상태 스냅샷
|   +-- raw-logs/                    Raw 세션 로그 (7일 TTL 자동 정리)
+-- config.json                      글로벌 설정 (locale, trust, packs)

~/.claude/
|-- settings.json                    훅 + 환경변수 (하네스가 주입)
|-- rules/
|   |-- forge-behavioral.md          학습된 행동 패턴 (자동 생성)
|   +-- v1-rules.md                  렌더링된 개인화 규칙 (세션별)
|-- commands/forgen/                 슬래시 커맨드 (승격된 스킬)
+-- .claude.json                     MCP 서버 등록

~/.compound/                         레거시 compound 홈 (훅/MCP가 아직 참조)
|-- me/
|   |-- solutions/                   축적된 compound 지식
|   |-- behavior/                    행동 패턴
|   +-- skills/                      승격된 스킬
+-- sessions.db                      SQLite 세션 이력 (Node.js 22+)
```

### 데이터 흐름

```
forge-profile.json                   개인화의 단일 진실 원천
        |
        v
preset-manager.ts                    세션 상태 합성:
  글로벌 안전 규칙                       hard constraint (항상 활성)
  + 기본 팩 규칙                         프로필 팩에서
  + 개인 오버레이                        교정 생성 규칙에서
  + 세션 오버레이                        현재 세션 임시 규칙
  + 런타임 능력 감지                     trust 정책 조정
        |
        v
rule-renderer.ts                     Rule[]을 자연어로 변환:
  필터 (active만)                      파이프라인: filter -> dedupe -> group ->
  dedupe (render_key)                  order -> template -> budget (4000자)
  카테고리별 그룹
  순서: Must Not -> Working Defaults -> When To Ask -> How To Validate -> How To Report
        |
        v
~/.claude/rules/v1-rules.md         Claude가 실제로 읽는 파일
```

---

## 안전

안전 훅은 `settings.json`에 자동 등록되며, Claude의 모든 도구 호출 시 실행됩니다.

| 훅 | 트리거 | 기능 |
|----|--------|------|
| **pre-tool-use** | 모든 도구 실행 전 | `rm -rf`, `curl\|sh`, `--force` push, 위험 패턴 차단 |
| **db-guard** | SQL 연산 | `DROP TABLE`, `WHERE` 없는 `DELETE`, `TRUNCATE` 차단 |
| **secret-filter** | 파일 쓰기, 출력 | API 키, 토큰, 자격 증명 노출 시 경고 |
| **slop-detector** | 코드 생성 후 | TODO 잔재, `eslint-disable`, `as any`, `@ts-ignore`, 빈 catch 감지 |
| **prompt-injection-filter** | 모든 입력 | 패턴 + 휴리스틱 기반 프롬프트 인젝션 차단 |
| **context-guard** | 세션 중 | 50 프롬프트/20만 자 시 경고, 12만 자 자동 압축, 세션 인계 |
| **rate-limiter** | MCP 도구 호출 | 과도한 MCP 도구 호출 방지 |
| **drift-detector** | 파일 편집 | EWMA 기반 drift 점수: 경고 → 위험 → 50회 편집 시 강제 정지 |
| **agent-validator** | 에이전트 도구 출력 | 서브 에이전트 출력이 비어있거나 실패/잘린 경우 경고 |

안전 규칙은 **hard constraint**입니다 -- 팩 선택이나 교정으로 재정의할 수 없습니다. 렌더링된 규칙의 "Must Not" 섹션은 프로필과 무관하게 항상 존재합니다.

---

## 핵심 설계 원칙

- **4축 프로필, 선호도 토글이 아님.** 각 축에는 팩(대분류)과 facet(0-1 수치의 세밀한 조정)이 있습니다. 팩은 안정적 행동을 제공하고, facet은 전체 재분류 없이 미세 조정을 가능하게 합니다.

- **Evidence 기반 학습, regex 매칭이 아님.** 교정은 구조화된 데이터(`CorrectionRequest`: kind, axis_hint, message)입니다. Claude가 분류하고, 알고리즘이 적용합니다. 사용자 입력에 대한 패턴 매칭이 없습니다.

- **Pack + overlay 모델.** 기본 팩이 안정적 기본값을 제공합니다. 교정에서 생성된 개인 오버레이가 위에 쌓입니다. 세션 오버레이는 임시 규칙입니다. 충돌 해소: 세션 > 개인 > 팩 (글로벌 안전은 항상 hard constraint).

- **자연어로 렌더링된 규칙.** `v1-rules.md` 파일에는 설정이 아닌 한국어(또는 영어) 문장이 담깁니다. Claude는 "동작하는 코드를 불필요하게 리팩토링하지 마라"같은 지침을 읽습니다 -- 사람 멘토가 가이드를 주는 것과 같은 방식입니다.

- **Mismatch 감지.** 최근 3세션 rolling 분석으로 교정이 지속적으로 현재 팩과 다른 방향을 가리키는지 확인합니다. 감지되면 조용히 drift하지 않고, 팩 재추천을 제안합니다.

- **런타임 trust 계산.** 원하는 trust 정책이 Claude Code의 실제 런타임 권한 모드와 조율됩니다. Claude Code가 `--dangerously-skip-permissions`로 실행되면, forgen가 effective trust 수준을 그에 맞게 조정합니다.

- **국제화.** 영어와 한국어 완전 지원. 온보딩 시 언어를 선택하면 온보딩 질문, 렌더링된 규칙, CLI 출력 전체에 적용됩니다.

---

## 공존

forgen는 설치 시 다른 Claude Code 플러그인(oh-my-claudecode, superpowers, claude-mem)을 감지하고 컨텍스트 주입을 50% 자동 축소합니다 (양보 원칙). 핵심 안전 훅과 compound 훅은 항상 활성 상태를 유지합니다. 다른 플러그인이 이미 제공하는 스킬은 충돌을 피하기 위해 건너뜁니다.

자세한 내용은 [공존 가이드](docs/guides/with-omc.md)를 참고하세요.

---

## 문서

| 문서 | 설명 |
|------|------|
| [훅 레퍼런스](docs/reference/hooks-reference.md) | 3개 계층의 19개 훅 — 이벤트, 타임아웃, 동작 |
| [공존 가이드](docs/guides/with-omc.md) | oh-my-claudecode와 forgen 함께 사용하기 |
| [CHANGELOG](CHANGELOG.md) | 버전 히스토리 및 릴리즈 노트 |

---

## 라이선스

MIT
