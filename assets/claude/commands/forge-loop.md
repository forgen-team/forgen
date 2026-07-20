---
name: forge-loop
description: This skill should be used when the user asks to "forge-loop, 포지루프, 끝까지, don't stop, goal, 목표, goal lock, scope lock". 작업을 PRD(User Story)로 분해 + 모든 수용 기준 충족까지 반복 실행. `--goal-only` 플래그로 PRD/수용기준 박제만 (실행 사이클 없이) 가능 — goal-locking pattern lightweight 진입점.
argument-hint: "[task description] [--goal-only]"
model: inherit
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Agent
  - Edit
  - Write
triggers:
  - "forge-loop"
  - "포지루프"
  - "끝까지"
  - "don't stop"
  - "완료될 때까지"
  - "루프로 실행"
  - "goal"
  - "목표"
  - "goal lock"
  - "scope lock"
  - "completion criteria"
  - "수용 기준"
---

<Purpose>
주어진 작업을 User Story + 수용 기준으로 분해하고, 모든 스토리가 검증을 통과할 때까지
ch-planner -> ch-executor -> ch-verifier 사이클을 반복합니다.
스토리 하나가 완료되면 멈추지 않고 즉시 다음 스토리로 진행합니다.
사용자에게 보고하는 시점은 "전부 완료", "에스컬레이션", "컨텍스트 한계" 세 가지뿐입니다.
</Purpose>

<Compound_Integration>
## Compound-In: 관련 패턴 로드

루프 시작 전 + 각 스토리 시작 전에 compound-search를 수행합니다.

```
compound-search 도구로 작업 키워드를 검색하세요.
예: compound-search("TypeScript", "테스트", "리팩토링") 등
```

## Compound-Out: 세션 종료 시 패턴 추출

모든 스토리 완료 후:
- 실패 후 성공한 패턴 -> troubleshoot 후보
- 반복 사용된 접근법 -> pattern 후보
- 아키텍처 결정 -> decision 후보
</Compound_Integration>

<Steps>
## Phase 1: PRD 설정

### PRD 구조
```json
{
  "task": "{$ARGUMENTS}",
  "stories": [
    {
      "id": "US-001",
      "title": "스토리 제목",
      "description": "As a {role}, I want {feature} so that {value}",
      "acceptanceCriteria": ["구체적이고 테스트 가능한 기준"],
      "passes": false,
      "attempts": 0,
      "dependencies": []
    }
  ]
}
```

### 수용 기준 품질 규칙

| 금지 (일반적) | 교체 (구체적) |
|--------------|-------------|
| "코드가 컴파일된다" | "npm run build가 exit 0으로 완료된다" |
| "테스트가 통과한다" | "npm test의 {test-name}이 PASS한다" |
| "기능이 동작한다" | "POST /api/users에 {payload}를 보내면 201이 반환된다" |

### 상태 파일 저장 (필수 — Stop 훅 연동)

PRD 확정 직후 **반드시** `~/.forgen/state/forge-loop.json`에 저장:

```bash
mkdir -p ~/.forgen/state
cat > ~/.forgen/state/forge-loop.json <<EOF
{"active":true,"startedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","stories":[
  {"id":"US-001","title":"...","passes":false,"attempts":0,"acceptanceCriteria":["..."]}
]}
EOF
```

이 파일이 있어야 Claude가 중간에 멈추지 않도록 Stop 훅이 차단합니다.
소유 세션은 최초 차단 시점에 Stop 훅이 자동 귀속하므로(`sessionId` 필드) 이
파일을 쓸 때 세션 ID를 직접 넣을 필요는 없습니다 — 단, 귀속된 세션과 다른
세션에서는 이 루프가 차단하지 않습니다. 24시간 이상 갱신이 없으면 자동
해제(1회성 안내 포함)되며, 연속 30회 차단 시에도 안전 상한으로 자동 해제됩니다.
스토리 완료 시 `passes: true`로 업데이트. 전체 완료는 Stop 훅이 자동 처리.
`acceptanceCriteria[0]`은 차단 메시지에 `AC1:`로 노출되므로 있으면 첫 항목을
구체적이고 검증 가능한 문장으로 작성하세요 (없어도 정상 동작).

### goal-only 모드 — Phase 1 종료 분기

`$ARGUMENTS` 에 `--goal-only` / `--goal` / `--lock-only` 중 하나가 포함된 경우,
Phase 1 종료 직후 다음을 산출하고 종료 (Phase 2/3 건너뜀):

1. 위 PRD JSON 의 stories 배열을 markdown Goal 박스로 변환:
   ```
   GOAL: <stories[0].title — 단일 story 면 한 문장 요약>
   완료 기준 (Acceptance Criteria):
     - [ ] <story[i].acceptanceCriteria[j] 각각 — 구체적 증거 타입 포함>
   제약 (Out-of-Scope):
     - <"수용 기준 품질 규칙" 표의 금지 패턴들>
     - <사용자가 명시한 dry-run / touch 안 할 경로 등>
   검증 방법:
     - <각 AC 의 verification command (bash / curl / file check)>
   컴파운드 패턴 (참고):
     - <compound-search top 1-2 결과 — 본 작업 키워드로 검색>
   ```

2. 사용자에게 박스를 보여주고 안내:
   ```
   GOAL 박제 완료. 다음 옵션:
   - 이 박스를 다른 컨텍스트/에이전트에 위임 → 복사 사용
   - 본 세션에서 자동 실행 → `forge-loop resume` 로 Phase 2 이어 실행
   상태 파일: ~/.forgen/state/forge-loop.json (resume 시 재활용)
   ```

3. 종료. **Anti-Polite-Stop 규칙은 goal-only 모드에 적용 안 함** — 박제가 목적이고 실행은 명시적 escalation 시에만.

## Phase 2: 스토리 실행 루프

### 2-1. Compound-In (스토리별)
해당 스토리의 키워드로 compound-search 실행. 관련 패턴을 Planner에게 전달.

### 2-2. Planner
구현 계획 수립: 변경 파일, 접근법, compound 패턴 적용, 위험 요소, 검증 방법.

### 2-3. Executor
최소 변경으로 구현: 기존 패턴 준수, <200줄, 빌드 통과, 임시 코드 금지.

### 2-4. Verifier
각 AC를 독립적으로 검증. PASS/FAIL + 증거(테스트 출력, 빌드 로그, curl 응답).
"should work"는 증거가 아닙니다 -- 반드시 실행합니다.

```
수용 기준 검증:
- AC1: "POST /api/users가 201을 반환한다"
  -> PASS | 증거: `curl -X POST ... -> HTTP/1.1 201 Created`
- AC2: "잘못된 이메일 시 400 반환"
  -> FAIL | 증거: `curl -X POST ... -> 500`
```

### 2-5. 스토리 완료 판정
- 모든 AC PASS -> `passes: true` -> 즉시 다음 스토리 (보고하지 않음)
- FAIL -> `attempts++` -> ch-debugger -> ch-executor -> ch-verifier 재실행
- attempt == 3 -> 에스컬레이션

## Anti-Polite-Stop 규칙

스토리 완료 후 멈추지 않고 즉시 다음 스토리로 진행합니다.
보고 시점:
- **전부 완료**: 모든 스토리 PASS + 최종 검증 통과
- **에스컬레이션**: 3회 실패
- **컨텍스트 한계**: 토큰 80% 사용

## Phase 3: 최종 검증

모든 스토리 passes: true 후:
1. 전체 빌드 + 테스트
2. Critic 에이전트 리뷰 (코드 패턴, 디버그 코드, 보안)
3. CRITICAL 이슈 -> 수정 스토리 추가 -> Phase 2 복귀
4. Compound-Out: 패턴 추출 제안

## 서킷 브레이커

| 브레이커 | 임계값 | 동작 |
|---------|--------|------|
| max_attempts_per_story | 3 | 에스컬레이션 |
| max_total_iterations | 30 | 강제 종료 + 상태 리포트 |
| same_error_repeat | 3회 | 접근법 변경 요구 |
| context_limit | 80% 토큰 | 상태 저장 + resume 안내 |

## 진행 상황 추적

```
FORGE-LOOP PROGRESS
═══════════════════
Story 1/4: User Authentication  [DONE] (1 attempt)
Story 2/4: Payment API          [IN PROGRESS] (attempt 2/3)
  |- AC1: POST /pay returns 200  [PASS]
  |- AC2: Webhook verification   [FAIL]
  +- AC3: Idempotency key        [PENDING]
Story 3/4: Error Handling        [PENDING]
Story 4/4: Tests                 [PENDING]
═══════════════════
```
</Steps>

<Failure_Modes>
NEVER: **PRD 없이 구현**: 스토리 분해를 먼저 수행합니다.

NEVER: **일반적 수용 기준**: "코드가 컴파일된다" -> 프로젝트 특화 기준으로 교체.

NEVER: **3회 실패 후 같은 접근**: 에스컬레이션하고 접근법을 변경합니다.

NEVER: **검증 스킵**: "should work"는 증거가 아닙니다. 실행하여 확인합니다.

NEVER: **중간 보고 (Polite-Stop)**: 스토리 완료 후 즉시 다음으로 진행합니다.

NEVER: **Compound 무시**: 시작 전과 각 스토리 전에 compound-search를 수행합니다.

NEVER: **디버그 코드 방치**: console.log, TODO, HACK, debugger 원천 차단.
</Failure_Modes>

<Output>
```
FORGE-LOOP COMPLETE
═══════════════════════════════════════════════════
Task: {task description}

STORIES
US-001: {title}  [DONE] ({N} attempts)
US-002: {title}  [DONE] ({N} attempts)

METRICS
Total: {N} stories, {N} iterations (avg {N.N}/story)
Build: PASS | Tests: {N} passed, 0 failed
Critic: {N} warnings, 0 critical

COMPOUND CANDIDATES
[troubleshoot] "{title}" -- {desc}
[pattern] "{title}" -- {desc}
compound에 저장하시겠습니까? [Y/n]
═══════════════════════════════════════════════════
```
</Output>

<Policy>
- 수용 기준은 구체적이고 검증 가능해야 합니다
- "should work"는 증거가 아닙니다 -- 반드시 실행
- 스토리 완료 후 즉시 다음 스토리 (Anti-Polite-Stop)
- 3회 실패 시 에스컬레이션
- 전체 완료 후 compound 추출 제안
- 서킷 브레이커 임계값 절대 무시 금지
</Policy>

<Arguments>
- `[task description]`: 실행할 작업 설명. 생략 시 현재 대화 컨텍스트에서 추론.
- `resume`: 이전에 중단된 루프를 재개합니다.
- `--goal-only` (또는 `--goal`, `--lock-only`): **goal-locking lightweight 모드**.
  Phase 1 (PRD + 수용 기준 + 상태 파일 저장) 까지만 실행하고 Phase 2/3 (자동
  실행 루프 + 최종 검증) 은 건너뜁니다. 산출물은 *구조화된 Goal 박스* — 작업
  범위 / 완료 기준 / 제약 / 검증 방법을 한 markdown 으로 박제. 사용자가 다른
  컨텍스트나 에이전트에 그대로 붙여 위임 가능. 추후 `forge-loop resume` 로
  자동 실행 사이클 escalate 가능 (상태 파일 재활용).

  goal-only 모드의 산출물 포맷:
  ```
  GOAL: <한 문장 요약>
  완료 기준 (Acceptance Criteria — 증거 타입 포함):
    - [ ] AC1: <테스트 로그 / 파일 변경 / dry-run 출력>
    - [ ] AC2: ...
  제약 (Out-of-Scope / 안 할 것):
    - <실 발송·배포·삭제 금지 / dry-run 한정>
    - <touch 안 할 경로>
  검증 방법:
    - <bash 명령 / 파일 확인 / 외부 verification>
  컴파운드 패턴 (참고):
    - <compound-search 결과 top 1-2>
  ```

  goal-only 모드는 stop-guard 의 fact-vs-agreement / self-score-inflation
  체크와 직접 연동 — Goal 박스 박제 후 응답이 "완료" 주장 시 AC 의 증거가
  포함되어야 통과.
</Arguments>

$ARGUMENTS
