# Guard Design Checklist

새로운 stop-guard / pre-tool-use / pre-compact 가드를 추가할 때 PR 단계에서 강제로 통과해야 하는 체크리스트.

## 배경

Pathfinder D9 (2026-04-30): F1 self-score-inflation, F2 fact-vs-agreement, F3 conclusion-verification-ratio 세 가드 모두 raw `lastMessage` 에 regex 직접 적용 → observer XML / 인용 본문에서 false-positive 발화. 본 결함의 *근본 원인*은 가드 추가 절차에 "입력 텍스트의 출처/형식을 분류한다" 단계가 institutionalized 안 됐던 것 (Deep Interview Round 2).

이 체크리스트는 미래 가드가 같은 결함을 재생산하지 않도록 PR 머지 전 강제.

## Input Taxonomy (필수)

가드가 검사하는 텍스트의 출처를 분류하라:

- [ ] **Source layer**: stop-guard / pre-tool-use / pre-compact / user-prompt-submit / explicit invocation 중 어느 hook?
- [ ] **Producer**: Claude 자연 응답 / observer hook 산출 / skill 산출 / 사용자 입력 / 외부 도구 stdout — 어느 것이 가드 입력으로 들어오나?
- [ ] **Format mix**: structured XML(`<observation>`, `<summary>`)이 섞일 가능성? 코드블록(`backtick`/fenced)이 섞일 가능성? 사용자 인용 본문?

## Sanitization Decision (필수)

체크 적용 *전*에 입력을 정화할지 결정하라:

- [ ] `src/checks/_shared/text-sanitizer.ts`의 `sanitizeForGuard` 가 이 가드 입력에도 적용되는가?
- [ ] 아니라면 — 이 가드의 텍스트 도메인이 sanitizer 의 STRUCTURED_TAGS / inline-quote 가정과 다른가? 그 다름이 어떤 새 면제 룰을 요구하는가?
- [ ] 직인용("...") 경고 어휘를 사용하는 가드의 경우, **Self-paradox 회귀 테스트** 필수: 가드 트리거 어휘 자체를 인용한 본문이 가드를 발화시키지 않는지 확인하는 fixture.

## Self-Application Audit (필수)

forgen-itself의 산출물(release note / e2e-result.json / compound stats / README)에 본 가드를 적용할 의도인가?

- [ ] **Default: No** — `forgen은 user-mirror, self-mirror 아님` 원칙(Deep Interview Round 4 Contrarian) 에 따라 forgen-itself 는 면제 정상.
- [ ] **Yes 라고 답하려면** — self-paradox 가 발생하지 않는다는 증거(테스트 fixture)와 user-mirror 원칙을 깨야 하는 정당화 사유 필요.

## False-Positive Budget (필수)

- [ ] 가드 출시 후 1주일 동안 violations.jsonl 의 *FP 비율* 측정 계획. 임계: FP 30% 초과 시 가드 비활성화 또는 sanitizer 보강 필수.
- [ ] FP 측정 방법: violations.jsonl 의 message_preview 를 카테고리(structured-output / quoted-trigger / true-positive)로 분류하는 1회성 스크립트.

## Test Fixtures (필수)

- [ ] **TP 보존 케이스**: 가드가 막아야 할 자연 산문 예제 ≥ 3
- [ ] **FP 회귀 케이스**: 다음 시나리오 모두 가드 *비발화*로 검증:
  - [ ] `<observation>...</observation>` 본문 안에 트리거 어휘
  - [ ] backtick 인라인 코드 안에 트리거 어휘
  - [ ] 짧은 직인용("...") 안에 트리거 어휘
- [ ] **Self-application 면제 케이스**: 가드 자기 발화 메시지를 다시 입력으로 넣어도 가드가 자기 자신을 잡지 않는지 검증

## Wiring (필수)

- [ ] `stop-guard.ts` 의 `CHECKS` 배열에 항목 추가 (단순 push, 새 보일러플레이트 작성 금지)
- [ ] `recordViolation` rule_id naming: `builtin:<short-id>` 컨벤션 준수
- [ ] `kind`: `block` / `correction` / `alert` 중 명시적 선택

## 머지 게이트

- [ ] vitest pass
- [ ] Docker e2e pass (`~/.forgen/state/e2e-result.json` 1시간 이내 갱신)
- [ ] 본 체크리스트 모든 항목 체크
- [ ] PR 본문에 Input Taxonomy 절 4문장 이상 작성

---

## 참고 — 결함 클래스 인터프리터 (Deep Interview 2026-04-30)

| 클래스 | 정의 | 인스턴스 |
|---|---|---|
| process gap | 절차 institutionalized 안 됨 | D9 (이 체크리스트가 fix) |
| wiring gap | 입력 신호 회로 누락 | D11 (compound usage signal) |
| drift gap | 일부 컴포넌트가 본체 진화에 낙오 | D12 (skill catalog) |
| scope gap | 검증 범위에 의도적 미포함 | D10 retract — 결함 아님 |

새 결함 발견 시 위 4 클래스로 분류하고 fix 패밀리를 결정한다.
