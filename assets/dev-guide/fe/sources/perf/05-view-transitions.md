---
title: View Transitions API — 페이지 전환 애니메이션 (Chrome 111+)
source: https://developer.chrome.com/docs/web-platform/view-transitions
fetched: 2026-05-18
category: navigation
---

## 개요

DOM 업데이트(SPA) 또는 페이지 간 이동(MPA) 시 부드러운 시각적 전환을 제공하는 API.
브라우저가 전환 전후 스냅샷을 찍고 CSS 애니메이션으로 보간한다.

---

## 두 가지 구현 유형

### 1. 동일 문서 전환 (Same-Document / SPA)
**지원**: Chrome 111+, Edge 111+, Firefox 144+, Safari 18+

JavaScript API로 트리거:
```javascript
// DOM 업데이트를 감싸기만 하면 됨
document.startViewTransition(() => updateTheDOMSomehow());

// 비동기 업데이트도 지원
document.startViewTransition(async () => {
  await fetchNewContent();
  updateTheDOMSomehow();
});
```

### 2. 크로스 문서 전환 (Cross-Document / MPA)
**지원**: Chrome 126+, Edge 126+, Safari 18.2+ | Firefox 미지원

CSS만으로 opt-in (JS 불필요):
```css
/* 양쪽 페이지 모두에 추가 */
@view-transition {
  navigation: auto;
}
```
같은 오리진 페이지 간 탐색 시 자동으로 전환 효과 적용.

---

## 핵심 CSS: view-transition-name

개별 요소를 캡처하여 독립 애니메이션 처리:
```css
.hero-image {
  view-transition-name: hero;
}

.page-title {
  view-transition-name: page-title;
}
```

**주의**: `view-transition-name` 값은 페이지 전체에서 고유해야 함.

---

## 생성되는 Pseudo-Elements

```
::view-transition                          /* 루트 오버레이 */
  └── ::view-transition-group(name)        /* 개별 요소 래퍼 */
        ├── ::view-transition-old(name)    /* 이전 상태 스냅샷 */
        └── ::view-transition-new(name)    /* 새 상태 스냅샷 */
```

기본 전환은 cross-fade. 커스터마이즈:
```css
/* 슬라이드 전환 예시 */
::view-transition-old(root) {
  animation: 300ms ease-out both slide-to-left;
}
::view-transition-new(root) {
  animation: 300ms ease-out both slide-from-right;
}

@keyframes slide-to-left {
  to { transform: translateX(-100%); }
}
@keyframes slide-from-right {
  from { transform: translateX(100%); }
}
```

---

## View Transition Types (Chrome 125+)

네비게이션 방향에 따라 다른 애니메이션:
```javascript
document.startViewTransition({
  update: updateTheDOMSomehow,
  types: ['forwards']  // 'backwards', 'reload' 등
});
```

CSS에서 타입별 스타일:
```css
:active-view-transition-type(forwards) ::view-transition-old(root) {
  animation-name: slide-to-left;
}
:active-view-transition-type(backwards) ::view-transition-old(root) {
  animation-name: slide-to-right;
}
```

---

## JavaScript 애니메이션 (Web Animations API)

```javascript
const transition = document.startViewTransition(() => updateDOM());

// pseudo-element가 생성된 후 JS 애니메이션 적용
transition.ready.then(() => {
  document.documentElement.animate(
    { transform: ['translateY(-100%)', 'translateY(0)'] },
    {
      duration: 300,
      easing: 'ease-out',
      pseudoElement: '::view-transition-new(root)'
    }
  );
});
```

---

## 주요 활용 사례
- 썸네일 → 상세 이미지 확대
- 네비게이션 persistent 요소 (헤더, 탭바)
- 필터링 시 그리드 재정렬
- 페이지 간 영웅 이미지 공유 트랜지션

---

## 접근성 고려

```css
/* 모션 감소 선호 사용자 대응 */
@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*),
  ::view-transition-old(*),
  ::view-transition-new(*) {
    animation-duration: 0.01ms !important;
  }
}
```
