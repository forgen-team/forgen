---
title: Vue 3 스타일 가이드 - Priority C (Recommended)
source: https://vuejs.org/style-guide/rules-recommended
fetched: 2026-05-18
category: style-guide
vue_version: 3
---

# Priority C: Recommended

여러 동등한 선택지가 있을 때 일관성을 위해 권장되는 규칙.

---

## 1. 컴포넌트/인스턴스 옵션 순서 (Options API)

1. `name`
2. `compilerOptions`
3. `components`, `directives`
4. `extends`, `mixins`, `provide`/`inject`
5. `inheritAttrs`, `props`, `emits`, `expose`
6. `setup`
7. `data`, `computed`
8. `watch`, lifecycle hooks (`beforeCreate` → `serverPrefetch` 순서)
9. `methods`
10. `template`/`render`

---

## 2. 요소 속성 순서

1. `is`
2. `v-for`
3. `v-if`, `v-else-if`, `v-else`, `v-show`, `v-cloak`
4. `v-pre`, `v-once`
5. `id`
6. `ref`, `key`
7. `v-model`
8. 기타 바인딩/속성
9. `v-on`
10. `v-html`, `v-text`

---

## 3. 컴포넌트/인스턴스 옵션 사이 빈 줄

여러 줄 속성 사이에는 빈 줄을 추가해 가독성을 높인다.

```js
// Good (Composition API)
defineProps({
  value: {
    type: String,
    required: true
  },

  focused: {
    type: Boolean,
    default: false
  },

  label: String,
})

const formattedValue = computed(() => { /* ... */ })

const inputClasses = computed(() => { /* ... */ })
```

---

## 4. SFC 최상위 요소 순서

`<script>`, `<template>`, `<style>` 순서를 프로젝트 전체에서 일관되게 유지한다. `<style>`은 항상 마지막.

```vue
<!-- Option 1: script first -->
<script>/* ... */</script>
<template>...</template>
<style>/* ... */</style>

<!-- Option 2: template first -->
<template>...</template>
<script>/* ... */</script>
<style>/* ... */</style>
```
