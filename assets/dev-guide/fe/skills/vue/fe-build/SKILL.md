---
name: fe-build-vue
description: Vue 3/Nuxt 3 요구사항을 받아 사내 원칙대로 구현. 명세→체크리스트→테스트 매핑 강제, Composition API + `<script setup>` + Nuxt 데이터 페칭 디폴트.
---

# fe-build (Vue)

> **호출 시점**: "요구사항 명세 줄게, Vue로 구현해줘".
> **선행 로딩**: `principles/common.md` + `principles/vue.md` 필수.

## 0. 절대 금지

1. 명세 읽기 전에 코드 쓰지 마라.
2. 명세에 없는 UX 결정 추가하지 마라.
3. 명세 "옵셔널" 항목 → "안 골라도 통과" 테스트 *반드시*.
4. `reactive` 객체 비구조화 금지 (`principles/vue.md` V3.2).
5. props 비구조화 (3.4 이하) 금지. 3.5+ 에서도 watch source 는 getter 필수.
6. Nuxt: `onMounted` 안 페치 금지 (`useFetch`/`useAsyncData` 사용).

## 1. 워크플로우

### Step 1 — 명세 → 체크리스트

```markdown
## 체크리스트
- [ ] R-01: <명세 원문 인용>
- [ ] R-02: ...
```

해석 없이 원문만. 사용자에게 보여주고 빠진 항목 확인.

### Step 2 — 매핑표

```markdown
| 요구사항 | 컴포넌트/composable | 테스트 |
|----------|---------------------|--------|
| R-01 | OrderForm.vue | OrderForm.spec.ts:"제출 시 ..." |
| R-02 | useCart | useCart.spec.ts:"옵셔널 옵션 미선택 시 통과" |
```

### Step 3 — 아키텍처 결정

상태 위치 결정 (V4.1):
- 단일 컴포넌트: `ref`/`reactive`
- 2+ 컴포넌트 공유: composable
- 싱글톤/SSR: Pinia store

Nuxt 페이지/컴포넌트:
- 페이지 진입 시 데이터: `useFetch` 또는 `useAsyncData`
- 이벤트 후 mutation: `$fetch`
- BFF 필요: `server/api/*.ts`

결정 한 줄 사용자에게 공유.

### Step 4 — TDD (vitest + Vue Test Utils 또는 Nuxt test-utils)

각 매핑표 행마다 Red → Green → Refactor.

### Step 5 — 셀프 리뷰

[`fe-review/SKILL.md`](../fe-review/SKILL.md) 체크리스트로 자가 점검.

### Step 6 — 완료 선언

모든 행 ✅ + 테스트 green.

## 2. 구현 디폴트

### 2.1 SFC 골격

```vue
<script setup lang="ts">
import { ref, computed } from 'vue';

const props = defineProps<{ id: string }>();
const emit = defineEmits<{ submit: [payload: FormPayload] }>();

const count = ref(0);
const double = computed(() => count.value * 2);

function onSubmit() {
  emit('submit', { id: props.id, count: count.value });
}
</script>

<template>
  <form @submit.prevent="onSubmit">
    <!-- ... -->
  </form>
</template>

<style scoped>
/* 클래스 셀렉터 사용 (element 셀렉터 지양) */
</style>
```

### 2.2 데이터 페칭 (Nuxt)

```ts
// 페이지 진입 시 — SSR + hydration 일관
const { data: order, error } = await useFetch(`/api/orders/${route.params.id}`, {
  key: `order-${route.params.id}`,
});

// 이벤트 핸들러
async function onSubmit() {
  const res = await $fetch('/api/orders', { method: 'POST', body: form.value });
  await refreshCookie('order-list'); // 또는 router.push
}
```

### 2.3 폼

- 단순: `ref` + `v-model` + `@submit.prevent`
- 복잡: VeeValidate + zod 또는 Vue 3 + `@vue/reactivity` 기반 폼 라이브러리
- **검증 규칙에 optional 분기 명시** — `z.string().optional()`

### 2.4 상태

- 컴포넌트 로컬: `ref`/`computed`
- 공유 로직: composable (`useOrder.ts`)
- 글로벌: Pinia setup store (`defineStore('order', () => {...})`)
- URL 단일 진실: `useRoute().query` + `navigateTo({ query: ... })`

### 2.5 접근성 디폴트

- 폼: `<label :for="id">` + `:id`
- 동작 vs 이동: `<button>` vs `<NuxtLink>` (또는 `<router-link>`)
- 모달: `<dialog>` + focus trap
- 인터랙티브 24×24 CSS px

## 3. 출력 형식

```
## 완료 보고
- 체크리스트: N/N ✅
- 매핑표: 모든 행 green
- 변경 파일: <목록>
- 셀프 리뷰: principles/vue.md V1-V6 통과
- 의사결정: <상태 위치 / 페칭 함수 선택 근거 1-2줄>
```

## 4. 관련 문서

- [`principles/common.md`](../../principles/common.md), [`principles/vue.md`](../../principles/vue.md)
- [`skills/vue/fe-review/SKILL.md`](../fe-review/SKILL.md)
- [`skills/vue/fe-perf/SKILL.md`](../fe-perf/SKILL.md)
- 코퍼스: `sources/vue/`, `sources/perf/`, `sources/toss-ff/`
