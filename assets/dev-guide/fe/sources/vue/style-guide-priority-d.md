---
title: Vue 3 스타일 가이드 - Priority D (Use with Caution)
source: https://vuejs.org/style-guide/rules-use-with-caution
fetched: 2026-05-18
category: style-guide
vue_version: 3
---

# Priority D: Use with Caution

드문 엣지 케이스나 레거시 마이그레이션을 위해 존재하며, 과용 시 유지보수가 어려워진다.

---

## 1. scoped에서 요소 선택자 지양

`scoped`에서 요소 선택자는 class 선택자보다 훨씬 느리다. 반드시 class를 사용한다.

```vue
<!-- Bad: 요소 선택자 (느림) -->
<style scoped>
button { background-color: red; }
</style>

<!-- Good: class 선택자 (빠름) -->
<template>
  <button class="btn btn-close">×</button>
</template>
<style scoped>
.btn-close { background-color: red; }
</style>
```

**이유:** Vue는 `scoped` 사용 시 `button[data-v-f3f3eg9]` 형태로 변환하는데, 이 속성-요소 복합 선택자는 `.btn-close[data-v-f3f3eg9]`보다 현저히 느리다.

---

## 2. 암묵적 부모-자식 통신 지양

`this.$parent`나 prop 직접 변경 대신 props down / events up 패턴을 따른다.

```vue
<!-- Bad: prop 직접 변경 -->
<script setup>
const props = defineProps({ todo: { type: Object, required: true } })

function renameTodo() {
  props.todo.text = 'renamed by child'  // ❌ 부모 상태 직접 변경
}
</script>

<!-- Good: emit으로 업데이트 요청 -->
<script setup>
const props = defineProps({ todo: { type: Object, required: true } })
const emit = defineEmits(['update:todo'])

function renameTodo() {
  emit('update:todo', { ...props.todo, text: 'renamed by parent' })  // ✅
}
</script>
```

```vue
<!-- Bad: this.$parent 사용 -->
<!-- Good: emit('delete') 사용 -->
<script setup>
const emit = defineEmits(['delete'])
</script>
<template>
  <button @click="emit('delete')">×</button>
</template>
```
