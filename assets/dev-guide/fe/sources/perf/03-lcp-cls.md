---
title: LCP · CLS 최신 가이드라인
source: https://web.dev/articles/lcp, https://web.dev/articles/cls
fetched: 2026-05-18
category: web-vitals
---

## LCP — Largest Contentful Paint

### 임계값

| 등급 | 값 |
|------|-----|
| **Good** | ≤ 2.5초 |
| **Needs Improvement** | 2.5 ~ 4.0초 |
| **Poor** | > 4.0초 |

### 측정 대상 요소
- `<img>` (애니메이션: 첫 프레임 기준)
- SVG 내 `<image>`
- `<video>` (poster 이미지 또는 첫 프레임 중 먼저 로드된 것)
- CSS `background-image: url(...)` 배경 요소
- 텍스트를 포함한 블록 레벨 요소

제외: `opacity: 0` 요소, 뷰포트 전체를 채우는 배경 처리 요소, 낮은 엔트로피 플레이스홀더 이미지

### 측정 특이사항
사용자가 탭·스크롤·키 입력 시 측정 **중단** (이미 인터랙션한 뒤 로드되는 요소는 무관).

---

## LCP의 4가지 하위 구성 요소 (최적화 우선순위 순)

```
LCP = TTFB + Resource Load Delay + Resource Load Duration + Element Render Delay
```

| 구성 요소 | 목표 비중 | 설명 |
|-----------|-----------|------|
| TTFB | ~40% | 서버 응답 시간 |
| Resource Load Delay | <10% | TTFB ~ LCP 리소스 로딩 시작까지 |
| Resource Load Duration | ~40% | 실제 리소스 전송 시간 |
| Element Render Delay | <10% | 리소스 완료 ~ 화면 렌더까지 |

**핵심**: Resource Load Delay + Element Render Delay는 합쳐서 <10%가 이상적.
어느 구간도 리소스가 로딩되지 않는 시간 = 낭비.

---

## LCP 최적화 기법

### 1. Resource Load Delay 제거
```html
<!-- HTML에 직접 src/srcset 포함 (preload scanner 활성화) -->
<img fetchpriority="high" src="/hero.webp" alt="hero">

<!-- CSS/JS에서만 참조되는 경우 preload 추가 -->
<link rel="preload" fetchpriority="high" as="image"
  href="/hero.webp" type="image/webp">
```
- LCP 이미지에 `loading="lazy"` 절대 금지

### 2. Element Render Delay 제거
- Critical CSS 인라인화 또는 CSS 파일 크기 최소화
- `<head>` 내 동기 스크립트 제거
- 서버사이드 렌더링으로 HTML에 이미지 포함

### 3. Resource Load Duration 단축
- WebP/AVIF 포맷 사용
- 반응형 `srcset` 적용
- CDN/Image CDN 활용
- 공격적 캐싱 정책

### 4. TTFB 단축
- 서버 처리 시간 최소화
- 불필요한 리다이렉트 제거
- CDN 엣지 캐싱

---

## CLS — Cumulative Layout Shift

### 임계값

| 등급 | 값 |
|------|-----|
| **Good** | ≤ 0.1 |
| **Needs Improvement** | 0.1 ~ 0.25 |
| **Poor** | > 0.25 |

기준: 페이지 전체 생애주기 중 최대 레이아웃 이동 버스트 점수의 75번째 백분위수

### 주요 원인
- 크기 미지정 이미지/비디오
- 폴백 폰트보다 크거나 작은 웹폰트
- 동적으로 리사이즈되는 광고·위젯
- 비동기 리소스 삽입
- 기존 콘텐츠 앞에 동적 DOM 삽입

### 최적화 기법

```css
/* 1. CSS transform 사용 (레이아웃 재계산 없음) */
.moving-element {
  transform: translate(0, 10px);  /* top/left 변경 대신 */
  transform: scale(1.1);          /* width/height 변경 대신 */
}

/* 2. 동적 콘텐츠 공간 미리 확보 */
.ad-slot {
  min-height: 250px;
}

/* 3. 폰트 로딩 중 레이아웃 변화 방지 */
@font-face {
  font-display: optional; /* 또는 swap + size-adjust */
}
```

```javascript
// 사용자 인터랙션 후 이동은 CLS 제외 (hadRecentInput 확인)
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (!entry.hadRecentInput) {
      // 이 shift만 CLS에 카운트됨
      console.log('CLS shift:', entry.value);
    }
  }
}).observe({type: 'layout-shift', buffered: true});
```
