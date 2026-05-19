---
title: React 19 + Next.js 16 원칙
version: 2026-05-18
sources:
  - sources/react/
  - sources/perf/06-nextjs-caching.md
  - sources/perf/07-server-components.md
  - sources/perf/08-ppr.md
---

# React 19 + Next.js 16 원칙

> [공통 원칙](./common.md)을 먼저 따르고, 아래는 React/Next 특화.

## R0. 의사결정 우선순위

1. **Server Component 기본, Client는 필요할 때만** (Next.js App Router)
2. **React Compiler가 자동 메모이제이션** — `useMemo`/`useCallback` 수동 작성 지양
3. **Effect 회피** — `useEffect`는 *외부 시스템 동기화* 용도. 데이터 변환/이벤트 처리에 쓰지 않는다.
4. **Action + form 통합** — `<form action={...}>` 와 `useActionState` 우선, 수동 상태 관리 지양

---

## R1. Server vs Client Components

근거: `sources/perf/07-server-components.md`, `sources/react/server-components.md`

### Server Component 기본값

- 모든 컴포넌트는 RSC가 기본. `'use client'` 안 붙이면 서버.
- 서버에서만: `async`/`await` 직접 사용, DB 접근, 환경변수, 대용량 라이브러리(markdown/syntax-highlight 등)

### Client Component 가 필요한 신호

- `useState`/`useReducer`/`useEffect`
- 브라우저 API (`window`, `localStorage`, `IntersectionObserver`)
- 이벤트 핸들러 (`onClick`, `onChange`)
- 커스텀 훅 사용

### 패턴

- **Client 컴포넌트 안에 Server 컴포넌트를 자식으로 주입**한다 (`children` prop). RSC → Client 역방향 import 금지.
- **환경 오염 방지**: 서버 전용 코드는 `'server-only'` 패키지로 클라이언트 import 차단.

---

## R2. Effect 회피 (you-might-not-need-an-effect)

근거: `sources/react/no-effect-patterns.md`

| 잘못된 Effect | 대체 |
|---------------|------|
| props/state 기반 파생 값 계산 | 렌더 중 계산. 비싸면 `useMemo` (Compiler 시 자동) |
| 이벤트 핸들러 로직을 Effect로 옮김 | 이벤트 핸들러 안에서 처리 |
| state 변경 시 다른 state 갱신 (체인) | 한 핸들러 안에서 둘 다 갱신 |
| 상위 변경 알림 (`useEffect(() => onChange(value), [value])`) | 변경 발생 핸들러 안에서 `onChange` 호출 |
| props 변경 시 state 초기화 | `key` prop 으로 컴포넌트 리마운트 |
| 데이터 페칭 | React Query/SWR 또는 Suspense + `use()` |

**남는 Effect 용도**: 외부 시스템 구독 (WebSocket, IntersectionObserver, 브라우저 API).

---

## R3. React 19 신 API

### R3.1 `use()` — Promise/Context 읽기

근거: `sources/react/use-hook.md`

- 조건부 호출 가능 (Hook 규칙 예외)
- Suspense 경계와 함께 사용
- Server Component 의 `async`/`await` 가 안되는 Client 컴포넌트에서 데이터 읽기 용도

### R3.2 `<form action>` + `useActionState` + `useFormStatus`

근거: `sources/react/use-action-state.md`, `sources/react/use-form-status.md`

```tsx
'use client';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

function SubmitButton() {
  const { pending } = useFormStatus();
  return <button disabled={pending}>{pending ? '제출 중...' : '제출'}</button>;
}

export function Form({ action }: { action: (state, fd) => Promise<State> }) {
  const [state, formAction] = useActionState(action, { error: null });
  return (
    <form action={formAction}>
      <input name="email" />
      {state.error && <p role="alert">{state.error}</p>}
      <SubmitButton />
    </form>
  );
}
```

- 폼 라이브러리 도입 전 우선 검토. 단순 폼은 의존성 0로 가능.

### R3.3 `useOptimistic` — 낙관적 UI

근거: `sources/react/use-optimistic.md`

- 서버 응답 전 즉시 UI 반영, 실패 시 자동 롤백
- 메시지 전송, 좋아요 토글 같은 인터랙션 INP 개선에 결정적

---

## R4. React Compiler

근거: `sources/react/react-compiler.md`

- **`useMemo`/`useCallback`/`memo` 를 수동으로 쓰지 마라**. Compiler가 자동 메모이즈한다.
- 도입 시 ESLint plugin (`eslint-plugin-react-compiler`) 으로 Rules of React 위반 검출.
- Compiler가 메모이즈 못 하는 코드 → "왜 메모 못 했는지" 진단하고 수정. 수동 useMemo 회피.
- **예외**: Compiler 미적용 프로젝트는 기존대로 명시적 메모이제이션 유지.

---

## R5. Suspense + Streaming

근거: `sources/react/suspense.md`

- Suspense 경계를 **데이터 단위가 아니라 사용자 인식 단위**로 그어라. "이 부분 따로 보여도 되나?" 기준.
- 중첩 Suspense → 순차 스트리밍. 상위가 늦으면 하위 모두 대기.
- `startTransition` 으로 후속 인터랙션에서 fallback 깜빡임 방지.

---

## R6. Next.js 16 캐싱 4계층

근거: `sources/perf/06-nextjs-caching.md`

| 계층 | 위치 | 무효화 |
|------|------|--------|
| **Request Memoization** | 단일 렌더 중 fetch 중복 제거 | 자동 (렌더 종료) |
| **Data Cache** | 서버, 영구 | `revalidateTag` / `revalidatePath` / time |
| **Full Route Cache** | 빌드 또는 ISR | `revalidatePath` |
| **Router Cache** | 클라이언트, 세션 | 네비게이션 / `router.refresh()` |

- `fetch(url, { next: { tags: ['posts'], revalidate: 60 } })` 표준
- `unstable_cache` / `use cache` (Next 16) — 외부 데이터 함수 캐싱
- **변경 액션 후 반드시 `revalidateTag('posts')` 호출** (캐시 일관성)

---

## R7. PPR (Partial Prerendering)

근거: `sources/perf/08-ppr.md`

- 정적 shell + Suspense 경계로 동적 부분 스트리밍
- Next.js 16의 `cacheComponents` 플래그 (PPR + use cache + dynamicIO 통합)
- 정적 캐시 가능한 부분이 큰 페이지 (상품 상세, 게시글)에서 TTFB·LCP 결정적 개선

---

## R8. 이미지 (next/image)

근거: `sources/perf/09-nextjs-image.md`

- LCP 후보 이미지에 `priority` (`fetchpriority="high"` + preload)
- `fill` + 컨테이너 `position: relative` 또는 `width`/`height` 명시 (CLS 방지)
- `sizes` 로 반응형 이미지 정확히 명세 — 미명세 시 1배 이미지가 모바일에 다운로드됨
- `placeholder="blur"` 는 LCP 미세 개선 + UX 향상

---

## R9. React 안티패턴 카탈로그

| 안티패턴 | 픽스 |
|----------|------|
| `useEffect` 안에서 `setState` 후 데이터 변환 | 렌더 중 파생 값 계산 |
| `useState` + `useEffect` 로 fetch | Suspense + `use()` 또는 React Query |
| Compiler 환경에서 수동 `useMemo` 추가 | 제거. Compiler 못 메모하면 코드 수정 |
| Client 컴포넌트가 Server 컴포넌트 import | `children` prop 으로 주입 |
| Server Component 안에 `useState` | `'use client'` 추가 또는 분리 |
| `'use client'` 파일에 대형 의존성 import | Server 분리 또는 dynamic import |
| Form 상태를 `useState` 로 수동 관리 | `<form action>` + `useActionState` |
| `Image` 없이 `<img>` | `next/image` (또는 명시적 `width/height`) |
| `next/dynamic` 남발 | RSC가 더 적합한지 먼저 검토 |
| Effect 안에서 `router.push` | 이벤트 핸들러로 이동 |
