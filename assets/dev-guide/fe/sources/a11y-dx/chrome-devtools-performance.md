---
title: Chrome DevTools 성능 패널 진단 가이드
source: https://developer.chrome.com/docs/devtools/performance
fetched: 2026-05-18
category: devtools-perf
---

# Chrome DevTools Performance Panel

## 언제 쓰는가

- 페이지가 느리게 느껴질 때 (스크롤 jank, 애니메이션 끊김, 클릭 반응 지연)
- LCP/TBT/CLS 점수를 개선하기 전 병목 위치 특정
- "어떤 JS 함수가 메인 스레드를 막는가" 파악

---

## 기본 녹화 절차

1. DevTools 열기 (Mac: `Cmd+Option+I` / Win: `Ctrl+Shift+I`)
2. **Performance** 탭 선택
3. **Screenshots** 체크박스 활성화
4. CPU 스로틀링 설정: 일반 사용자 환경 시뮬레이션 → **4x slowdown** 권장
5. **Record** 버튼 클릭 → 문제 동작 재현 → **Stop**

---

## 핵심 지표

| 지표 | 설명 | 목표 |
|------|------|------|
| **FPS** | 초당 프레임 수. 빨간 바 = jank | 60fps 유지 |
| **FCP** | First Contentful Paint | ≤ 1.8s |
| **LCP** | Largest Contentful Paint | ≤ 2.5s |
| **TBT** | Total Blocking Time (메인 스레드 블로킹 합계) | ≤ 200ms |
| **CLS** | Cumulative Layout Shift | ≤ 0.1 |

---

## Flame Chart 읽는 법

- **X축**: 시간 경과
- **Y축**: 콜스택 (위 = 부모, 아래 = 자식)
- **바 너비**: 실행 시간 (넓을수록 오래 걸림)
- **빨간 삼각형**: 잠재적 문제 (Long Task, Forced Layout 등)
- **노란색 바**: JS 실행
- **보라색 바**: Rendering (Style/Layout)
- **초록색 바**: Painting

---

## Long Task 식별

- 50ms 이상 메인 스레드를 점유하는 작업 = Long Task
- Flame chart에서 빨간 삼각형 → 클릭하면 소스 위치로 이동
- **Summary 탭**에서 시간 분포 확인 (Scripting / Rendering / Painting 비율)

---

## Forced Layout (Layout Thrashing) 진단

**원인:** JS에서 레이아웃 속성(offsetTop, clientWidth 등)을 읽고 쓰기를 반복하면 브라우저가 강제로 layout을 재계산

**증상:** Flame chart에서 Layout 블록이 JS 실행 사이사이에 자주 등장

**해결:**
```js
// Bad: 읽기/쓰기 혼재
elements.forEach(el => {
  const h = el.offsetHeight; // 읽기 → layout 강제
  el.style.height = h + 10 + 'px'; // 쓰기
});

// Good: 읽기 먼저, 쓰기 나중에
const heights = elements.map(el => el.offsetHeight);
elements.forEach((el, i) => {
  el.style.height = heights[i] + 10 + 'px';
});
```

---

## 진단 워크플로우

1. 증상 재현 → Performance 녹화
2. FPS 차트에서 빨간 구간(drop) 찾기
3. 해당 구간 Flame chart 줌인
4. 가장 넓은 바(오래 걸리는 함수) 클릭 → Source 확인
5. Summary 탭에서 Scripting/Rendering 비율 확인
6. Long Task 원인: 무거운 JS 계산이면 코드 분할·Web Worker 검토
7. Rendering 비율 높으면 CSS 속성 변경 최소화, `will-change`, `transform` 활용

---

## 성능 비교 (Before/After)

- 최적화 전 녹화 저장 → 최적화 후 재녹화
- **CPU throttling 동일하게 맞추기** (결과 재현성)
- 3회 이상 녹화하여 평균값으로 비교 (노이즈 제거)
