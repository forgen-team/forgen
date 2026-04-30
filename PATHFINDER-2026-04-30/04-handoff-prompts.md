# Handoff Prompts (`/make-plan` ready)

## System 1: text-sanitizer + stop-guard 디스패처 통합

```
/make-plan

목표: stop-guard 3종 체크 (F1 self-score-inflation, F2 fact-vs-agreement, F3 conclusion-verification-ratio)의 false-positive 58%를 해결하는 단일 sanitizer 레이어 + 디스패처 도입.

플로우차트 참조: PATHFINDER-2026-04-30/01-flowcharts/F4-stop-guard-orchestration.md
중복 근거: PATHFINDER-2026-04-30/02-duplication-report.md (D4, D5, D7)
통합 사양: PATHFINDER-2026-04-30/03-unified-proposal.md (섹션 1, 4)

만들어야 할 것:
- src/checks/_shared/text-sanitizer.ts (신규, ~50 LOC)
  * sanitizeForGuard(raw: string): string
  * STRUCTURED_TAGS: observation, summary, request, investigated, completed, next-steps, title, subtitle
  * inline backtick / fenced code / 짧은 직인용("…") stripping

리팩토링할 호출 사이트:
- src/hooks/stop-guard.ts:528-582 → CHECKS 배열 + for-loop 디스패처로 대체
  * 기존 3중 보일러플레이트(535-547, 553-565, 572-581) 제거
  * sanitizeForGuard(lastMessage) 1회 적용 후 모든 체크에 전파

테스트 (TDD red-green):
- tests/checks/text-sanitizer.spec.ts:
  1. <observation>...</observation> 본문이 제거되는가 (D4 회귀 테스트)
  2. inline `4/10` 코드는 stripping 되는가 (D5 회귀 테스트)
  3. "신뢰도 95/100" 같은 진짜 점수는 보존되는가 (TP 보존)
- tests/hooks/stop-guard.test.ts: 디스패처가 3 체크를 순서대로 호출하고 첫 block에서 종료하는지

회귀 검증:
- violations.jsonl 과거 36건 self-score 케이스를 fixture로 재실행 → TP 13건은 여전히 block, FP 21건은 통과
- 기존 vitest 2356/2356 PASS 유지

안티패턴 가드:
- ❌ feature flag로 sanitizer 점진 도입 (즉시 적용)
- ❌ 체크별 sanitizer 옵션화 (단일 정책)
- ❌ registry/factory 패턴 (배열 + for-loop 충분)

완료 조건:
- vitest pass
- Docker e2e (~/.forgen/state/e2e-result.json) 1시간 이내 재생성 + passed:true
- false-positive 회귀 테스트 신규 5건 이상 추가
```

---

## System 2: measurement + keyword-catalog 통합

```
/make-plan

목표: F1/F2 사이의 MEASUREMENT_TOOLS 클론 + F2/F3 사이의 fact/conclusion 키워드 부분 중복을 단일 _shared 모듈로 흡수.

중복 근거: PATHFINDER-2026-04-30/02-duplication-report.md (D1, D2, D3, D6)
통합 사양: PATHFINDER-2026-04-30/03-unified-proposal.md (섹션 2, 3)

만들어야 할 것:
- src/checks/_shared/measurement.ts (신규, ~15 LOC)
  * export MEASUREMENT_TOOLS = new Set(['Bash', 'NotebookEdit'])
  * countMeasurements(recentTools): number
  * hasEnoughMeasurements(recentTools, min=1): boolean
- src/checks/_shared/keyword-catalog.ts (신규, ~80 LOC)
  * KEYWORDS: { tag: 'fact'|'conclusion'|'verification'|'softener'|'score-inflation', pattern: RegExp, lang: 'en'|'ko' }[]
  * findByTag(text, tag, max=3): string[]
  * countByTag(text, tag): number

리팩토링할 호출 사이트:
- src/checks/self-score-deflation.ts:32-34, 108 → import from _shared/measurement.ts
- src/checks/fact-vs-agreement.ts:26-29, 105 → import from _shared/measurement.ts
- src/checks/fact-vs-agreement.ts:32-43, 83-91 → findByTag(text, 'fact')
- src/checks/conclusion-verification-ratio.ts:19-30, 33-46, 48-55 → countByTag(text, 'conclusion')/'verification'

D3 결정: conclusion 키워드 = fact 키워드 ∪ {done, ready, shipped, finished, complete, LGTM}
  → conclusion 카운트 시 fact 태그 + conclusion-only 태그 합산. 어휘 카탈로그 단일 진실로 정렬.

테스트 (TDD):
- tests/checks/_shared/measurement.spec.ts: countMeasurements 단위
- tests/checks/_shared/keyword-catalog.spec.ts: findByTag/countByTag 태그별
- 기존 self-score-deflation.spec / fact-vs-agreement.spec / conclusion-verification-ratio.spec 모두 통과 (행동 변화 없음 보증)

회귀 검증:
- vitest 2356/2356 유지
- Docker e2e passed
- conclusion-verification-ratio False-positive 사례 (있다면) 재현 fixture 추가

안티패턴 가드:
- ❌ "확장성 위해 KeywordTag enum을 추상 인터페이스로" — 단순 union type
- ❌ "measurement-tools.json 외부 설정 파일" — 코드 상수가 충분
- ❌ "체크 양쪽에 deprecated alias 유지" — 호출 사이트 즉시 교체

선후 관계: System 1과 독립적으로 진행 가능. 둘 다 끝난 뒤 src/checks/ 트리가 _shared/와 함께 정렬됨.

완료 조건:
- vitest pass
- Docker e2e passed
- 두 체크 (.ts) 파일 LOC 합계가 통합 전 대비 25% 이상 감소
```

---

## System 3 (보조 트랙, 본 사이클 외): F5/F6 핫스팟

본 pathfinder 스코프 밖. 다음 retro 사이클에 별도 `/forgen:retro` + `/claude-mem:pathfinder` 사이클 권고:

- `auto-compound-runner.ts` (8 mods/week, 617 LOC) — 자체 dedup vs MCP compound 책임 경계
- `cli.ts` (8 mods/week, 567 LOC) — command 라우터 분리 검토

이번 작업 완료 후 별도 트랙으로 추적할 것을 권고함.
