---
title: Core Web Vitals 2024 — 전체 개요 (LCP, INP, CLS)
source: https://web.dev/articles/vitals
fetched: 2026-05-18
category: web-vitals
---

## 개요

Google Web Vitals는 사용자 경험의 핵심 신호를 로딩·인터랙션·시각 안정성의 세 축으로 측정한다.
측정 기준: **75번째 백분위수** (모바일+데스크톱 세그먼트 기준).

---

## 세 가지 Core Web Vitals

### 1. LCP — Largest Contentful Paint (로딩)
- **Good**: ≤ 2.5초
- **Needs Improvement**: 2.5 ~ 4.0초
- **Poor**: > 4.0초

### 2. INP — Interaction to Next Paint (인터랙션)
- **Good**: ≤ 200ms
- **Needs Improvement**: 201 ~ 500ms
- **Poor**: > 500ms
- 2024년 3월 FID 대체로 Core Web Vital 공식 승격

### 3. CLS — Cumulative Layout Shift (시각 안정성)
- **Good**: ≤ 0.1
- **Needs Improvement**: 0.1 ~ 0.25
- **Poor**: > 0.25

---

## 측정 도구

**필드(실사용자) 도구**: Chrome UX Report, PageSpeed Insights, Search Console, Chrome DevTools

**랩 도구**: Lighthouse, Chrome DevTools, WebPageTest
> Lighthouse는 INP 직접 측정 불가 → Total Blocking Time을 proxy로 사용

---

## JavaScript 구현

```javascript
import {onCLS, onINP, onLCP} from 'web-vitals';

function sendToAnalytics(metric) {
  const body = JSON.stringify(metric);
  (navigator.sendBeacon && navigator.sendBeacon('/analytics', body)) ||
    fetch('/analytics', {body, method: 'POST', keepalive: true});
}

onCLS(sendToAnalytics);
onINP(sendToAnalytics);
onLCP(sendToAnalytics);
```
