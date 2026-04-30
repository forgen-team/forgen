# Duplication Report

## D1. MEASUREMENT_TOOLS Set — 정확한 클론

**증거**:
- `src/checks/self-score-deflation.ts:32-34` — `MEASUREMENT_TOOLS = new Set(['Bash', 'NotebookEdit'])`
- `src/checks/fact-vs-agreement.ts:26-29` — `MEASUREMENT_TOOL_CATEGORIES = new Set(['Bash', 'NotebookEdit'])`

변수명만 다르고 값/의도 100% 동일. 두 파일이 v0.4.1 coverage fix 주석을 똑같이 복붙해놓음. 기준이 바뀌면 두 군데 동시 수정 필요 — drift 위험.

**판정**: 우발적 중복 (specialization 아님). 통합 대상.

---

## D2. measurement counting expression — 정확한 클론

**증거**:
- `self-score-deflation.ts:108` — `recentTools.filter((t) => MEASUREMENT_TOOLS.has(t)).length`
- `fact-vs-agreement.ts:105` — `recentTools.filter((t) => MEASUREMENT_TOOL_CATEGORIES.has(t)).length`

식까지 동일. 한 줄 helper(`countMeasurements(recentTools)`)로 합쳐야 함.

**판정**: 우발적 중복. 통합 대상.

---

## D3. fact-assertion 키워드 ↔ conclusion 키워드 — 의미 클론

**증거**:
- `fact-vs-agreement.ts:32-43` `FACT_ASSERTION_PATTERNS`:
  `pass`, `verified`, `confirmed`, `validated`, `통과`, `검증`, `동작`, `성공`, `완료`, `all tests pass`
- `conclusion-verification-ratio.ts:19-30` `CONCLUSION_PATTERNS`:
  `pass`, `done`, `ready`, `shipped`, `finished`, `complete`, `LGTM`, `confirmed`, `verified`, `validated`, `통과`, `완료`, `성공`, `동작`

겹치는 어휘: `pass`, `verified`, `confirmed`, `validated`, `통과`, `완료`, `성공`, `동작` (8개). F2 셋이 F3 셋의 부분집합. 한쪽 추가 시 다른 쪽도 동기화해야 의미 일관 — 현재 동기화 메커니즘 없음.

**판정**: 의미적으로 부분 중첩(specialization 일부 + 우발적 중복 일부). 단일 키워드 카탈로그 + 태그 분류로 통합 가능.

---

## D4. 구조화 출력 면제 부재 — 공통 결함 (단일 결함이 N곳에 발현)

**증거 (violations.jsonl 발화 통계)**:
- `self-score-inflation` 36건 중 18건이 `<observation>`/`<summary>` XML 본문에 발화 (50% FP)
- `fact-vs-agreement` 34건 중 5건 이상이 동일 XML 본문에 `verified/confirmed` 매칭으로 발화
- 두 체크 모두 `lastMessage` raw에 regex 직접 적용. structured-output sentinel(`<observation>`, `<summary>`, `<request>`, `<title>`)을 stripping 하는 단계 없음

위치 일치:
- `stop-guard.ts:534` (F1 호출) — `text: lastMessage`
- `stop-guard.ts:552` (F3 호출) — `text: lastMessage`
- `stop-guard.ts:572` (F2 호출) — `text: lastMessage`

**판정**: 구조 결함. specialization 아님. 단일 sanitizer가 stop-guard 입력 단계에 들어가야 함.

---

## D5. self-paradox (regex pattern 자기 인용 시 자기 매칭) — 공통 결함

**증거**:
- F1: 본 응답에서 `"4/10"` 문자열을 인용해 설명하면 `\b\d+\s*\/\s*(10|100)\b` 패턴이 인용된 리터럴 자체를 매칭 (이번 세션에서 4회 연속 재현)
- F2/F3: 본 응답에서 `verified/confirmed` 키워드를 따옴표로 인용해도 동일 매칭

**근본 원인**: 어떤 regex check든 자기 자신의 트리거 어휘를 *설명할 때* 면제 메커니즘이 없음. 코드 리뷰/디버깅/메타 대화에서 가드가 무력화됨.

**판정**: 구조 결함. 인용/코드블록(`backtick`/`quoted text`)을 sanitizer에서 제거하면 D4와 함께 해결 가능 — 같은 sanitizer 레이어에 합쳐짐.

---

## D6. findMatches helper — 거의 같은 함수 두 개

**증거**:
- `self-score-deflation.ts:84-95` `findScoreSignals` — `re.exec` 루프, max 3
- `fact-vs-agreement.ts:83-91` `findMatches` — `text.match` 단발, max 3

목적/시그니처/cap 동일. 구현 디테일만 다름(전자는 모든 매치 수집, 후자는 첫 매치만). F2도 모든 매치를 봐야 정확하므로 후자가 버그성 단축. 통합하면서 전자 구현으로 수렴해야 함.

**판정**: 우발적 중복 + 잠재 버그. 통합 대상.

---

## D7. stop-guard wiring 보일러플레이트 3중 복붙

**증거**: `stop-guard.ts`
- 535-547: F1 block 처리 (12 lines)
- 553-565: F3 block 처리 (12 lines, 거의 동일)
- 572-580: F2 alert 기록 (8 lines)

각 블록은 `recordViolation({rule_id, session_id, source:'stop-guard', kind, message_preview})` + reasonText 포맷 + `blockStop` 호출. rule_id와 reason source만 다름. 새 체크 추가 시 또 한 블록 복사 — N+1 패턴.

**판정**: 우발적 중복. `runCheck(check, kind)` 디스패처 한 함수로 합쳐야 함.

---

## D8. F5/F6 핫스팟 점검 (보조)

**`auto-compound-runner.ts` (8 mods/week)**: 자체 dedup 로직(`isDuplicate` line 102, `mergeOrCreateBehavior` line 198) 보유. compound 외부 시스템(`mcp__forgen-compound__*`)과 dedup 책임 분담 모호 — 하지만 stop-guard 결함 패밀리와 관련 없음. **별도 트랙으로 분리.**

**`cli.ts` (8 mods/week)**: command 추가 회전이 잦은 진입점. 567 LOC 단일 파일. 라우터 분리 검토 가치 있으나 stop-guard 트랙과 독립. **별도 트랙으로 분리.**

본 분석 스코프 외 — 다음 retro 사이클로 이관 권고.
