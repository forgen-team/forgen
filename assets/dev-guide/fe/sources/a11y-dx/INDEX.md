---
title: A11y + DX/디버깅 문서 인덱스
fetched: 2026-05-18
category: index
---

# A11y + DX 디버깅 문서 인덱스

## 파일 목록

| 파일 | 카테고리 | 내용 |
|------|----------|------|
| [wcag22-new-criteria.md](./wcag22-new-criteria.md) | wcag22 | WCAG 2.2 신규 SC 9개 — 레벨·요약·영향 컴포넌트·체크리스트 |
| [chrome-devtools-performance.md](./chrome-devtools-performance.md) | devtools-perf | Performance 패널 — 녹화 절차, Flame Chart, Long Task, Forced Layout 진단 |
| [chrome-devtools-memory.md](./chrome-devtools-memory.md) | devtools-memory | Memory 패널 — Heap Snapshot, Allocation Timeline, 4가지 누수 패턴 |
| [react-devtools-profiler.md](./react-devtools-profiler.md) | react-profiler | React Profiler — Flame Chart, Why did this render?, Highlight Updates |
| [lighthouse-audits.md](./lighthouse-audits.md) | lighthouse | 접근성·성능 감사 항목 전체 + 가중치 + 빠른 수정 코드 |

## 주제별 빠른 참조

### 접근성(A11y)
- WCAG 2.2 신규 요건 → `wcag22-new-criteria.md`
- Lighthouse 접근성 점수 향상 → `lighthouse-audits.md`

### 성능 진단
- 렌더 병목 (Flame Chart, Long Task) → `chrome-devtools-performance.md`
- React 불필요 재렌더 → `react-devtools-profiler.md`
- Lighthouse 성능 지표 (LCP/TBT/CLS) → `lighthouse-audits.md`

### 메모리 누수 진단
- Detached DOM / 이벤트 리스너 / 타이머 / 클로저 → `chrome-devtools-memory.md`

## 출처

- https://www.w3.org/WAI/WCAG22/quickref/
- https://developer.chrome.com/docs/devtools/performance
- https://developer.chrome.com/docs/devtools/memory-problems
- https://react.dev/learn/react-developer-tools
- https://legacy.reactjs.org/blog/2018/09/10/introducing-the-react-profiler.html
- https://developer.chrome.com/docs/lighthouse/accessibility/
- https://developer.chrome.com/docs/lighthouse/performance/
