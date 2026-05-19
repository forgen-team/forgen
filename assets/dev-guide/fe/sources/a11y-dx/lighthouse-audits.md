---
title: Lighthouse 접근성·성능·Best Practices 항목 레퍼런스
source: https://developer.chrome.com/docs/lighthouse/accessibility/ https://developer.chrome.com/docs/lighthouse/performance/
fetched: 2026-05-18
category: lighthouse
---

# Lighthouse 감사 항목

## 점수 체계

- **90–100**: 초록 (Good)
- **50–89**: 주황 (Needs Improvement)
- **0–49**: 빨강 (Poor)
- 접근성 점수: 각 감사 항목의 가중 평균 (axe 영향도 기준), **이진 평가** (부분 통과 없음)

---

## 성능(Performance) 핵심 지표

| 지표 | 가중치 | 설명 | 목표 |
|------|--------|------|------|
| **LCP** (Largest Contentful Paint) | 25% | 가장 큰 콘텐츠 표시 시점 | ≤ 2.5s |
| **TBT** (Total Blocking Time) | 30% | 메인 스레드 블로킹 합계 | ≤ 200ms |
| **CLS** (Cumulative Layout Shift) | 25% | 예기치 않은 레이아웃 이동 | ≤ 0.1 |
| **FCP** (First Contentful Paint) | 10% | 초기 콘텐츠 표시 시점 | ≤ 1.8s |
| **Speed Index** | 10% | 시각적 완성 속도 | ≤ 3.4s |

**주의:** 점수 변동 요인 — A/B 테스트, 네트워크 라우팅, 브라우저 확장, 안티바이러스. 3회 이상 측정 평균값 사용 권장.

---

## 접근성(Accessibility) 감사 항목

### ARIA 관련

| 항목 | 가중치 | 핵심 |
|------|--------|------|
| `[aria-*]` 속성이 역할과 일치 | 10 | 잘못된 aria 조합 방지 |
| `[aria-*]` 값이 유효 | 10 | 오타·잘못된 값 방지 |
| `[role]` 값이 유효 | 10 | 표준 role만 사용 |
| role에 필요한 `[aria-*]` 모두 제공 | 10 | 불완전한 ARIA 패턴 방지 |
| 자식 role 요건 충족 | 10 | `listbox > option` 등 구조 준수 |
| 부모 role 요건 충족 | 10 | `li` → `ul/ol` 내부 등 |

### 이름(Accessible Name) 관련

| 항목 | 가중치 | 핵심 |
|------|--------|------|
| 버튼에 접근 가능한 이름 | 10 | `aria-label` or 텍스트 콘텐츠 필수 |
| 링크에 식별 가능한 이름 | 7 | "여기 클릭" 같은 모호한 링크 금지 |
| 폼 요소에 레이블 연결 | 10 | `<label for>` or `aria-label` |
| 이미지에 `alt` 속성 | 10 | 장식 이미지는 `alt=""` |
| `<video>`에 자막 트랙 | 10 | `<track kind="captions">` |
| 다이얼로그에 접근 가능한 이름 | 7 | `aria-labelledby` or `aria-label` |

### 포커스·내비게이션

| 항목 | 가중치 | 핵심 |
|------|--------|------|
| `tabindex` > 0 없음 | 7 | 자연스러운 탭 순서 방해 금지 |
| 스킵 링크가 포커스 가능 | 3 | `<a href="#main">` 등 |
| 페이지에 제목/랜드마크/스킵링크 존재 | 7 | 스크린리더 내비게이션 진입점 |

### 구조·시맨틱

| 항목 | 가중치 | 핵심 |
|------|--------|------|
| `<html lang>` 유효한 언어 코드 | 7 | `lang="ko"` |
| `<title>` 요소 존재 | 7 | 탭/스크린리더 페이지 식별 |
| 제목 계층 순차적 (h1→h2→h3) | 3 | 건너뛰기 금지 |
| 리스트 구조 올바름 | 7 | `<ul>` > `<li>` only |

### 시각·색상

| 항목 | 가중치 | 핵심 |
|------|--------|------|
| 배경/전경 색상 대비 충분 | 7 | 일반 텍스트 4.5:1, 큰 텍스트 3:1 |
| 링크가 색상 외 수단으로 구별 | 7 | 밑줄, 아이콘 등 |
| 사용자 확대 허용 (`user-scalable`) | 10 | `maximum-scale` ≥ 5 |

### 숨김·포커스 관리

| 항목 | 가중치 | 핵심 |
|------|--------|------|
| `aria-hidden="true"` 요소에 포커스 가능 자식 없음 | 7 | 숨겨진 요소에 탭 진입 방지 |
| `<body>`에 `aria-hidden="true"` 없음 | 10 | 전체 페이지 숨김 금지 |

### 고유 식별자

| 항목 | 가중치 | 핵심 |
|------|--------|------|
| ARIA ID 중복 없음 | 10 | `aria-labelledby` 오작동 방지 |
| 포커스 가능 요소의 `id` 중복 없음 | 7 | |

---

## 자주 실패하는 항목 & 빠른 수정

```html
<!-- 1. 버튼 이름 없음 (가중치 10) -->
<!-- Bad -->
<button><img src="close.svg"></button>
<!-- Fix -->
<button aria-label="닫기"><img src="close.svg" alt=""></button>

<!-- 2. 입력 필드 레이블 없음 (가중치 10) -->
<!-- Bad -->
<input type="text" placeholder="이름">
<!-- Fix -->
<label for="name">이름</label>
<input id="name" type="text">

<!-- 3. 이미지 alt 없음 (가중치 10) -->
<!-- Bad -->
<img src="hero.jpg">
<!-- Fix -->
<img src="hero.jpg" alt="서비스 히어로 이미지">

<!-- 4. 사용자 확대 차단 (가중치 10) -->
<!-- Bad -->
<meta name="viewport" content="width=device-width, user-scalable=no">
<!-- Fix -->
<meta name="viewport" content="width=device-width, initial-scale=1">

<!-- 5. 색상 대비 부족 (가중치 7) -->
<!-- Bad: #999 on white = 2.85:1 -->
<p style="color: #999;">안내 텍스트</p>
<!-- Fix: #767676 on white = 4.54:1 -->
<p style="color: #767676;">안내 텍스트</p>
```

---

## Lighthouse 실행 방법

```bash
# CLI
npm install -g lighthouse
lighthouse https://example.com --output html --output-path report.html

# 특정 카테고리만
lighthouse https://example.com --only-categories=accessibility,performance
```

DevTools → Lighthouse 탭 → 카테고리 선택 → Analyze page load
