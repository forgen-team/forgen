---
title: Next.js App Router 캐싱 전략 (Next.js 16 기준)
source: https://nextjs.org/docs/app/building-your-application/caching
fetched: 2026-05-18
category: caching
---

## 개요

Next.js 16의 캐싱 모델은 `cacheComponents` 플래그 도입으로 재편되었다.
데이터는 기본 **비캐싱(dynamic)**, 필요한 곳에만 `use cache` 지시어로 캐싱 opt-in.

```typescript
// next.config.ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  cacheComponents: true,  // use cache + PPR 통합 활성화
}

export default nextConfig
```

---

## 캐싱 계층 구조

### 1. fetch() 캐싱

```typescript
// 캐시 저장
const data = await fetch('https://api.example.com/data', {
  cache: 'force-cache'
})

// 캐시 없음 (기본값)
const data = await fetch('https://api.example.com/data')
// 또는
const data = await fetch('https://api.example.com/data', {
  cache: 'no-store'
})

// 시간 기반 재검증 (3600초 = 1시간)
const data = await fetch('https://api.example.com/data', {
  next: { revalidate: 3600 }
})

// 태그 기반 온디맨드 재검증
const data = await fetch('https://api.example.com/users', {
  next: { tags: ['user'] }
})
```

### 2. unstable_cache (non-fetch 함수)

```typescript
import { unstable_cache } from 'next/cache'
import { db } from '@/lib/db'

export const getCachedUser = unstable_cache(
  async (id: string) => {
    return db.select().from(users).where(eq(users.id, id)).then(r => r[0])
  },
  ['user'],           // 캐시 키 prefix
  {
    tags: ['user'],
    revalidate: 3600,
  }
)
```

### 3. use cache 지시어 (cacheComponents 활성화 시)

```typescript
// 컴포넌트 레벨 캐싱
async function CachedDashboard() {
  'use cache'
  const data = await fetchDashboardData()
  return <Dashboard data={data} />
}

// 함수 레벨 캐싱
async function getCachedData(id: string) {
  'use cache'
  return await db.query.findById(id)
}
```

### 4. React cache (요청 단위 메모이제이션)

```typescript
import { cache } from 'react'

// 단일 렌더 패스 내 중복 요청 제거
export const getPost = cache(async (id: string) => {
  const post = await db.query.posts.findFirst({
    where: eq(posts.id, parseInt(id)),
  })
  return post
})
```

---

## 온디맨드 재검증

### revalidateTag — 태그로 무효화

```typescript
import { revalidateTag } from 'next/cache'

export async function updateUser(id: string) {
  await db.update(users).set({ name: 'new' }).where(eq(users.id, id))
  revalidateTag('user')  // 'user' 태그를 가진 모든 캐시 무효화
}
```

### revalidatePath — 경로로 무효화

```typescript
import { revalidatePath } from 'next/cache'

export async function updatePost() {
  await db.update(posts)...
  revalidatePath('/blog')  // /blog 경로의 모든 캐시 무효화
}
```

---

## Route Segment Config

```typescript
// layout.tsx | page.tsx | route.ts

// 항상 동적 렌더링
export const dynamic = 'force-dynamic'

// 항상 정적 (빌드 시 생성)
export const dynamic = 'force-static'

// 기본 재검증 주기 설정 (초)
export const revalidate = 3600

// fetch 캐시 정책 일괄 설정
export const fetchCache = 'force-cache'
// 'auto' | 'default-cache' | 'only-cache' | 'force-cache'
// 'default-no-store' | 'only-no-store' | 'force-no-store'
```

---

## 데이터 Preload 패턴

```typescript
// utils/get-item.ts
import { cache } from 'react'
import 'server-only'

export const getItem = cache(async (id: string) => {
  // DB 또는 API 호출
})

// 블로킹 작업 전에 미리 데이터 로딩 시작
export const preload = (id: string) => {
  void getItem(id)
}
```

```typescript
// page.tsx
import { getItem, preload, checkIsAvailable } from '@/lib/data'

export default async function Page({ params }) {
  const { id } = await params
  preload(id)                          // 즉시 데이터 로딩 시작
  const isAvailable = await checkIsAvailable()  // 병렬 진행
  return isAvailable ? <Item id={id} /> : null
}
```

---

## 재검증 빈도 규칙

- 라우트의 재검증 빈도 = 해당 라우트 내 레이아웃+페이지 중 **가장 낮은 revalidate 값**
- 개별 fetch가 라우트 기본값보다 낮은 revalidate를 갖고 있으면 그 값이 전체 라우트에 영향
- `revalidate` 값은 정적으로 분석 가능해야 함 (`revalidate = 600` O, `revalidate = 60 * 10` X)
