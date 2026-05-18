---
title: React 19 FE 가이드 문서 인덱스
fetched: 2026-05-18
---

# React 19 핵심 문서

| 파일 | 제목 | 카테고리 | 소스 |
|------|------|----------|------|
| [use-hook.md](./use-hook.md) | `use()` Hook | api | https://react.dev/reference/react/use |
| [use-action-state.md](./use-action-state.md) | `useActionState` | api | https://react.dev/reference/react/useActionState |
| [use-optimistic.md](./use-optimistic.md) | `useOptimistic` | api | https://react.dev/reference/react/useOptimistic |
| [use-form-status.md](./use-form-status.md) | `useFormStatus` / `<form action={}>` | api | https://react.dev/reference/react-dom/hooks/useFormStatus |
| [server-components.md](./server-components.md) | Server Components | rsc | https://react.dev/reference/rsc/server-components |
| [server-functions.md](./server-functions.md) | Server Functions (`'use server'` / `'use client'`) | rsc | https://react.dev/reference/rsc/server-functions |
| [suspense.md](./suspense.md) | Suspense & Streaming | suspense | https://react.dev/reference/react/Suspense |
| [react-compiler.md](./react-compiler.md) | React Compiler (자동 메모이제이션) | compiler | https://react.dev/learn/react-compiler |
| [no-effect-patterns.md](./no-effect-patterns.md) | Effect 회피 패턴 | patterns | https://react.dev/learn/you-might-not-need-an-effect |
| [keeping-components-pure.md](./keeping-components-pure.md) | 컴포넌트 순수성 유지 | patterns | https://react.dev/learn/keeping-components-pure |

## 카테고리별 분류

### API (React 19 신 Hook)
- `use()` — Promise/Context 읽기, 조건부 호출 가능
- `useActionState` — Action 결과로 state 관리, form 제출
- `useOptimistic` — 낙관적 UI 업데이트
- `useFormStatus` — 부모 form 제출 상태 읽기

### RSC (React Server Components)
- Server Components — 서버 전용 렌더링, async/await 직접 사용
- Server Functions — `"use server"` 함수, form action에 직접 전달

### Suspense & Streaming
- 중첩 Suspense로 순차 스트리밍, startTransition으로 fallback 방지

### Compiler
- 자동 메모이제이션 — `useMemo`/`useCallback` 수동 작성 불필요

### Patterns (리뷰 핵심)
- Effect 회피 패턴 — 불필요한 Effect 제거
- 컴포넌트 순수성 — 렌더 중 side effect 금지
