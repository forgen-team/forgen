---
title: Vue 3 스타일 가이드 - Priority B (Strongly Recommended)
source: https://vuejs.org/style-guide/rules-strongly-recommended
fetched: 2026-05-18
category: style-guide
vue_version: 3
---

# Priority B: Strongly Recommended

코드 가독성과 DX를 향상시킨다. 위반 시 코드는 동작하나 정당한 이유가 있어야 한다.

---

## 1. 컴포넌트 파일 분리

각 컴포넌트는 별도 파일로 분리한다.

```
components/
|- TodoList.vue
|- TodoItem.vue
```

---

## 2. SFC 파일명 케이싱

PascalCase 또는 kebab-case 중 하나를 일관되게 사용한다.

```
# Good (PascalCase)
components/|- MyComponent.vue

# Good (kebab-case)
components/|- my-component.vue
```

---

## 3. 베이스 컴포넌트 이름 접두사

순수 프레젠테이션 컴포넌트는 `Base`, `App`, `V` 접두사를 붙인다.

```
# Bad
|- MyButton.vue, Icon.vue

# Good
|- BaseButton.vue, BaseTable.vue, BaseIcon.vue
```

Vite 자동 전역 등록:
```js
const modules = import.meta.glob('./src/**/Base*.vue', { eager: true })
for (const path in modules) {
  const config = modules[path].default
  const name = config.name || path.match(/Base[A-Z]\w+/)[0]
  app.component(name, config)
}
```

---

## 4. 강하게 결합된 컴포넌트 이름

부모에 종속된 자식 컴포넌트는 부모 이름을 접두사로 사용한다.

```
# Bad
|- TodoList.vue, TodoItem.vue, TodoButton.vue

# Good (연관성 명확)
|- TodoList.vue, TodoListItem.vue, TodoListItemButton.vue
```

---

## 5. 컴포넌트 이름 단어 순서

가장 일반적인 단어부터 시작하고, 수식어를 뒤에 붙인다.

```
# Bad
|- ClearSearchButton.vue, RunSearchButton.vue

# Good
|- SearchButtonClear.vue, SearchButtonRun.vue, SearchInputQuery.vue
```

---

## 6. 셀프 클로징 컴포넌트

SFC/JSX에서 콘텐츠 없는 컴포넌트는 셀프 클로징한다. in-DOM 템플릿에서는 사용하지 않는다.

```vue
<!-- Good: SFC/JSX -->
<MyComponent/>

<!-- Good: in-DOM template -->
<my-component></my-component>
```

---

## 7. 템플릿에서 컴포넌트 이름 케이싱

SFC: PascalCase / in-DOM: kebab-case

```vue
<MyComponent/>          <!-- SFC -->
<my-component></my-component>  <!-- in-DOM -->
```

---

## 8. JS/JSX에서 PascalCase

```js
import MyComponent from './MyComponent.vue'
export default { name: 'MyComponent' }
```

---

## 9. Prop 이름 케이싱

선언: camelCase / in-DOM 템플릿: kebab-case

```js
// 선언
const props = defineProps({ greetingText: String })
```

```vue
<!-- SFC -->
<WelcomeMessage greeting-text="hi"/>
<!-- in-DOM -->
<welcome-message greeting-text="hi"></welcome-message>
```

---

## 10. 멀티 속성 요소 줄 분리

여러 속성은 한 줄에 하나씩 작성한다.

```vue
<!-- Bad -->
<MyComponent foo="a" bar="b" baz="c"/>

<!-- Good -->
<MyComponent
  foo="a"
  bar="b"
  baz="c"
/>
```

---

## 11. 템플릿에서 단순 표현식

복잡한 로직은 computed나 method로 분리한다.

```vue
<!-- Bad -->
{{ fullName.split(' ').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ') }}

<!-- Good -->
{{ normalizedFullName }}
```

```js
const normalizedFullName = computed(() =>
  fullName.value
    .split(' ')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')
)
```

---

## 12. 단순 computed 속성

복잡한 computed는 여러 단순한 속성으로 분리한다.

```js
// Bad
const price = computed(() => {
  const basePrice = manufactureCost.value / (1 - profitMargin.value)
  return basePrice - basePrice * (discountPercent.value || 0)
})

// Good
const basePrice = computed(() => manufactureCost.value / (1 - profitMargin.value))
const discount = computed(() => basePrice.value * (discountPercent.value || 0))
const finalPrice = computed(() => basePrice.value - discount.value)
```

---

## 13. 속성 값 인용

비어있지 않은 HTML 속성 값은 항상 따옴표로 감싼다.

```vue
<!-- Bad -->
<input type=text>

<!-- Good -->
<input type="text">
```

---

## 14. 디렉티브 단축형 일관성

`:`, `@`, `#` 단축형을 항상 사용하거나, 항상 사용하지 않는다. 혼용 금지.

```vue
<!-- Good: 항상 단축형 -->
<input :value="val" @input="onInput">
<template #header>...</template>

<!-- Good: 항상 전체형 -->
<input v-bind:value="val" v-on:input="onInput">
<template v-slot:header>...</template>
```
