---
title: Chrome DevTools 메모리 패널 진단 가이드
source: https://developer.chrome.com/docs/devtools/memory-problems
fetched: 2026-05-18
category: devtools-memory
---

# Chrome DevTools Memory Panel

## 언제 쓰는가

- 페이지를 오래 쓸수록 느려지거나 탭이 크래시될 때
- Task Manager에서 메모리가 지속 상승할 때
- SPA에서 라우트 이동 후에도 메모리가 반환되지 않을 때

---

## 1단계: Task Manager로 메모리 누수 확인

1. `Shift+Esc` → Chrome Task Manager 열기
2. 오른쪽 클릭 → **JavaScript Memory** 컬럼 활성화
3. 문제 탭의 **JavaScript Memory** 값이 계속 증가하면 누수 의심

---

## 세 가지 진단 도구

### A. Heap Snapshot (정적 스냅샷)

**용도:** 특정 시점에 메모리에 무엇이 있는지 파악, Detached DOM 찾기

**절차:**
1. Memory 패널 → **Heap snapshot** 선택 → **Take snapshot**
2. 의심 동작 수행 (라우트 이동, 모달 열고 닫기 등)
3. 두 번째 스냅샷 → **Comparison** 뷰 선택
4. `# Delta` 양수인 항목이 증가한 객체
5. 검색창에 `Detached` 입력 → Detached DOM 트리 찾기
6. **Objects pane**에서 어떤 변수가 참조 중인지 확인

### B. Allocation Timeline (동적 추적)

**용도:** 어느 시점에 메모리가 급증하는지 타임라인으로 파악

**절차:**
1. Memory 패널 → **Allocations on timeline** 선택 → **Start**
2. 문제 동작 반복 → **Stop**
3. 파란 막대 = 새 할당. 막대를 클릭하면 해당 시점 할당 객체 목록
4. 사라지지 않는 파란 막대(회색으로 변하지 않는 것)가 누수 후보

### C. Allocation Sampling (함수별 분석)

**용도:** 어떤 함수가 메모리를 가장 많이 할당하는지 성능 부담 없이 분석

**절차:**
1. Memory 패널 → **Allocation sampling** → **Start**
2. 동작 수행 → **Stop**
3. **Heavy (Bottom Up)** 뷰에서 메모리 소비 함수 Top N 확인

---

## 흔한 메모리 누수 패턴

### 1. Detached DOM
```js
// Bad: DOM 제거 후에도 JS에서 참조 유지
let cachedNode;
function init() {
  cachedNode = document.getElementById('temp');
}
function remove() {
  document.body.removeChild(cachedNode);
  // cachedNode 변수가 여전히 노드를 참조 → GC 불가
}

// Fix: 참조 해제
function remove() {
  document.body.removeChild(cachedNode);
  cachedNode = null; // 참조 해제
}
```

### 2. 이벤트 리스너 미제거
```js
// Bad: 컴포넌트 unmount 시 리스너 제거 안 함
useEffect(() => {
  window.addEventListener('resize', handleResize);
  // cleanup 없음
}, []);

// Fix
useEffect(() => {
  window.addEventListener('resize', handleResize);
  return () => window.removeEventListener('resize', handleResize);
}, []);
```

### 3. 타이머 미정리
```js
// Bad
useEffect(() => {
  const id = setInterval(poll, 1000);
  // clearInterval 없음
}, []);

// Fix
useEffect(() => {
  const id = setInterval(poll, 1000);
  return () => clearInterval(id);
}, []);
```

### 4. 클로저에 의한 의도치 않은 참조 유지
```js
// Bad: 큰 배열이 클로저에 캡처됨
function setup() {
  const bigData = new Array(1000000).fill(0);
  return function handler() {
    // bigData를 실제로 쓰지 않아도 클로저가 유지
    console.log('clicked');
  };
}

// Fix: 필요한 값만 클로저 내부에 두기
function setup() {
  const bigData = new Array(1000000).fill(0);
  const needed = bigData[0]; // 필요한 값만 추출
  return function handler() {
    console.log(needed);
  };
}
```

---

## 진단 워크플로우 요약

1. Task Manager로 누수 확인 (JavaScript Memory 열 모니터링)
2. Performance 패널 + Memory 체크박스로 힙 추이 녹화
3. Heap Snapshot 2개 → Comparison으로 증가 객체 특정
4. `Detached` 검색으로 떠도는 DOM 확인
5. Allocation Timeline으로 누수 발생 시점 핀포인트
6. 코드에서 참조 해제 / cleanup 추가 → 재검증

---

## React SPA 특유 주의사항

- **useEffect cleanup** 누락이 가장 흔한 원인
- React 18 StrictMode는 개발 환경에서 useEffect를 2번 실행 → cleanup 누락 즉시 발견 가능
- 라우트 이동 후 Heap Snapshot 비교: 이전 페이지 컴포넌트 인스턴스가 남아있으면 누수
