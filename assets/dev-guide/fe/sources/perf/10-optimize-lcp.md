---
title: LCP 최적화 심화 — 4가지 하위 구성 요소별 전략
source: https://web.dev/articles/optimize-lcp
fetched: 2026-05-18
category: images
---

## LCP 목표

**Good**: 75번째 백분위수 기준 ≤ 2.5초
**Needs Improvement**: 2.5 ~ 4.0초
**Poor**: > 4.0초

---

## LCP = 4가지 하위 구성 요소의 합

```
LCP = TTFB + Resource Load Delay + Resource Load Duration + Element Render Delay
```

| 구성 요소 | 이상적 비중 | 의미 |
|-----------|------------|------|
| **TTFB** | ~40% | 서버 최초 바이트 응답 시간 |
| **Resource Load Delay** | <10% | TTFB 종료 ~ LCP 리소스 로딩 시작 |
| **Resource Load Duration** | ~40% | 실제 리소스 전송 시간 |
| **Element Render Delay** | <10% | 리소스 완료 ~ 화면에 그려지는 시간 |

**핵심 원칙**: 어느 단계에도 "아무것도 로딩되지 않는" 구간을 만들지 마라.
두 리소스(HTML + LCP 리소스)가 동시에 로딩되는 것이 이상적.

---

## 최적화 우선순위 1: Resource Load Delay 제거

### 문제: LCP 이미지가 늦게 발견됨

```html
<!-- BAD: CSS background (preload scanner 미탐지) -->
<div class="hero"></div>
```
```css
.hero { background-image: url('/hero.webp'); }
```

```html
<!-- GOOD: HTML에 직접 포함 (preload scanner 탐지) -->
<img src="/hero.webp" alt="히어로" fetchpriority="high">
```

### 문제: LCP 이미지가 JS에서만 참조됨

```html
<!-- GOOD: preload link 추가 -->
<link rel="preload" fetchpriority="high" as="image"
  href="/hero.webp" type="image/webp">
```

### 문제: LCP 이미지에 lazy loading 적용

```html
<!-- BAD -->
<img src="/hero.webp" loading="lazy" alt="히어로">

<!-- GOOD -->
<img src="/hero.webp" loading="eager" fetchpriority="high" alt="히어로">
```

### fetchpriority 힌트

```html
<!-- LCP 이미지에 높은 우선순위 -->
<img fetchpriority="high" src="/hero.webp" alt="히어로">

<!-- 폴드 아래 이미지에 낮은 우선순위 (기본 lazy와 병행 가능) -->
<img fetchpriority="low" src="/below-fold.jpg" alt="...">
```

---

## 최적화 우선순위 2: Element Render Delay 제거

### 렌더링 블록 CSS

```html
<!-- BAD: 큰 외부 CSS 파일이 렌더링 블록 -->
<link rel="stylesheet" href="/large-styles.css">

<!-- GOOD: 크리티컬 CSS 인라인화 -->
<style>
  /* 첫 화면에 필요한 최소한의 CSS만 */
  .hero { ... }
</style>
<!-- 나머지 CSS는 비동기 로드 -->
<link rel="stylesheet" href="/non-critical.css" media="print"
  onload="this.media='all'">
```

### 렌더링 블록 JavaScript

```html
<!-- BAD: head의 동기 스크립트 -->
<script src="/analytics.js"></script>

<!-- GOOD: defer 또는 async 사용 -->
<script src="/analytics.js" defer></script>
<!-- 또는 크리티컬하지 않으면 body 끝으로 이동 -->
```

### 서버사이드 렌더링 활용

```javascript
// SSR: 이미지 src가 초기 HTML에 포함 → preload scanner 탐지 가능
// CSR: 이미지 src가 JS 실행 후 결정 → Resource Load Delay 증가
```

### Long Task 방지

```javascript
// BAD: 메인 스레드를 오래 블록하는 작업
function heavyCalculation() { /* 200ms+ */ }

// GOOD: 분할 실행
async function chunkedCalculation(items) {
  for (const item of items) {
    processItem(item)
    // 다음 frame 전에 제어권 반환
    await scheduler.yield()
  }
}
```

---

## 최적화 우선순위 3: Resource Load Duration 단축

```html
<!-- 현대 이미지 포맷 사용 -->
<picture>
  <source srcset="/hero.avif" type="image/avif">
  <source srcset="/hero.webp" type="image/webp">
  <img src="/hero.jpg" alt="히어로">
</picture>

<!-- 반응형 srcset으로 적절한 크기 제공 -->
<img
  srcset="/hero-480.webp 480w, /hero-800.webp 800w, /hero-1200.webp 1200w"
  sizes="(max-width: 600px) 480px, (max-width: 1000px) 800px, 1200px"
  src="/hero-1200.webp"
  alt="히어로"
  fetchpriority="high">
```

### CDN / Image CDN 활용

```javascript
// Cloudinary, Imgix 등 Image CDN은:
// - 자동 WebP/AVIF 변환
// - 엣지에서 크기 최적화
// - 자동 압축
// URL 패턴 예시
const optimizedUrl = `https://res.cloudinary.com/demo/image/fetch/w_800,f_auto,q_auto/${originalUrl}`
```

### 캐싱 정책

```http
Cache-Control: public, max-age=31536000, immutable
```

---

## 최적화 우선순위 4: TTFB 단축

- 서버 사이드 렌더링 캐싱 (Vercel Edge Cache, CDN)
- 불필요한 리다이렉트 제거 (`http://` → `https://`, `www.` 제거)
- 서버 처리 시간 최소화
- Edge Function으로 지리적 지연 최소화

---

## 진단 도구

```javascript
// LCP 하위 구성 요소 측정 (web-vitals 라이브러리)
import {onLCP} from 'web-vitals/attribution';

onLCP(metric => {
  const {
    timeToFirstByte,        // TTFB
    resourceLoadDelay,      // Resource Load Delay
    resourceLoadDuration,   // Resource Load Duration
    elementRenderDelay      // Element Render Delay
  } = metric.attribution;

  console.log({timeToFirstByte, resourceLoadDelay, resourceLoadDuration, elementRenderDelay});
});
```

**실제 사용자 데이터(CrUX)를 랩 데이터(Lighthouse)보다 우선** 확인할 것.
75번째 백분위수가 2.5초 이하라면 하위 구성 요소 세분화 최적화보다 다른 우선순위를 고려.
