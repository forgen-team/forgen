---
title: Next.js Server Components & Client Components
source: https://nextjs.org/docs/app/building-your-application/rendering/server-components
fetched: 2026-05-18
category: caching
---

## 기본 원칙

App Router에서 레이아웃과 페이지는 기본적으로 **Server Component**.
상호작용·브라우저 API가 필요한 경우에만 `'use client'`로 Client Component 지정.

---

## Server vs Client 선택 기준

| 필요한 것 | 권장 컴포넌트 |
|-----------|--------------|
| DB/API 직접 접근 | Server |
| API 키·시크릿 보호 | Server |
| JS 번들 크기 최소화 | Server |
| FCP 개선, 점진적 스트리밍 | Server |
| `onClick`, `onChange` 등 이벤트 핸들러 | Client |
| `useState`, `useEffect` | Client |
| `localStorage`, `window` 등 브라우저 API | Client |
| 커스텀 훅 (상태 기반) | Client |

---

## 렌더링 흐름

### 서버 측
1. Server Component → RSC Payload (바이너리 포맷) 생성
2. Client Component + RSC Payload → HTML prerender

> **RSC Payload**: Server Component 렌더 결과 + Client Component 위치 플레이스홀더 + 참조 파일 경로

### 클라이언트 측 (최초 로드)
1. HTML → 즉시 non-interactive 프리뷰 표시
2. RSC Payload → Client/Server 컴포넌트 트리 조정(reconcile)
3. JavaScript → Client Component 하이드레이션 (인터랙티브)

### 이후 네비게이션
- RSC Payload prefetch + 캐시 → 즉시 네비게이션
- Client Component는 클라이언트에서만 렌더 (서버 HTML 없음)

---

## 코드 예시

### 기본 패턴: Server + Client 조합

```tsx
// app/[id]/page.tsx — Server Component
import LikeButton from '@/app/ui/like-button'
import { getPost } from '@/lib/data'

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const post = await getPost(id)  // 서버에서 직접 DB 접근

  return (
    <div>
      <h1>{post.title}</h1>
      <LikeButton likes={post.likes} />  {/* Client Component에 props 전달 */}
    </div>
  )
}
```

```tsx
// app/ui/like-button.tsx — Client Component
'use client'

import { useState } from 'react'

export default function LikeButton({ likes }: { likes: number }) {
  const [count, setCount] = useState(likes)
  return <button onClick={() => setCount(c => c + 1)}>{count} Likes</button>
}
```

### JS 번들 최소화 패턴

```tsx
// app/layout.tsx — Server Component
import Search from './search'   // Client Component (검색창만)
import Logo from './logo'       // Server Component (정적)

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <nav>
        <Logo />    {/* 서버 렌더 */}
        <Search />  {/* 클라이언트 번들 포함 */}
      </nav>
      <main>{children}</main>
    </>
  )
}
```

### Server를 Client에 children으로 전달

```tsx
// 'use client' Modal에 Server Component인 Cart를 children으로 전달 가능
// app/ui/modal.tsx
'use client'
export default function Modal({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>
}

// app/page.tsx
import Modal from './ui/modal'
import Cart from './ui/cart'  // Server Component

export default function Page() {
  return (
    <Modal>
      <Cart />  {/* 서버에서 미리 렌더링됨 */}
    </Modal>
  )
}
```

---

## Context Provider 패턴

React context는 Server Component에서 직접 사용 불가. Client Component로 감싸기:

```tsx
// app/theme-provider.tsx
'use client'
import { createContext } from 'react'

export const ThemeContext = createContext({})

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  return <ThemeContext.Provider value="dark">{children}</ThemeContext.Provider>
}
```

```tsx
// app/layout.tsx — Server Component
import ThemeProvider from './theme-provider'

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
        {/* Provider를 트리 가능한 한 깊숙이 배치 → 정적 부분 최적화 */}
      </body>
    </html>
  )
}
```

---

## 환경 오염 방지

```javascript
// lib/data.js — 서버 전용 강제
import 'server-only'  // 클라이언트에서 import 시 빌드 에러

export async function getData() {
  const res = await fetch('https://api.example.com', {
    headers: { authorization: process.env.API_KEY },  // 서버에서만 접근
  })
  return res.json()
}
```

- `NEXT_PUBLIC_` 접두사 없는 환경변수는 클라이언트 번들에서 빈 문자열로 치환됨
- 반대로 클라이언트 전용 코드: `client-only` 패키지 사용
