---
name: fe-review-react
description: React/Next.js PR/diff를 사내 원칙 기반으로 리뷰. `[SEVERITY] file:line — 이슈` 형식으로 출력. 4원칙 + Web Vitals + WCAG 2.2 + React 19/Compiler 안티패턴 체크.
---

# fe-review (React)

> **호출 시점**: PR 링크, diff, 또는 변경된 파일 목록 받았을 때.
> **선행 로딩**: `principles/common.md` + `principles/react.md`.

## 0. 출력 형식 (반드시 준수)

```
[SEVERITY] path/to/file.tsx:42 — <한 줄 이슈>
  근거: principles/<doc>.md <섹션> 또는 sources/<file>.md
  픽스: <코드 또는 한 줄 처방>
```

**SEVERITY**: `HIGH` (즉시 픽스 / 머지 차단), `MED` (다음 PR 가능), `LOW` (취향/넛지).

리뷰 시작 시 한 줄 요약:
```
## 리뷰 요약
- 변경 범위: <files / +N -M>
- HIGH N개, MED N개, LOW N개
- 머지 가능 여부: [차단 / 권장 수정 후 / 가능]
```

## 1. 체크 순서 (위반 시 곧장 [HIGH])

### Phase 1 — 명세/요구사항 정합성 (가장 먼저)

- 요구사항 명세가 함께 제공됐는가? 없으면 다음 출처 후보를 사용자에게 *명시적으로 요청* 후 일시 중지:
  1. PR/MR 본문의 "Why / Spec" 섹션
  2. 연결된 이슈 (Linear/Jira/GitHub Issue)
  3. Notion/Confluence 명세 페이지 링크
  4. 디자인 명세 (Figma 코멘트 / 디자인 토큰 문서)
  5. 위 어디에도 없으면 *구두 합의 내용을 텍스트로 적어달라고* 요청
  → 명세 없는 리뷰는 "취향 코멘트" 가 된다. 받기 전에는 Phase 2 이후로 *진행하지 않는다.*
- 명세 옵셔널 항목이 검증 로직에서 필수 취급된 곳 없는가? (표시/검증 불일치 — 가장 흔한 명세 위반)
  → 점검 절차: 명세에서 "옵셔널" 단어를 grep → 해당 필드/옵션 → UI 분기 (`isRequired`, `disabled`) ↔ 검증 분기 (`return error`, `continue`) 가 **같은 진실을 보는가**.
- README/주석이 자랑하는 패턴이 실제 코드에서 누락된 곳은? (discriminated union 분기 누락 등)

### Phase 2 — React 19 / Next.js 16 안티패턴 (`principles/react.md` R9)

- [ ] `useEffect` 안에서 데이터 변환 / 체인 setState — [HIGH] 픽스: 렌더 중 파생값
- [ ] `useState` + `useEffect` 로 fetch — [HIGH] 픽스: Suspense + `use()` 또는 React Query
- [ ] Compiler 환경에서 수동 `useMemo`/`useCallback` 추가 — [MED] 픽스: 제거
- [ ] Client 컴포넌트가 Server 컴포넌트 import — [HIGH] 픽스: `children` prop 주입
- [ ] Server Component 안에 `useState`/`useEffect` — [HIGH] 픽스: `'use client'` 분리
- [ ] Form 상태 `useState` 수동 관리 (단순 폼) — [MED] 픽스: `<form action>` + `useActionState`
- [ ] `<img>` 직접 사용 — [HIGH] 픽스: `next/image` (또는 `width/height` 명시)
- [ ] 변경 액션 후 `revalidateTag`/`revalidatePath` 누락 — [HIGH] 픽스: 호출 추가
- [ ] `'use client'` 파일에 대형 의존성 import — [MED] 픽스: dynamic import 또는 Server 분리

### Phase 3 — 코드 품질 4원칙 (`principles/common.md` A)

가독성 > 예측성 > 응집도 > 결합도 순으로 검토.

- [ ] 같이 실행되지 않는 코드 분리 (권한/조건별 분기 한 컴포넌트) — [MED]
- [ ] 구현 상세 노출 (인증 체크 inline 등) — [MED] 픽스: `<AuthGuard>`
- [ ] 다목적 훅 (페이지 전체 쿼리파람 통합) — [HIGH] 픽스: 책임별 분리
- [ ] 익명 복잡 조건 — [LOW] 픽스: 명명된 변수
- [ ] 매직 넘버 — [LOW] 픽스: 상수
- [ ] 시점 이동 3단계+ — [MED] 픽스: 평탄화
- [ ] 중첩 삼항 — [LOW] 픽스: IIFE + if
- [ ] 부등식 순서 (`a >= b && a <= c`) — [LOW] 픽스: `b <= a && a <= c`
- [ ] 같은 종류 함수 반환 타입 불일치 — [MED] 픽스: 통일
- [ ] 숨은 로직 (fetch 안 logging 등) — [MED] 픽스: 책임 분리
- [ ] Props 3단 드릴링 — [HIGH] 픽스: Composition or Context
- [ ] 잘못된 공통화 (유사 컴포넌트 강제 추출) — [HIGH] 픽스: 중복 허용

### Phase 4 — Web Vitals (`principles/common.md` B)

- [ ] LCP 후보 이미지 `priority` 누락 — [HIGH]
- [ ] 이미지 `width/height`/`fill` 없음 → CLS — [HIGH]
- [ ] 메인 스레드 Long Task (>200ms) 동기 계산 — [MED] 픽스: `startTransition` 또는 chunk 분할
- [ ] `useOptimistic` 사용 가능 인터랙션에 미적용 (좋아요/메시지 등) — [LOW]
- [ ] `font-display` 미설정 → 폰트 깜빡임 → CLS — [MED]

### Phase 5 — 접근성 (`principles/common.md` C, WCAG 2.2)

- [ ] `<div onClick>` 또는 `<span onClick>` — [HIGH] 픽스: `<button>`
- [ ] **사내/외부 wrapper 컴포넌트에 `onClick`** (`<Card onClick>`, `<Icon onClick>`, `<ListRow onClick>`) — [MED→HIGH] 내부 구현이 `<div>` 면 키보드 접근 불가. 1회 확인 절차:
  1. wrapper 컴포넌트 정의 파일 열기 → 루트 엘리먼트 확인
  2. `<button>` 또는 `role="button"` + `tabIndex={0}` + `onKeyDown` (Enter/Space) 있으면 OK
  3. 아니면 사내 a11y 프리미티브(`<Clickable>` 등)로 감싸거나 `<button>` 사용
- [ ] `<button>` 에 `type` 누락 (form 내부) — [MED] 픽스: `type="button"` 또는 `"submit"`
- [ ] 폼 컨트롤 `<label>` 누락 — [HIGH]
- [ ] 인터랙티브 영역 < 24×24 CSS px — [MED] (WCAG 2.5.8)
- [ ] `outline: none` 만 있고 `:focus-visible` 대안 없음 — [HIGH] (WCAG 2.4.7)
- [ ] 이미지 `alt` 누락 또는 부정확 — [HIGH]
- [ ] 텍스트 대비 4.5:1 (본문) / 3:1 (큰 글자) 미만 — [HIGH]
- [ ] 모달 focus trap 누락 — [HIGH]
- [ ] sticky header 가 포커스 가림 (WCAG 2.4.11) — [MED] 픽스: `scroll-padding-top`

### Phase 6 — 보안/안전 (전역 규칙)

- [ ] `.env`/credential 커밋 — [HIGH] 즉시 차단
- [ ] `dangerouslySetInnerHTML` + 외부 입력 — [HIGH] sanitize 필요
- [ ] 빈 catch 블록 — [HIGH] 최소 로그 또는 re-throw
- [ ] eslint-disable / @ts-ignore 무근거 — [MED] 사유 주석 필요

### Phase 7 — 안티패턴 일반 (전역 규칙)

- [ ] 50줄 초과 함수 — [MED] 분리
- [ ] 중첩 깊이 5+ — [MED] early return
- [ ] 같은 파일 3+ 회 수정 흔적 (PR 내) — [MED] 전체 재설계 권고

## 2. 우선순위 충돌 시

- a11y vs 가독성 → a11y 우선
- 성능 vs 가독성 → 사용자 영향 큰 쪽 (LCP/INP 결정적 개선이면 성능)
- React Compiler vs 명시적 메모 → Compiler 환경이면 자동, 아니면 명시적 유지

## 3. 출력 예시

```
## 리뷰 요약
- 변경 범위: src/pages/order/* 8 files +312 -45
- HIGH 3개, MED 5개, LOW 2개
- 머지 가능 여부: 차단

[HIGH] src/pages/order/OrderForm.tsx:88 — select 옵션 옵셔널인데 검증에서 차단
  근거: principles/common.md D (안티패턴 카탈로그)
  픽스: optionRules.ts에서 `opt.type !== 'grid'` 분기 `continue`

[HIGH] src/components/HeroImage.tsx:12 — <img> 직접 사용
  근거: principles/react.md R8
  픽스: next/image + priority + sizes

[MED] src/hooks/usePageState.ts:1 — 쿼리파람 통합 훅 (다목적)
  근거: principles/common.md A.4, sources/toss-ff/coupling-use-page-state.md
  픽스: 파라미터별 독립 훅으로 분리 (useOrderId, useFilter ...)
```

## 4. 관련 문서

- [`principles/common.md`](../../principles/common.md), [`principles/react.md`](../../principles/react.md)
- [`fe-build/SKILL.md`](../fe-build/SKILL.md), [`fe-perf/SKILL.md`](../fe-perf/SKILL.md)
- 안티패턴 카탈로그: `principles/common.md` D + `principles/react.md` R9
