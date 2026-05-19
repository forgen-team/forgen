---
title: PPR — Partial Prerendering (부분 프리렌더링)
source: https://nextjs.org/docs/app/api-reference/next-config-js/ppr
fetched: 2026-05-18
category: caching
---

## 개요

PPR(Partial Prerendering)은 단일 라우트에서 **정적 콘텐츠(HTML shell)**와 **동적 콘텐츠(스트리밍)**를 혼합한다.
빌드 시 정적 shell을 즉시 제공하고, 동적 부분은 준비되는 대로 스트림.

**Next.js 16**: `cacheComponents: true` 설정 시 PPR이 App Router 기본 동작.
`experimental.ppr` 플래그와 `experimental_ppr` 라우트 세그먼트 설정은 제거됨.

---

## 활성화 (Next.js 16)

```typescript
// next.config.ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  cacheComponents: true,  // PPR + use cache + dynamicIO 통합 활성화
}

export default nextConfig
```

---

## 동작 원리

```
요청 수신
    ↓
정적 HTML shell → 즉시 응답 (TTFB 최소화)
    ↓
동적 콘텐츠 → Suspense 경계를 통해 스트리밍
    ↓
최종 완성된 페이지
```

---

## Suspense로 정적/동적 경계 설정

```tsx
// app/page.tsx
import { Suspense } from 'react'
import { StaticContent } from './static-content'
import { DynamicFeed } from './dynamic-feed'

export default function Page() {
  return (
    <main>
      {/* 정적 — 빌드 시 HTML에 포함 */}
      <StaticContent />

      {/* 동적 — Suspense 경계 안에서 스트리밍 */}
      <Suspense fallback={<FeedSkeleton />}>
        <DynamicFeed />
      </Suspense>
    </main>
  )
}
```

```tsx
// dynamic-feed.tsx
async function DynamicFeed() {
  // 이 함수는 request time에 실행됨 (cookies, headers 등 사용 가능)
  const feed = await getUserFeed()
  return <Feed items={feed} />
}
```

---

## use cache 지시어와 함께 사용

```tsx
// cacheComponents 활성화 시 컴포넌트/함수 레벨 캐싱
async function CachedSidebar() {
  'use cache'
  const nav = await getNavigation()  // 캐시됨 (정적 shell에 포함)
  return <Sidebar items={nav} />
}

async function DynamicUserPanel() {
  // use cache 없음 → 동적 (스트리밍)
  const user = await getCurrentUser()
  return <UserPanel user={user} />
}
```

---

## Activity 기반 네비게이션 (cacheComponents 활성화 시)

React `<Activity>` 컴포넌트로 클라이언트 네비게이션 시 이전 라우트 상태 보존:
- 라우트 이동 시 이전 라우트를 unmount 대신 `"hidden"` 모드로 전환
- 뒤로 가기 시 상태 그대로 복원 (form 입력, 스크롤 위치 등)
- `"hidden"` 상태에서 effects 정리, 복귀 시 재생성

---

## 이전 버전 (Next.js 13-15) experimental PPR

```typescript
// next.config.ts (Next.js 13-15)
const nextConfig = {
  experimental: {
    ppr: 'incremental',  // 또는 true
  },
}

// 라우트 세그먼트에서 opt-in
export const experimental_ppr = true
```

---

## PPR vs 기존 방식 비교

| 방식 | 특징 |
|------|------|
| 완전 정적 (SSG) | 빌드 시 모두 생성, 개인화 불가 |
| 완전 동적 (SSR) | 매 요청마다 렌더, TTFB 높음 |
| **PPR** | 정적 shell 즉시 + 동적 부분 스트리밍 |

PPR은 첫 HTML 응답 속도(≒ TTFB)와 개인화 동적 콘텐츠를 동시에 달성.
