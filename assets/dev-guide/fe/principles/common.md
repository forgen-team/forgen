---
title: 공통 FE 원칙 (프레임워크 중립)
version: 2026-05-18
sources:
  - sources/toss-ff/
  - sources/perf/
  - sources/a11y-dx/
---

# 공통 FE 원칙

> 모든 프론트엔드 코드(React/Vue/Vanilla)에 적용되는 합의 원칙.
> 프레임워크 특화 가이드는 [`react.md`](./react.md), [`vue.md`](./vue.md) 참조.

## 출처 우선순위 (충돌 시)

1. **코드 품질**: Toss Frontend Fundamentals 4원칙 (가독성 > 예측성 > 응집도 > 결합도 순으로 검토)
2. **성능**: web.dev Core Web Vitals 임계값 (LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1)
3. **접근성**: WCAG 2.2 AA (2023.10 W3C 권고)
4. 충돌 시 — 사용자 영향 큰 쪽 우선 (a11y > perf > 가독성).

---

## A. 코드 품질 4원칙 (Toss FF 기반)

각 원칙은 **트레이드오프 관계**다. 동시 만족 불가능 시 위 우선순위로 판단.

### A.1 가독성 (Readability) — 최우선

- **같이 실행되지 않는 코드는 분리**한다. 권한별 분기 한 컴포넌트 → 권한별 컴포넌트.
  근거: `sources/toss-ff/readability-submit-button.md`
- **구현 상세는 추상화**한다. 로그인 체크 로직 노출 → `<AuthGuard>` 래퍼.
  근거: `sources/toss-ff/readability-login-start-page.md`
- **로직 종류에 따라 함수를 쪼갠다**. "페이지 전체 쿼리파람 훅" 같은 다목적 훅 금지 → 파라미터별 독립 훅.
  근거: `sources/toss-ff/readability-use-page-state.md`
- **복잡한 조건에 이름 붙인다**. 중첩 `filter().some()` 익명 → `const isSameCategory = ...`.
  근거: `sources/toss-ff/readability-condition-name.md`
- **매직 넘버에 이름 붙인다**. `delay(300)` → `const ANIMATION_DELAY_MS = 300`.
- **시점 이동을 줄인다**. 3단계 이상의 객체 참조 추적 → 인라인 또는 1단계로 평탄화.
- **삼항 단순화**. 중첩 삼항 금지 → IIFE + early return.
- **수학 부등식 순서**. `b <= a && a <= c` (a를 가운데에).

### A.2 예측 가능성 (Predictability)

- **이름 충돌 회피**. 라이브러리 이름과 동일한 `http` 등 → `httpService.getWithAuth` 같은 구분자 부착.
- **같은 종류 함수는 반환 타입 통일**. 모든 데이터 훅은 React Query/SWR 등 *Query 객체* 반환으로 통일.
- **숨은 로직을 드러낸다**. `fetchBalance` 안에 logging 숨김 금지 → fetch는 fetch만, logging은 호출 측.

### A.3 응집도 (Cohesion)

- **함께 수정되는 파일은 같은 디렉토리에**. 모듈 종류별 flat 구조(`/components`, `/hooks`) 지양 → 도메인별 (`/order/components`, `/order/hooks`).
- **같이 변하는 상수는 한곳에 묶는다**. 애니메이션 길이 같은 결합 값을 분리하면 한쪽만 수정되는 버그 발생.
- **폼 응집 전략을 의도적으로 선택한다**. 필드 단위(react-hook-form) vs 폼 전체(zod) — 검증 요구사항에 따라.

### A.4 결합도 (Coupling)

- **책임 하나씩 관리**. 통합 훅은 수정 영향 범위가 폭발한다 → 책임별 분리.
- **중복을 허용하라**. 유사해 보이는 두 바텀시트의 공통화는 페이지별 분기를 만든다 → 차라리 중복.
  근거: `sources/toss-ff/coupling-use-bottom-sheet.md` (반직관적이지만 매우 중요)
- **Props Drilling 제거**. 3단 이상 prop 전달 → Composition (`children`) 또는 Context.

---

## B. 성능 (Core Web Vitals 2024)

### B.1 임계값 (75퍼센타일 기준)

| 지표 | Good | Poor | 측정 시점 |
|------|------|------|-----------|
| **LCP** (Largest Contentful Paint) | ≤ 2.5s | > 4.0s | 로드 |
| **INP** (Interaction to Next Paint) | ≤ 200ms | > 500ms | 인터랙션 |
| **CLS** (Cumulative Layout Shift) | ≤ 0.1 | > 0.25 | 로드~수명 |

> **INP는 2024년 3월 FID를 대체했다.** FID는 첫 입력만 봤지만 INP는 페이지 수명 전체의 모든 인터랙션 응답성을 본다.

### B.2 LCP 개선 우선순위 (4 하위 구성 요소)

근거: `sources/perf/03-lcp-cls.md`, `sources/perf/10-optimize-lcp.md`

1. **TTFB** (서버 응답 + 리다이렉트) — 평균 40%
2. **Resource Load Delay** (LCP 자원 발견까지) — `<link rel="preload">`, `fetchpriority="high"`
3. **Resource Load Time** (다운로드) — 이미지 최적화, CDN
4. **Render Delay** (렌더링) — 클라이언트 측 렌더링 최소화

### B.3 INP 개선

근거: `sources/perf/02-inp.md`

- **Input Delay → Processing → Presentation Delay** 3단계 중 가장 큰 단계 식별
- 200ms 이상 Long Task 분할: `scheduler.yield()` (지원 시) 또는 `setTimeout(0)`
- 이벤트 핸들러 안의 동기 작업 최소화. React 18+ 는 `startTransition`으로 우선순위 낮춤.

### B.4 CLS 방지

- 이미지/iframe/광고에 `width`/`height` 명시 (또는 CSS `aspect-ratio`)
- 동적 콘텐츠 삽입은 `min-height` 예약
- 폰트 `font-display: optional` 또는 `size-adjust` 사용

### B.5 네트워크/네비게이션 (선택)

- **Speculation Rules API** — `<script type="speculationrules">` 로 즉시 페이지 전환 (Chrome 109+)
  근거: `sources/perf/04-speculation-rules.md`
- **View Transitions API** — 페이지 전환 애니메이션 (Same-doc: Chrome 111+, Cross-doc: Chrome 126+)
  근거: `sources/perf/05-view-transitions.md`

---

## C. 접근성 (WCAG 2.2 AA)

근거: `sources/a11y-dx/wcag22-new-criteria.md`

### C.1 필수 (Level A/AA, 2.2 신규 9개 중 핵심)

| SC | 요건 | 코드/CSS 영향 |
|----|------|---------------|
| **2.4.11 Focus Not Obscured** (AA) | 포커스 받은 요소가 sticky header/footer에 가려지면 안 됨 | `scroll-padding-top` 등으로 보정 |
| **2.5.8 Target Size Minimum** (AA) | 인터랙티브 영역 최소 24×24 CSS px | 버튼/링크 `min-width/height: 24px` |
| **3.2.6 Consistent Help** (A) | 도움말 메커니즘의 위치/순서 일관성 | 헤더/푸터 도움말 위치 고정 |
| **3.3.7 Redundant Entry** (A) | 같은 정보 재입력 요구 금지 | 폼 자동 채움, autocomplete 속성 |
| **3.3.8 Accessible Authentication** (AA) | 인지 기능 의존 인증 금지 (CAPTCHA 등 대체 제공) | 패스키/생체/2FA 옵션 |
| **2.5.7 Dragging Movements** (AA) | 드래그 동작은 단일 포인터 대체 제공 | 드래그 슬라이더에 + / − 버튼 병행 |

### C.2 기존 핵심 (1.x / 2.x — 위반 시 즉시 픽스)

- **1.1.1 Non-text Content** — `<img alt>`, 장식 이미지는 `alt=""`
- **1.3.1 Info & Relationships** — 시멘틱 HTML (`<button>` vs `<div onClick>`)
- **1.4.3 Contrast (Minimum)** — 본문 4.5:1, 큰 글자 3:1
- **2.1.1 Keyboard** — 모든 기능 키보드 접근 가능
- **4.1.2 Name, Role, Value** — 폼 컨트롤 `<label>` 또는 `aria-label`

---

## D. 안티패턴 카탈로그 (리뷰에서 즉시 [HIGH] 잡아라)

| 안티패턴 | 근거 | 픽스 |
|----------|------|------|
| 빈 catch 블록 | global rules/anti-pattern | 최소 로그 또는 re-throw |
| 50줄 초과 함수 | global rules | 책임별 분리 |
| 중첩 깊이 5+ | global rules | early return |
| 같은 파일 3+회 수정 | global rules | 전체 재설계 |
| 명세 옵셔널 항목을 검증 로직에서 필수 취급 | 표시(UI)와 검증(로직) 불일치 → 라이브 데모 즉시 적발 | 명세→체크리스트→테스트 라인 매핑 |
| 매직 넘버 인라인 | FF 가독성 | 상수로 추출 |
| 통합 훅 (모든 쿼리파람 등) | FF 결합도 | 책임별 분리 |
| Props 3단 드릴링 | FF 결합도 | Composition 또는 Context |
| 라이브러리 이름 재사용 (`http`, `axios`, `query`) | FF 예측성 | 구분자 부착 |
| 이미지 `width/height` 없음 | CLS | 명시 또는 `aspect-ratio` |
| `<div onClick>` 버튼 흉내 | WCAG 1.3.1, 2.1.1 | `<button>` 사용 |
| 포커스 안 보이는 `outline: none` | WCAG 2.4.7 | `:focus-visible` 별도 스타일 |

---

## E. 워크플로우 원칙 (메타)

> 근거: 명세 위반으로 인한 코드 리뷰/과제 실패 패턴 누적 관찰.

1. **명세 → 체크리스트 → 코드 + 테스트 라인 매핑표** 를 우선 작성. 장문 ARCHITECTURE 문서보다 가치 있음.
2. **임의 UX 결정은 명세 100% 충족 후에만**. 명세가 모호한 부분은 *결정 전에* 명시적으로 질문.
3. **명세에서 "옵셔널"이라고 한 항목은 반드시 "안 골라도 통과" 테스트 작성**. 표시(UI 분기)와 검증(로직 분기)이 같은 진실을 보는지 점검.
4. **README/주석이 자랑하는 패턴(discriminated union, 특정 아키텍처 이름)과 실제 코드 결함 공존을 경계**. 자랑한 패턴은 가장 먼저 검증.
5. **도메인 직관이 명세 위에 올라가는 순간을 경계**. "당연히 이래야 한다" 가 등장하면 명세를 다시 펴라.
