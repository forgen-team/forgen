---
title: Pinia 상태 관리 패턴
source: https://pinia.vuejs.org/core-concepts/
fetched: 2026-05-18
category: state
vue_version: 3
---

# Pinia 상태 관리 핵심 개념

---

## Store 정의

`defineStore()`로 생성하며 고유한 id가 필요하다. 관례적으로 `use`로 시작하고 `Store`로 끝내는 이름을 사용한다.

```js
import { defineStore } from 'pinia'
export const useAlertsStore = defineStore('alerts', { /* ... */ })
```

---

## 두 가지 문법

### Option Store (Options API 스타일)

```js
export const useCounterStore = defineStore('counter', {
  state: () => ({ count: 0, name: 'Eduardo' }),
  getters: {
    doubleCount: (state) => state.count * 2,
  },
  actions: {
    increment() {
      this.count++
    },
  },
})
```

| Pinia | Vue Options API |
|-------|----------------|
| `state` | `data` |
| `getters` | `computed` |
| `actions` | `methods` |

### Setup Store (Composition API 스타일)

```js
export const useCounterStore = defineStore('counter', () => {
  const count = ref(0)
  const name = ref('Eduardo')
  const doubleCount = computed(() => count.value * 2)

  function increment() {
    count.value++
  }

  return { count, name, doubleCount, increment }
})
```

| Composition API | Pinia 매핑 |
|-----------------|-----------|
| `ref()` | state |
| `computed()` | getters |
| `function` | actions |

**주의:** 모든 state 속성은 반드시 반환해야 한다. 미반환 시 SSR, devtools, 플러그인이 정상 동작하지 않는다.

Setup Store에서 외부 의존성 주입:
```ts
import { inject } from 'vue'
import { useRoute } from 'vue-router'

export const useSearchFilters = defineStore('search-filters', () => {
  const route = useRoute()
  const appProvided = inject('appProvided')  // inject 값은 반환하지 않는다
  return { /* ... */ }
})
```

---

## Store 사용

```vue
<script setup>
import { useCounterStore } from '@/stores/counter'

const store = useCounterStore()
</script>
```

store 객체는 반응형이므로 `.value` 불필요. 단, 직접 구조 분해 시 반응성이 끊긴다.

```vue
<script setup>
const store = useCounterStore()

// ❌ 반응성 손실
const { name, doubleCount } = store

// ✅ 반응성 유지
const doubleValue = computed(() => store.doubleCount)
</script>
```

---

## storeToRefs()로 반응형 구조 분해

```vue
<script setup>
import { useCounterStore } from '@/stores/counter'
import { storeToRefs } from 'pinia'

const store = useCounterStore()

// state/getters: storeToRefs 사용
const { name, doubleCount } = storeToRefs(store)

// actions: 직접 구조 분해 가능
const { increment } = store
</script>
```

---

## 문법 선택 가이드

- **Option Store**: 단순하고 입문자에게 친화적
- **Setup Store**: 복잡한 로직, watchers, composables 활용 시 더 강력하지만 SSR 복잡도 증가
