---
title: Composition API + script setup 베스트 프랙티스
source: https://vuejs.org/guide/extras/composition-api-faq.html, https://vuejs.org/api/sfc-script-setup.html
fetched: 2026-05-18
category: composition-api
vue_version: 3
---

# Composition API + `<script setup>` 베스트 프랙티스

---

## Composition API란?

임포트한 함수를 사용해 Vue 컴포넌트를 작성하는 API 세트.

- **Reactivity API**: `ref()`, `reactive()` — 반응형 상태, computed, watcher 생성
- **Lifecycle Hooks**: `onMounted()`, `onUnmounted()` — 생명주기 훅
- **Dependency Injection**: `provide()`, `inject()` — 의존성 주입

```vue
<script setup>
import { ref, onMounted } from 'vue'

const count = ref(0)

function increment() {
  count.value++
}

onMounted(() => {
  console.log(`Initial count is ${count.value}.`)
})
</script>

<template>
  <button @click="increment">Count is: {{ count }}</button>
</template>
```

---

## Composition API를 사용하는 이유

### 1. 로직 재사용 (Composables)
- 믹스인의 단점을 모두 해결
- VueUse 같은 생태계 활용 가능

### 2. 유연한 코드 구성
- Options API: 관련 코드가 `data`, `methods`, `computed` 등에 분산됨
- Composition API: 관련 로직을 같은 위치에 모아서 관리

### 3. 뛰어난 타입 추론
- 일반 변수/함수를 사용하므로 TypeScript 친화적
- Options API의 복잡한 타입 체조 불필요

### 4. 더 작은 번들 크기
- `<script setup>`에서 템플릿이 같은 스코프의 함수로 컴파일됨
- 인스턴스 프록시 없이 직접 변수 접근 → 더 나은 minification

---

## React Hooks와의 차이점

| 항목 | React Hooks | Vue Composition API |
|------|-------------|---------------------|
| 호출 횟수 | 렌더링마다 재실행 | `setup()`이 한 번만 실행 |
| Stale closures | 의존성 배열 관리 필요 | 런타임 반응형으로 자동 추적 |
| 최적화 | `useMemo`, `useCallback` 필요 | 세밀한 반응성으로 자동 최적화 |
| 조건부 사용 | 불가 | 자유롭게 사용 가능 |

---

## `<script setup>` 완전 가이드

### 기본 문법

```vue
<script setup>
// 최상위 바인딩(변수, 함수, import)이 템플릿에 자동 노출
const msg = 'Hello!'

function log() {
  console.log(msg)
}
</script>

<template>
  <button @click="log">{{ msg }}</button>
</template>
```

### defineProps()

```vue
<script setup>
// 런타임 선언
const props = defineProps({
  foo: String,
  bar: { type: Number, required: true }
})

// 타입 선언 (TypeScript)
const props = defineProps<{
  foo: string
  bar?: number
}>()
</script>
```

**반응형 구조 분해 (Vue 3.5+):**
```ts
const { foo } = defineProps(['foo'])
// foo 변경 시 watchEffect 자동 재실행
watchEffect(() => { console.log(foo) })
```

**기본값 (Vue 3.5+ 권장):**
```ts
const { msg = 'hello', labels = ['one', 'two'] } = defineProps<Props>()
```

**기본값 (Vue 3.4 이하):**
```ts
const props = withDefaults(defineProps<Props>(), {
  msg: 'hello',
  labels: () => ['one', 'two']  // 뮤터블 타입은 함수로 래핑
})
```

### defineEmits()

```vue
<script setup>
const emit = defineEmits(['change', 'delete'])

// TypeScript
const emit = defineEmits<{
  change: [id: number]
  update: [value: string]
}>()
</script>
```

### defineModel() (Vue 3.4+)

```js
// v-model 양방향 바인딩
const model = defineModel()  // modelValue prop
model.value = 'hello'

// named model
const count = defineModel('count', { type: Number, default: 0 })
count.value++

// modifier 처리
const [modelValue, modelModifiers] = defineModel({
  set(value) {
    if (modelModifiers.trim) return value.trim()
    return value
  }
})
```

### defineExpose()

`<script setup>` 컴포넌트는 기본적으로 닫혀있다. 외부에서 접근할 속성은 명시적으로 노출한다.

```vue
<script setup>
import { ref } from 'vue'

const a = 1
const b = ref(2)

defineExpose({ a, b })  // 부모의 template ref로 접근 가능
</script>
```

### defineOptions() (Vue 3.3+)

```vue
<script setup>
defineOptions({
  inheritAttrs: false,
  name: 'MyComponent'
})
</script>
```

### defineSlots() (Vue 3.3+)

```vue
<script setup lang="ts">
const slots = defineSlots<{
  default(props: { msg: string }): any
}>()
</script>
```

### useSlots() & useAttrs()

```vue
<script setup>
import { useSlots, useAttrs } from 'vue'

const slots = useSlots()
const attrs = useAttrs()
</script>
```

### Top-level await

```vue
<script setup>
const post = await fetch('/api/post/1').then((r) => r.json())
</script>
```

`async setup()`으로 컴파일됨. `<Suspense>`와 함께 사용해야 한다.

### 제네릭 (TypeScript)

```vue
<script setup lang="ts" generic="T extends string | number, U extends Item">
import type { Item } from './types'

defineProps<{
  id: T
  list: U[]
}>()
</script>
```

---

## 일반 `<script>`와 혼용

```vue
<script>
// 모듈 스코프에서 1회 실행
runSideEffectOnce()
export default { inheritAttrs: false }
</script>

<script setup>
// 각 인스턴스 setup() 스코프에서 실행
</script>
```

기존 Options API 코드베이스와의 점진적 통합에만 사용. 일반적으로는 권장하지 않는다.
