---
title: Vue 3 스타일 가이드 - Priority A (Essential)
source: https://vuejs.org/style-guide/rules-essential
fetched: 2026-05-18
category: style-guide
vue_version: 3
---

# Priority A: Essential

반드시 지켜야 하는 규칙. 위반 시 버그 또는 예측 불가 동작이 발생한다.

---

## 1. 멀티-워드 컴포넌트 이름

**규칙:** 루트 `App` 컴포넌트를 제외한 모든 사용자 정의 컴포넌트는 반드시 다단어 이름을 사용한다. HTML 요소는 모두 단일 단어이므로 충돌을 방지한다.

```vue
<!-- Bad -->
<Item />
<!-- Good -->
<TodoItem />
```

---

## 2. 상세한 Prop 정의

**규칙:** 커밋된 코드에서 prop 정의는 가능한 한 상세하게 작성하고, 최소한 타입은 지정해야 한다.

```js
// Bad
const props = defineProps(['status'])

// Good
const props = defineProps({
  status: String
})

// Best
const props = defineProps({
  status: {
    type: String,
    required: true,
    validator: (value) => {
      return ['syncing', 'synced', 'version-conflict', 'error'].includes(value)
    }
  }
})
```

---

## 3. v-for에 key 사용

**규칙:** 컴포넌트의 `v-for`에는 반드시 `key`를 사용한다.

```vue
<!-- Bad -->
<li v-for="todo in todos">{{ todo.text }}</li>

<!-- Good -->
<li v-for="todo in todos" :key="todo.id">{{ todo.text }}</li>
```

---

## 4. v-if와 v-for 혼용 금지

**규칙:** 같은 요소에 `v-if`와 `v-for`를 함께 사용하지 않는다. Vue에서 `v-if`가 `v-for`보다 우선순위가 높아 반복 변수에 접근이 불가하다.

```vue
<!-- Bad -->
<li v-for="user in users" v-if="user.isActive" :key="user.id">

<!-- Good: computed로 필터링 -->
<li v-for="user in activeUsers" :key="user.id">

<!-- Good: template 래퍼 사용 -->
<template v-for="user in users" :key="user.id">
  <li v-if="user.isActive">{{ user.name }}</li>
</template>
```

```js
// Composition API
const activeUsers = computed(() => users.filter((user) => user.isActive))
```

---

## 5. 컴포넌트 스코프 스타일링

**규칙:** 앱 레벨 및 레이아웃 컴포넌트를 제외한 모든 컴포넌트의 스타일은 반드시 스코프를 가져야 한다.

```vue
<!-- Bad: 전역 스타일 -->
<style>
.btn-close { background-color: red; }
</style>

<!-- Good: scoped -->
<style scoped>
.btn-close { background-color: red; }
</style>

<!-- Good: CSS Modules -->
<style module>
.btnClose { background-color: red; }
</style>

<!-- Good: BEM -->
<style>
.c-Button--close { background-color: red; }
</style>
```
