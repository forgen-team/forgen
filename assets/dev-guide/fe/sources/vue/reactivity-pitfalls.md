---
title: Vue 3 반응성 함정 (Reactivity Pitfalls)
source: https://vuejs.org/guide/extras/reactivity-in-depth.html
fetched: 2026-05-18
category: reactivity
vue_version: 3
---

# Vue 3 반응성 심층 가이드

---

## 반응성의 작동 원리

Vue는 두 가지 방식으로 객체 속성 접근을 가로챈다:

1. **Proxy** (Vue 3 `reactive()`)
2. **Getter/Setter** (Vue 3 `ref()`)

```js
function reactive(obj) {
  return new Proxy(obj, {
    get(target, key) {
      track(target, key)      // 의존성 추적
      return target[key]
    },
    set(target, key, value) {
      target[key] = value
      trigger(target, key)    // 구독자 알림
    }
  })
}

function ref(value) {
  const refObject = {
    get value() {
      track(refObject, 'value')
      return value
    },
    set value(newValue) {
      value = newValue
      trigger(refObject, 'value')
    }
  }
  return refObject
}
```

### 핵심 메커니즘

```js
let activeEffect  // 현재 실행 중인 effect

function track(target, key) {
  if (activeEffect) {
    const effects = getSubscribersForProperty(target, key)
    effects.add(activeEffect)
  }
}

function trigger(target, key) {
  const effects = getSubscribersForProperty(target, key)
  effects.forEach((effect) => effect())
}
```

---

## ref vs reactive 선택 가이드

| 상황 | 권장 |
|------|------|
| 원시값 (string, number, boolean) | `ref()` |
| 객체/배열의 전체 재할당 필요 | `ref()` |
| 객체의 속성만 변경 | `reactive()` 또는 `ref()` |
| 컴포저블/스토어 반환값 | `ref()` (구조 분해 가능) |

---

## 반응성 함정 (Pitfalls)

### 1. reactive() 구조 분해 시 반응성 손실

```js
const state = reactive({ count: 0 })

// ❌ BROKEN: 구조 분해 후 반응성 끊김
const { count } = state
count++  // state.count에 반영되지 않음

// ✅ WORKS: 직접 접근
state.count++
```

**비원시 값은 예외 (객체 참조 공유):**
```js
const state = reactive({ user: { name: 'John' } })

// ✅ WORKS: 객체 참조 공유이므로 변경이 추적됨
const { user } = state
user.name = 'Jane'  // state.user.name도 변경됨
```

### 2. props 구조 분해 시 반응성 손실 (Vue 3.5 이전)

```vue
<script setup>
const props = defineProps({ count: Number })

// ❌ Vue 3.4 이하: 반응성 손실
const { count } = props
watchEffect(() => console.log(count))  // count 변경 감지 안 됨

// ✅ 올바른 방법
watchEffect(() => console.log(props.count))

// ✅ Vue 3.5+: 반응형 구조 분해 지원
const { count } = defineProps(['count'])  // 이제 반응형
</script>
```

### 3. Proxy 동일성 문제

```js
const original = {}
const reactive_obj = reactive(original)

console.log(original === reactive_obj)  // false ← Proxy이므로 다름
```

**항상 reactive 버전으로만 작업해야 한다.**

---

## 반응성 디버깅

### 컴포넌트 디버그 훅

```js
import { onRenderTracked, onRenderTriggered } from 'vue'

onRenderTracked((event) => {
  debugger  // 의존성 추적 시점
})

onRenderTriggered((event) => {
  debugger  // 의존성 변경 → 리렌더 시점
})
```

**DebuggerEvent 구조:**
```ts
type DebuggerEvent = {
  effect: ReactiveEffect
  target: object
  type: 'get' | 'has' | 'iterate' | 'set' | 'add' | 'delete' | 'clear'
  key: any
  newValue?: any
  oldValue?: any
}
```

### computed 디버깅

```js
const plusOne = computed(() => count.value + 1, {
  onTrack(e) {
    debugger  // 의존성 추적 시
  },
  onTrigger(e) {
    debugger  // 의존성 변경 시
  }
})
```

### watcher 디버깅

```js
watch(source, callback, {
  onTrack(e) { debugger },
  onTrigger(e) { debugger }
})

watchEffect(callback, {
  onTrack(e) { debugger },
  onTrigger(e) { debugger }
})
```

---

## 외부 상태 시스템 연동

외부 라이브러리 상태는 `shallowRef()`를 사용한다. 깊은 변환을 피한다.

```js
import { shallowRef } from 'vue'

const externalState = shallowRef(externalLibrary.state)
// 외부 상태 변경 시 ref 값을 교체
externalState.value = newExternalState
```

**Immer와 연동:**
```js
import { produce } from 'immer'
import { shallowRef } from 'vue'

export function useImmer(baseState) {
  const state = shallowRef(baseState)
  const update = (updater) => {
    state.value = produce(state.value, updater)
  }
  return [state, update]
}
```

---

## 런타임 vs 컴파일 타임 반응성

| 방식 | 예시 | 장점 | 단점 |
|------|------|------|------|
| **런타임** (Vue) | `ref()`, `reactive()` | 빌드 불필요, 엣지 케이스 적음 | `.value` 필요, JS 문법 제약 |
| **컴파일 타임** (Svelte) | `let count = 0` (컴파일러 변환) | 더 나은 ergonomics | 빌드 필수, JS 의미론 변경 |

Vue는 Reactivity Transform 실험 후 컴파일 타임 방식을 채택하지 않기로 결정했다.

---

## Signal 패턴 (참고)

다른 프레임워크의 signal 패턴을 Vue로 구현할 수 있다.

**Solid.js 스타일:**
```js
import { shallowRef, triggerRef } from 'vue'

function createSignal(value, options) {
  const r = shallowRef(value)
  const get = () => r.value
  const set = (v) => {
    r.value = typeof v === 'function' ? v(r.value) : v
    if (options?.equals === false) triggerRef(r)
  }
  return [get, set]
}
```

**Angular 스타일:**
```js
import { shallowRef } from 'vue'

function signal(initialValue) {
  const r = shallowRef(initialValue)
  const s = () => r.value
  s.set = (value) => { r.value = value }
  s.update = (updater) => { r.value = updater(r.value) }
  return s
}
```
