---
title: FE 성능 가이드 — 문서 인덱스
fetched: 2026-05-18
category: index
---

# FE 성능 가이드 소스 문서 인덱스

2024-2026 최신 웹 성능 트렌드 기반. Vercel + web.dev + Chrome Developers 공식 문서.

---

## 문서 목록

### Core Web Vitals (web-vitals)

| 파일 | 주제 | 핵심 임계값 |
|------|------|------------|
| [01-core-web-vitals.md](./01-core-web-vitals.md) | LCP·INP·CLS 전체 개요 | LCP≤2.5s, INP≤200ms, CLS≤0.1 |
| [02-inp.md](./02-inp.md) | INP 심화 — FID 대체 신 지표 (2024) | ≤200ms Good, >500ms Poor |
| [03-lcp-cls.md](./03-lcp-cls.md) | LCP·CLS 최신 가이드라인 + 4 하위 구성 요소 | LCP≤2.5s, CLS≤0.1 |

### 네비게이션 (navigation)

| 파일 | 주제 | 브라우저 지원 |
|------|------|--------------|
| [04-speculation-rules.md](./04-speculation-rules.md) | Speculation Rules API — 즉시 페이지 전환 | Chrome 109+, Edge 109+ |
| [05-view-transitions.md](./05-view-transitions.md) | View Transitions API — 페이지 전환 애니메이션 | Same-doc: Chrome 111+; Cross-doc: Chrome 126+ |

### Next.js 캐싱·렌더링 (caching)

| 파일 | 주제 | 버전 |
|------|------|------|
| [06-nextjs-caching.md](./06-nextjs-caching.md) | App Router 캐싱 전략 (fetch, unstable_cache, use cache, React cache) | Next.js 16 |
| [07-server-components.md](./07-server-components.md) | Server vs Client Components 선택 기준 + 렌더링 흐름 | Next.js 16 |
| [08-ppr.md](./08-ppr.md) | PPR (Partial Prerendering) — 정적 shell + 동적 스트리밍 | Next.js 16 |

### 이미지 최적화 (images)

| 파일 | 주제 | 핵심 |
|------|------|------|
| [09-nextjs-image.md](./09-nextjs-image.md) | next/image 컴포넌트 전체 props + 최적화 패턴 | preload, fill, sizes, placeholder |
| [10-optimize-lcp.md](./10-optimize-lcp.md) | LCP 4 하위 구성 요소별 최적화 심화 | fetchpriority, SSR, CDN |

---

## 카테고리별 빠른 참조

### 임계값 요약

| 지표 | Good | Needs Improvement | Poor |
|------|------|-------------------|------|
| **LCP** | ≤ 2.5초 | 2.5 ~ 4.0초 | > 4.0초 |
| **INP** | ≤ 200ms | 201 ~ 500ms | > 500ms |
| **CLS** | ≤ 0.1 | 0.1 ~ 0.25 | > 0.25 |

기준: 75번째 백분위수 (모바일 + 데스크톱)

### 2024 주요 변경사항

1. **INP 공식 Core Web Vital 승격** (2024년 3월) — FID 은퇴
2. **Cross-Document View Transitions** 지원 (Chrome 126, 2024년)
3. **Next.js 16 cacheComponents** — PPR + use cache + dynamicIO 통합 플래그

### 도구 추천

| 목적 | 도구 |
|------|------|
| 실사용자 데이터 | Chrome UX Report, PageSpeed Insights (Field Data) |
| 랩 측정 | Lighthouse, WebPageTest, Chrome DevTools |
| JS 측정 | `web-vitals` 라이브러리 (`onLCP`, `onINP`, `onCLS`) |
| INP attribution | `web-vitals/attribution` (하위 구성 요소 세분화) |

---

## 출처

- https://web.dev/articles/vitals
- https://web.dev/articles/inp
- https://web.dev/articles/lcp
- https://web.dev/articles/cls
- https://web.dev/articles/optimize-lcp
- https://developer.chrome.com/docs/web-platform/prerender-pages
- https://developer.chrome.com/docs/web-platform/view-transitions
- https://nextjs.org/docs/app/building-your-application/caching
- https://nextjs.org/docs/app/building-your-application/rendering/server-components
- https://nextjs.org/docs/app/api-reference/next-config-js/ppr
- https://nextjs.org/docs/app/api-reference/components/image
