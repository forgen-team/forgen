---
title: Vue 3 + Nuxt 3 원칙
version: 2026-05-18
sources:
  - sources/vue/
---

# Vue 3 + Nuxt 3 원칙

> [공통 원칙](./common.md)을 먼저 따르고, 아래는 Vue/Nuxt 특화.

## V0. 의사결정 우선순위

1. **Composition API + `<script setup>` 우선** (Options API 신규 코드에서 지양)
2. **반응성 손실 절대 회피** — props 비구조화, reactive 객체 비구조화는 금지
3. **상태는 컴포넌트 → composable → Pinia** 순으로 승격 (필요할 때만)
4. **Nuxt: SSR 경계 의식** — `useFetch`/`useAsyncData` 로 hydration 일관성 보장

---

## V1. 스타일 가이드 4단계

근거: `sources/vue/style-guide-priority-a.md` ~ `priority-d.md`

### V1.1 Priority A (Essential — 위반 시 [HIGH])

- **다중 단어 컴포넌트 이름**. `Todo` 금지 → `TodoItem` (HTML 표준 충돌 회피)
- **`v-for` 에 `key` 필수**. `<li v-for="item in list" :key="item.id">`
- **`v-if` + `v-for` 같이 쓰지 마라**. 컴퓨티드로 필터링 후 `v-for`
- **컴포넌트 데이터는 함수 반환** (Options API의 경우)
- **prop 정의는 타입까지 명세** (`defineProps<{...}>()` 또는 객체 형식)
- **컴포넌트 스타일은 scoped**. 전역 클래스명 충돌 회피

### V1.2 Priority B (Strongly Recommended)

- **단일 파일 컴포넌트 (SFC)** 우선
- **컴포넌트 파일명: PascalCase** (`TodoItem.vue`)
- **베이스 컴포넌트는 명확한 prefix** (`BaseButton`, `AppLogo`)
- **싱글톤 컴포넌트는 `The` prefix** (`TheHeader`, `TheSidebar`)
- **자식 컴포넌트는 부모 이름으로 시작** (`TodoListItem` — 같은 디렉토리 내 응집)
- **이벤트 이름은 kebab-case** (`@form-submit`)

### V1.3 Priority C (Recommended)

- **컴포넌트/인스턴스 옵션 순서** 일관성
- **속성 순서**: `is` → `v-for` → `v-if` → `v-bind` → `v-on` → `key`/`ref` 등
- **단순 컴퓨티드 분해**. 한 컴퓨티드에 모든 로직 X → 작은 컴퓨티드 조합

### V1.4 Priority D (Use with Caution)

- **`scoped` 안에서 element 셀렉터 지양** — 클래스 셀렉터 사용
- **암묵적 부모-자식 통신 지양** — props/emits 명시
- **비-Flux 글로벌 상태 관리 지양** — Pinia 사용

---

## V2. Composition API + `<script setup>`

근거: `sources/vue/composition-api.md`

### V2.1 기본 골격

```vue
<script setup lang="ts">
import { ref, computed, watch } from 'vue';

const props = defineProps<{ id: string }>();
const emit = defineEmits<{ change: [value: string] }>();

const count = ref(0);
const double = computed(() => count.value * 2);

watch(() => props.id, (newId) => {
  // 외부 시스템 동기화
});
</script>
```

### V2.2 핵심 규칙

- **`<script setup>` 이 신규 코드 기본**. Options API는 레거시/마이그레이션 한정.
- **`defineProps`/`defineEmits` 는 매크로** — import 불필요, 컴파일 시점 처리
- **`defineModel()`** (Vue 3.4+) 로 양방향 바인딩 단순화
- **로직 재사용은 composable** (`useXxx`) — Vue 의 커스텀 훅 패턴

### V2.3 ref vs reactive

- **기본은 `ref`**. 원시값 + 객체 모두 처리, `.value` 일관성
- **`reactive` 는 객체 한정** + 비구조화 시 반응성 손실 위험
- **composable 반환은 `ref`/`computed`** 로 통일 (외부에서 비구조화 안전)

---

## V3. 반응성 함정 (반드시 회피)

근거: `sources/vue/reactivity-pitfalls.md`

### V3.1 props 비구조화 (Vue 3.5+ 는 자동 처리)

```ts
// ❌ 반응성 손실 (3.4 이하)
const { id } = defineProps<{ id: string }>();

// ✅ 3.4 이하
const props = defineProps<{ id: string }>();
const id = computed(() => props.id);

// ✅ 3.5+ 자동 변환 (Reactive Props Destructure)
const { id } = defineProps<{ id: string }>();
// 단 watch source 에서는 getter로: watch(() => id, ...)
```

### V3.2 reactive 비구조화 금지

```ts
const state = reactive({ count: 0 });

// ❌ 반응성 끊김
const { count } = state;

// ✅
const { count } = toRefs(state); // 각 필드 ref 화
```

### V3.3 ref unwrapping 함정

- **template 안: 자동 unwrap** (`.value` 불필요)
- **template 안 배열/Map 인덱싱: unwrap 안 됨** → `computed` 로 풀어서 노출
- **JS 코드: 명시적 `.value`** 필수

---

## V4. 상태 관리 (Pinia)

근거: `sources/vue/pinia-state-management.md`

### V4.1 언제 store로 승격?

- 컴포넌트 → composable: 같은 로직 2+ 컴포넌트에서 사용
- composable → Pinia store: 인스턴스 공유 필요 (싱글톤) 또는 DevTools/SSR/플러그인 필요

### V4.2 Setup Store 권장 (Composition API 일관성)

```ts
export const useCounterStore = defineStore('counter', () => {
  const count = ref(0);
  const double = computed(() => count.value * 2);
  function increment() { count.value++; }
  return { count, double, increment };
});
```

- `state`/`getters`/`actions` Options Store보다 setup store가 SSR/TS 친화적

---

## V5. Nuxt 3 데이터 페칭

근거: `sources/vue/nuxt-data-fetching.md`

### V5.1 페칭 함수 선택 매트릭스

| 함수 | SSR | 클라이언트 hydration | 사용 시점 |
|------|-----|---------------------|-----------|
| `useFetch(url)` | ✅ | 자동 dedup | 페이지/컴포넌트 데이터 |
| `useAsyncData(key, fn)` | ✅ | 자동 dedup | 임의 async 로직 |
| `useLazyFetch` | ❌ | 마운트 후 | 비차단 데이터 |
| `$fetch` | ✅(서버) | 수동 | 이벤트 핸들러 안 (form submit 등) |

### V5.2 SSR hydration 일관성

- 페이지 로직: `useFetch`/`useAsyncData` 만 사용. `onMounted` + 페치 금지 (SSR/CSR 불일치 → CLS).
- 이벤트 트리거 페치: `$fetch` (mutation 응답 받기)
- **key 명시적으로** — `useAsyncData('order-' + id, ...)` 같이 unique key 필수

### V5.3 server/ 디렉토리 (Nitro)

- BFF 패턴: `server/api/orders.get.ts` 같은 server route
- 클라이언트는 `useFetch('/api/orders')` 로 호출 → 자동 타입 추론

---

## V6. Vue 안티패턴 카탈로그

| 안티패턴 | 픽스 |
|----------|------|
| `v-if` + `v-for` 같이 사용 | computed로 필터링 |
| `v-for` 에 `key` 누락 또는 index key | 안정적 id |
| `reactive` 비구조화 | `toRefs` 또는 `ref` 사용 |
| props 비구조화 (3.4 이하) | `computed(() => props.x)` |
| Options API와 Composition API 혼용 | Composition으로 통일 |
| `onMounted` 안에서 페치 (Nuxt) | `useFetch`/`useAsyncData` |
| `defineProps()` runtime 형식 (TS 프로젝트) | `defineProps<{...}>()` 타입 형식 |
| `<style>` (scoped 없이) 컴포넌트 스타일 | `<style scoped>` 또는 CSS Module |
| 전역 watch 남발 | computed 우선 → 외부 시스템 동기화만 watch |
| Pinia state 직접 변경 (외부에서) | action으로 변경 |
