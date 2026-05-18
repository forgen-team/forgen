---
title: Next.js Image 컴포넌트 최적화 가이드
source: https://nextjs.org/docs/app/api-reference/components/image
fetched: 2026-05-18
category: images
---

## 개요

`next/image`는 HTML `<img>`를 확장하여 자동 이미지 최적화를 제공한다:
- 자동 WebP/AVIF 변환
- 반응형 srcset 생성
- Lazy loading 기본 적용
- CLS 방지를 위한 크기 예약

---

## 기본 사용

```jsx
import Image from 'next/image'

export default function Page() {
  return (
    <Image
      src="/profile.png"
      width={500}
      height={500}
      alt="프로필 사진"
    />
  )
}
```

---

## 핵심 Props 레퍼런스

| Prop | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `src` | String | 필수 | 내부 경로, 외부 URL, static import |
| `alt` | String | 필수 | 접근성 대체 텍스트 |
| `width` | Integer(px) | - | 인트린식 너비 (aspect ratio 계산용) |
| `height` | Integer(px) | - | 인트린식 높이 |
| `fill` | Boolean | false | 부모 요소 크기에 맞게 채우기 |
| `sizes` | String | - | 반응형 이미지 크기 힌트 |
| `quality` | Integer(1-100) | 75 | 최적화 품질 |
| `loading` | String | `'lazy'` | `'lazy'` \| `'eager'` |
| `preload` | Boolean | false | `<link rel="preload">` 삽입 |
| `placeholder` | String | `'empty'` | `'empty'` \| `'blur'` \| data URL |
| `blurDataURL` | String | - | blur placeholder용 base64 이미지 |
| `unoptimized` | Boolean | false | 최적화 비활성화 |
| `decoding` | String | `'async'` | 이미지 디코딩 힌트 |

> **주의**: `priority` prop은 Next.js 16에서 deprecated → `preload` 사용 권장

---

## LCP 이미지 최적화

```jsx
// 히어로 이미지 (LCP 요소) — 즉시 로딩
<Image
  src="/hero.webp"
  width={1200}
  height={600}
  alt="히어로 이미지"
  preload={true}      // <link rel="preload"> 삽입
  loading="eager"     // lazy loading 비활성화
  quality={85}
/>
```

**언제 `preload={true}`를 쓰나:**
- LCP 요소인 경우
- 폴드 위(above the fold) 이미지
- `<head>`에서 미리 로드하고 싶은 경우

**쓰지 말아야 할 때:**
- 뷰포트에 따라 LCP 요소가 달라지는 경우
- `loading` 또는 `fetchPriority` prop과 함께 사용 시

---

## fill + sizes 반응형 패턴

```jsx
// fill: 부모 요소 크기에 맞게 채움
// 부모에 position: relative/fixed/absolute 필요
<div style={{ position: 'relative', width: '100%', height: '400px' }}>
  <Image
    src="/banner.jpg"
    fill
    alt="배너"
    sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
    style={{ objectFit: 'cover' }}
  />
</div>
```

**sizes 미지정 시**: 브라우저는 이미지가 100vw라고 가정 → 불필요하게 큰 이미지 다운로드.

**sizes 효과**:
- `sizes` 없음: `1x, 2x` srcset 생성 (고정 크기)
- `sizes` 있음: `640w, 750w, 828w, ...` 전체 srcset 생성 (반응형)

---

## placeholder blur 패턴

```jsx
import Image from 'next/image'
import profilePic from './profile.jpg'  // 정적 import → blurDataURL 자동 생성

export default function Profile() {
  return (
    <Image
      src={profilePic}
      alt="프로필"
      placeholder="blur"  // 로딩 중 블러 표시
    />
  )
}
```

외부 이미지의 경우 `blurDataURL` 직접 제공:
```jsx
<Image
  src="https://example.com/image.jpg"
  width={500}
  height={500}
  alt="외부 이미지"
  placeholder="blur"
  blurDataURL="data:image/jpeg;base64,/9j/4AAQSkZJRgAB..."
/>
```

---

## 커스텀 loader

```jsx
'use client'

import Image from 'next/image'

const imageLoader = ({ src, width, quality }) => {
  return `https://cdn.example.com/${src}?w=${width}&q=${quality || 75}`
}

export default function Page() {
  return (
    <Image
      loader={imageLoader}
      src="profile.jpg"
      alt="프로필"
      width={500}
      height={500}
    />
  )
}
```

---

## 외부 이미지 설정 (next.config.ts)

```typescript
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'cdn.example.com',
        port: '',
        pathname: '/images/**',
      },
    ],
    // 허용 품질 값 제한
    qualities: [75, 85, 100],
    // 포맷 우선순위
    formats: ['image/avif', 'image/webp'],
  },
}
```

---

## CLS 방지 핵심

`width`와 `height`는 렌더 크기가 아닌 **aspect ratio 계산**에 사용된다.
브라우저가 이미지 로드 전 공간을 예약하여 레이아웃 이동(CLS) 방지.

```jsx
// fill 없이 사용 시 width + height 필수
<Image src="/img.jpg" width={800} height={600} alt="..." />

// fill 사용 시 width/height 불필요 (부모 크기 따라감)
<Image src="/img.jpg" fill alt="..." />
```
