---
name: fe-perf-react
description: React/Next.js 앱의 메모리 누수·CPU 병목·INP/LCP 회귀를 진단. Chrome DevTools Performance/Memory + React Profiler 절차 가이드. 흔한 누수 패턴 4종 + 픽스 코드.
---

# fe-perf (React)

> **호출 시점**: "느려졌어", "메모리 누는 것 같아", "INP가 나빠졌어", Lighthouse 점수 회귀, OOM 등.
> **선행 로딩**: `principles/common.md` B + `sources/a11y-dx/chrome-devtools-*.md`.

## 0. 분류 — 어떤 증상인가?

진단 시작 전 사용자에게 1개 질문 (이미 명시했으면 스킵):

1. **메모리** — 시간이 지날수록 RSS/heap 증가, 탭이 GB 단위, OOM
2. **CPU/렌더** — 인터랙션 굳음, INP 나쁨, 스크롤 끊김, Long Task
3. **로드 성능** — LCP 나쁨, TTFB 나쁨, 번들 크기

분류에 따라 §1/§2/§3 으로 분기.

---

## 1. 메모리 누수 진단

근거: `sources/a11y-dx/chrome-devtools-memory.md`

### 1.1 측정 절차

1. Chrome DevTools → Memory 패널
2. **Heap snapshot 3회법** (가장 신뢰):
   - 초기 페이지 → snapshot 1
   - 의심 동작 N회 반복 (모달 열고 닫기 등) → snapshot 2
   - GC 수동 트리거 (휴지통 아이콘) → snapshot 3
   - snapshot 3에서 snapshot 1 대비 *증가한* Constructor 찾기
3. Constructor 클릭 → Retainers 트리에서 살아있는 이유 추적
4. `Detached` prefix 객체 발견 시 → DOM 누수

### 1.2 흔한 누수 패턴 4종 + 픽스

| 패턴 | 증상 | 픽스 |
|------|------|------|
| **이벤트 리스너 미해제** | `window.addEventListener` 후 cleanup 없음 | `useEffect(() => { ... ; return () => removeEventListener(...) }, [])` |
| **타이머 미정리** | `setInterval`/`setTimeout` cleanup 없음 | cleanup에서 `clearInterval/Timeout` |
| **구독 미해제** | WebSocket/Observable/IntersectionObserver | cleanup에서 `unsubscribe`/`.disconnect()` |
| **클로저 캡처** | 콜백이 큰 state 캡처 + 외부 보관 | 콜백 안에서 `useRef` 로 최신값 참조, 또는 캡처 최소화 |

### 1.3 React 특화 누수

- **RSC fetch 캐시 무한 누적** — `unstable_cache` key 안에 동적 무한 값 (timestamp 등) 사용 금지
- **`useEffect` 의존성에 객체/배열 매번 새로 생성** → 무한 리렌더 → 메모리 압박. Compiler 도입 또는 ref 안정화.
- **Context value 새 객체 매번 생성** → 모든 consumer 리렌더. `useMemo` 또는 Compiler.
- **Zustand 등 store에 거대한 캐시 무제한 적재** → LRU 또는 max-size 명시

### 1.4 진단 결과 형식

```
## 메모리 누수 진단
- 증상: 모달 N회 열고 닫으면 heap +XMB
- 원인: <Detached HTMLDivElement>, retainer: AppHeader.onResize (이벤트 리스너 미해제)
- 픽스: src/components/AppHeader.tsx:34
  return () => window.removeEventListener('resize', onResize)
- 검증: snapshot 3회법 재실행 → 누적 0 확인
```

---

## 2. CPU/렌더 병목 (INP 회귀)

근거: `sources/a11y-dx/chrome-devtools-performance.md`, `sources/a11y-dx/react-devtools-profiler.md`, `sources/perf/02-inp.md`

### 2.1 INP 진단 절차

1. **`web-vitals/attribution` 로 INP 하위 구성 요소 식별**
   ```ts
   import { onINP } from 'web-vitals/attribution';
   onINP((m) => console.log(m.attribution));
   // 결과: { eventEntry, longAnimationFrameEntries, interactionTarget, inputDelay, processingDuration, presentationDelay }
   ```
   - **Input Delay** 큼 → 직전 Long Task 찾기 (Performance 탭)
   - **Processing Duration** 큼 → 이벤트 핸들러 무거움
   - **Presentation Delay** 큼 → 렌더/스타일 무거움

2. **Chrome DevTools → Performance → 인터랙션 녹화**
   - Long Task 색상 (빨강) 식별
   - Flame Chart 가장 큰 박스 → 함수 이름
   - **Forced Layout/Style Recalc** 노란 박스 → `offsetTop` 등 read-after-write 패턴

3. **React Profiler → Why did this render?**
   - 불필요한 리렌더 식별. 부모 리렌더 vs prop 변경 vs state 변경.

### 2.2 INP 픽스 패턴

| 원인 | 픽스 |
|------|------|
| 핸들러 안 동기 무거운 계산 | `startTransition(() => setState(heavyCalc()))` 또는 `useDeferredValue` |
| 200ms+ Long Task | `scheduler.yield()` (지원 시) 또는 작업 chunk 분할 |
| 매 입력마다 외부 통신 | debounce (입력) / throttle (스크롤·리사이즈) |
| Context 거대 value 변경 | Context 분리 (Read/Write 분리) |
| useEffect 안 setState 체인 | 한 핸들러에서 모두 처리 |
| 큰 리스트 전체 렌더 | 가상화 (`react-window`, `@tanstack/react-virtual`) |

### 2.3 React Compiler 환경

- 수동 `useMemo`/`useCallback` 추가는 *오히려 컴파일러 최적화 방해 가능*
- Compiler가 메모이즈 못 하는 코드 → ESLint plugin 경고 따라 코드 수정 (불순 함수 등)

### 2.4 진단 결과 형식

```
## INP 진단
- 측정: INP p75 = 480ms (Poor)
- 하위: inputDelay=120ms, processingDuration=300ms, presentationDelay=60ms
- 원인: src/pages/list/index.tsx:88 onSearch 핸들러 안 동기 필터링 (n=10k)
- 픽스: startTransition + useDeferredValue
  ```ts
  const deferredQ = useDeferredValue(query);
  const filtered = useMemo(() => items.filter(matches(deferredQ)), [items, deferredQ]);
  ```
- 검증: INP p75 재측정 → ≤200ms 확인
```

---

## 3. 로드 성능 (LCP/TTFB/번들)

근거: `sources/perf/03-lcp-cls.md`, `sources/perf/10-optimize-lcp.md`

### 3.1 LCP 진단

1. Lighthouse → LCP element 식별 (스크린샷 + 셀렉터)
2. PageSpeed Insights → 실사용자 (Field) 데이터로 p75 확인
3. Performance 패널 → 4 하위 구성 요소 시간 분해:
   - **TTFB** (서버 응답)
   - **Resource Load Delay** (LCP 자원 발견)
   - **Resource Load Time** (다운로드)
   - **Render Delay** (렌더)

### 3.2 LCP 픽스 매트릭스

| 큰 구성 요소 | 픽스 |
|--------------|------|
| TTFB | RSC + 캐시 (revalidate, ISR), Edge 배포, DB 인덱스 |
| Resource Load Delay | `<link rel="preload">`, `next/image priority`, `fetchpriority="high"` |
| Resource Load Time | next/image (WebP/AVIF 자동), CDN, sizes 명시 |
| Render Delay | 클라이언트 hydration 무거움 → RSC 비중 증가, dynamic import |

### 3.3 번들 분석

- `next build` 출력의 First Load JS 확인
- `@next/bundle-analyzer` 로 시각화 → 큰 의존성 → dynamic import 또는 RSC 분리
- `'use client'` 파일 안 markdown/syntax-highlight 등 큰 라이브러리 → Server 분리

### 3.4 결과 형식

```
## LCP 진단
- 측정: LCP p75 = 3.8s (Needs Improvement)
- LCP element: src/pages/index.tsx <img src="/hero.jpg">
- 분해: TTFB 1.2s + LoadDelay 0.8s + LoadTime 1.1s + RenderDelay 0.7s
- 픽스 (우선순위):
  1. next/image + priority (Load Delay 제거): src/pages/index.tsx:24
  2. revalidate=300 → TTFB 1.2s → 200ms (캐시 hit)
  3. RSC로 메인 페이지 변환 (Render Delay 0.7s → 0.1s)
- 검증: 배포 후 24h Field Data 재확인
```

---

## 4. 출력 (사용자에게 무조건 포함할 항목)

- **측정 수치 (before)** — "느낌"이 아니라 숫자
- **원인 (파일:라인 + retainer/콜스택)**
- **픽스 코드** — 카피-페이스트 가능
- **검증 방법** — 픽스 후 무엇을 측정해서 어떻게 비교할지

## 5. 관련 문서

- [`principles/common.md`](../../principles/common.md), [`principles/react.md`](../../principles/react.md)
- 코퍼스: `sources/a11y-dx/chrome-devtools-{performance,memory}.md`, `sources/a11y-dx/react-devtools-profiler.md`, `sources/perf/`
