---
title: Speculation Rules API — 즉시 페이지 전환(Prerender/Prefetch)
source: https://developer.chrome.com/docs/web-platform/prerender-pages
fetched: 2026-05-18
category: navigation
---

## 개요

Chrome이 재도입한 완전한 페이지 프리렌더링 API. 구식 `<link rel="prerender">` 대체.
사용자 탐색 전에 페이지를 비가시 백그라운드 탭으로 로드 → 활성화 시 즉시 전환.
LCP 사실상 0, CLS 대폭 개선 효과.

**브라우저 지원**: Chrome 109+, Edge 109+ | Firefox 미지원 | Safari 실험적

---

## 기본 문법

```html
<script type="speculationrules">
{
  "prerender": [{
    "urls": ["/next-page.html", "/about.html"]
  }]
}
</script>
```

---

## URL 목록 vs 문서 규칙

### URL 목록 (정적)
```json
{
  "prerender": [{ "urls": ["/page1.html", "/page2.html"] }]
}
```

### 문서 규칙 (동적 — CSS/URL 패턴 매칭)
```json
{
  "prerender": [{
    "where": {
      "and": [
        { "href_matches": "/*" },
        { "not": { "href_matches": "/admin/*" } },
        { "not": { "selector_matches": ".no-prerender" } }
      ]
    },
    "eagerness": "moderate"
  }]
}
```

---

## Eagerness 레벨 (Chrome 121+)

| 레벨 | 데스크톱 | 모바일 |
|------|---------|--------|
| `immediate` | 즉시 | 즉시 |
| `eager` | 10ms 호버 | 뷰포트 진입 50ms 후 |
| `moderate` | 200ms 호버 또는 pointerdown | 스크롤 후 500ms |
| `conservative` | pointer/touch down만 | pointer/touch down만 |

**권장 구현** (대부분 사이트에 적합):
```html
<script type="speculationrules">
{
  "prerender": [{
    "where": { "href_matches": "/*" },
    "eagerness": "moderate"
  }]
}
</script>
```

---

## 브라우저 할당량 (리소스 낭비 방지)

| Eagerness | Prefetch 한도 | Prerender 한도 |
|-----------|--------------|----------------|
| `immediate` | 50 | 10 |
| `eager` / `moderate` / `conservative` | 2 (FIFO) | 2 (FIFO) |

한도 초과 시 가장 오래된 speculation이 취소되고 새 것으로 교체.

---

## Prefetch (경량 대안)

```json
{
  "prefetch": [{
    "urls": ["/next.html"],
    "eagerness": "moderate"
  }]
}
```

기존 `<link rel="prefetch">`와 달리, 탐색으로서의 문서를 prefetch하여 non-cacheable 콘텐츠도 처리.

---

## HTTP 헤더로 전달

```http
Speculation-Rules: "/speculationrules.json"
```
JSON 파일 MIME 타입: `application/speculationrules+json`

---

## 동적 삽입 (JavaScript)

```javascript
const rules = document.createElement('script');
rules.type = 'speculationrules';
rules.textContent = JSON.stringify({
  prerender: [{ urls: [getNextPageUrl()] }]
});
document.head.appendChild(rules);
```

---

## 주요 제약

- 서브프레임(iframe) 내 규칙 무시
- 활성화 전까지 알림·권한 팝업 등 "침습적" API 불가
- 크로스 오리진 iframe은 페이지 활성화 전까지 렌더링 안 됨
- Save-Data, 에너지 절약 모드, 사용자 "페이지 프리로드" 설정 자동 준수

---

## 고급 기능

### Tags (Chrome 136+)
```json
{ "tag": "my-rules", "prerender": [{ "urls": ["/next.html"] }] }
```
서버사이드 필터링을 위한 레이블링.

### Target Hint (Chrome 138+)
투기 대상 컨텍스트 지정으로 정확도 향상.
