---
name: fe-perf-vue
description: Vue 3/Nuxt 3 앱 메모리 누수·CPU 병목·INP/LCP 회귀 진단. Chrome DevTools + Vue DevTools + Nuxt DevTools 절차. 반응성 관련 누수 + watch 폭주 패턴.
---

# fe-perf (Vue)

> **호출 시점**: "느려졌어", "메모리 누는 것 같아", "INP 나빠", Nuxt SSR 응답 느림.
> **선행 로딩**: `principles/common.md` B + `sources/a11y-dx/chrome-devtools-*.md`.

## 0. 분류

1. **메모리** — heap 증가 / OOM
2. **CPU/렌더** — INP 나쁨 / 인터랙션 굳음
3. **로드** — LCP/TTFB 나쁨 / 번들 큼

---

## 1. 메모리 누수 진단

근거: `sources/a11y-dx/chrome-devtools-memory.md`

### 1.1 측정 (Heap Snapshot 3회법)

(React 와 동일 절차 — 도구는 동일)

1. snapshot 1 (초기) → 의심 동작 N회 → snapshot 2 → GC → snapshot 3
2. 증가한 Constructor + Retainer 트리 추적
3. `Detached` prefix = DOM 누수

### 1.2 Vue 특화 누수 패턴

| 패턴 | 증상 | 픽스 |
|------|------|------|
| **watch 핸들러가 외부 변수 캡처** | watch 콜백이 큰 객체 참조 + 컴포넌트 unmount 후에도 살아있음 | `onUnmounted` 에서 `stopWatch()` 호출 (또는 컴포넌트 스코프 watch면 자동 정리) |
| **`watchEffect` 가 reactive ref 외부 보관** | 외부 store에 ref 저장 | 컴포넌트 scope 안에서만 사용 |
| **글로벌 이벤트 리스너 미해제** | `window.addEventListener` + `onUnmounted` 누락 | `useEventListener` (VueUse) 또는 명시적 `onUnmounted` cleanup |
| **Pinia store 무제한 누적** | 캐시/히스토리에 max 없음 | LRU 또는 max-size |
| **`provide` 객체에 컴포넌트 참조 저장** | 자식 컴포넌트가 unmount 후에도 부모 provide 통해 살아있음 | provide는 primitive/ref만 |
| **Nuxt asyncData payload 거대** | SSR payload에 직렬화된 거대 객체 → 메모리 + hydration 비용 | `transform` 옵션으로 필요한 필드만 |

### 1.3 진단 결과 형식

```
## 메모리 누수 진단
- 증상: 모달 N회 열고 닫으면 heap +XMB
- 원인: Detached HTMLDivElement, retainer = window.onResize (onUnmounted 정리 누락)
- 픽스: src/components/AppHeader.vue:32
  onUnmounted(() => window.removeEventListener('resize', onResize))
  // 또는 VueUse useEventListener 사용
- 검증: 3회법 재실행 → 누적 0
```

---

## 2. CPU/렌더 병목 (INP 회귀)

근거: `sources/perf/02-inp.md`, `sources/a11y-dx/chrome-devtools-performance.md`

### 2.1 INP 진단

(측정 도구는 React 동일 — `web-vitals/attribution`)

```ts
import { onINP } from 'web-vitals/attribution';
onINP((m) => console.log(m.attribution));
```

Chrome DevTools Performance 패널 + Vue DevTools (Inspector → Performance 탭) 병행.

### 2.2 Vue 특화 픽스 패턴

| 원인 | 픽스 |
|------|------|
| 핸들러 안 동기 무거운 계산 | 작업 chunk + `scheduler.yield()` 또는 `requestIdleCallback` |
| 무거운 watch (deep, 큰 객체) | computed로 대체 가능한지 검토. 안 되면 throttle/debounce |
| `watchEffect` 가 너무 자주 트리거 | 명시적 `watch` + 좁은 source |
| reactive 큰 객체 변경 → 의존 컴포넌트 폭주 | `shallowRef`/`shallowReactive` 또는 분할 |
| 큰 리스트 v-for | `v-memo` (안정 분기 시) 또는 가상 스크롤 (VueUse `useVirtualList`) |
| 매 입력마다 외부 통신 | debounce (VueUse `useDebounceFn`) |
| reactivity 추적 폭주 | `markRaw()` (반응성 불필요 큰 객체) |

### 2.3 Vue DevTools — 렌더 추적

- Performance 탭 → 컴포넌트 렌더 시간 측정
- Highlight Updates → 어떤 컴포넌트가 재렌더되는지 시각화
- 불필요한 자식 리렌더 → props 안정화 또는 `defineProps` 분리

### 2.4 진단 결과 형식

```
## INP 진단
- 측정: INP p75 = 460ms (Poor)
- 하위: inputDelay=80ms, processingDuration=340ms, presentationDelay=40ms
- 원인: pages/list.vue:55 onSearch 안 동기 필터 (n=12k) + reactive 전체 변경
- 픽스:
  ```ts
  const query = ref('');
  const debouncedQuery = useDebounceFn((v: string) => query.value = v, 150);
  const filtered = computed(() => items.filter(matches(query.value)));
  // items가 큰 정적 데이터면 shallowRef로 wrap
  ```
- 검증: INP p75 재측정 → ≤200ms
```

---

## 3. 로드 성능 (Nuxt SSR / LCP)

근거: `sources/perf/03-lcp-cls.md`, `sources/perf/10-optimize-lcp.md`

### 3.1 LCP 진단

(측정 절차는 React 동일 — Lighthouse, PageSpeed Insights, Performance 패널)

### 3.2 Nuxt SSR 특화 픽스

| 큰 구성 요소 | 픽스 |
|--------------|------|
| **TTFB** | Nuxt `defineEventHandler` 안 동기 작업 줄이기, Nitro `cachedFunction`, ISR (`routeRules: { isr: true }`) |
| **Resource Load Delay** | `<NuxtImg>` `preload`, `<Head>` 안 `<link rel="preload">` |
| **Resource Load Time** | `@nuxt/image` (WebP/AVIF), CDN, sizes |
| **Render Delay** | hydration mismatch 확인 (콘솔 경고), `<ClientOnly>` 신중하게 |

### 3.3 Nuxt asyncData 최적화

- `transform` 으로 직렬화 payload 슬림화
- `pick` 으로 필요한 필드만 (`useFetch(url, { pick: ['id', 'name'] })`)
- `lazy: true` (비차단) — 단 LCP 콘텐츠는 lazy 금지

### 3.4 번들 분석

- `nuxi analyze` 로 클라이언트 번들 시각화
- 큰 컴포넌트 → `defineAsyncComponent` 또는 `components.lazy`
- 서버 전용 의존성은 `server/` 또는 `nitro.experimental.componentIslands`

### 3.5 결과 형식

```
## LCP 진단
- 측정: LCP p75 = 3.5s (Needs Improvement)
- LCP element: pages/index.vue <img src="/hero.jpg">
- 분해: TTFB 1.1s + LoadDelay 0.7s + LoadTime 1.0s + RenderDelay 0.7s
- 픽스 (우선순위):
  1. `<NuxtImg src="/hero.jpg" preload format="webp">` — LoadDelay 제거
  2. nuxt.config: routeRules { '/': { isr: 60 } } — TTFB 1.1s → 150ms
  3. hydration mismatch (콘솔 경고) 제거 — RenderDelay 단축
- 검증: 배포 후 24h Field Data 재확인
```

---

## 4. 출력 (필수)

- **측정 수치 (before)**
- **원인 (파일:라인 + retainer/콜스택)**
- **픽스 코드** — 카피-페이스트 가능
- **검증 방법**

## 5. 관련 문서

- [`principles/common.md`](../../principles/common.md), [`principles/vue.md`](../../principles/vue.md)
- 코퍼스: `sources/a11y-dx/chrome-devtools-*`, `sources/a11y-dx/react-devtools-profiler.md` (DevTools 개념 동일), `sources/perf/`
