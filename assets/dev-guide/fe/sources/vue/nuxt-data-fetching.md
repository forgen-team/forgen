---
title: Nuxt 3 데이터 페칭 (useFetch / useAsyncData / SSR hydration)
source: https://nuxt.com/docs/getting-started/data-fetching
fetched: 2026-05-18
category: nuxt
vue_version: 3
---

# Nuxt 3 데이터 페칭 완전 가이드

---

## 핵심 도구 3가지

| 도구 | 용도 |
|------|------|
| `$fetch` | 클라이언트 사이드 단순 요청 |
| `useFetch` | SSR-safe 초기 데이터 페칭 (most common) |
| `useAsyncData` | 세밀한 제어가 필요할 때 |

---

## 왜 useFetch/useAsyncData가 필요한가?

유니버설 렌더링 환경에서 `$fetch`를 setup에서 직접 호출하면 서버와 클라이언트에서 **두 번 실행**된다. → hydration mismatch, 불필요한 네트워크 요청 발생.

`useFetch`/`useAsyncData`는 서버에서 페칭한 데이터를 payload에 담아 클라이언트로 전달하여 재요청을 방지한다.

```
useNuxtApp().payload  ← 서버 → 클라이언트 데이터 전달 경로
```

---

## $fetch

```vue
<script setup lang="ts">
async function addTodo() {
  const todo = await $fetch('/api/todos', {
    method: 'POST',
    body: { /* todo data */ }
  })
}
</script>
```

**주의:** `$fetch` 단독 사용 시 deduplication과 navigation blocking이 없다. 초기 페이지 데이터에는 사용 금지.

---

## useFetch

```vue
<script setup lang="ts">
const { data: count } = await useFetch('/api/count')
</script>

<template>
  <p>Page visits: {{ count }}</p>
</template>
```

`useFetch(url)` ≈ `useAsyncData(url, () => event.$fetch(url))` — 가장 흔한 패턴의 syntactic sugar.

---

## useAsyncData

CMS나 서드파티 쿼리 레이어를 사용할 때 적합하다.

```vue
<script setup lang="ts">
const { data, error } = await useAsyncData('users', () => myGetFunction('users'))
</script>
```

**병렬 요청:**
```ts
const { data } = await useAsyncData((_nuxtApp, { signal }) => {
  return Promise.all([
    $fetch('/api/comments', { signal }),
    $fetch('/api/author/12', { signal }),
  ])
})
const comments = computed(() => data.value?.[0])
const author = computed(() => data.value?.[1])
```

**중요:** `useAsyncData`는 Pinia action 호출 등 사이드 이펙트 트리거용이 아니다. 반복 실행 위험이 있으므로 `callOnce`를 사용한다.

---

## 반환값

```ts
const {
  data,      // 결과 ref
  refresh,   // 수동 재요청
  execute,   // 수동 실행 (immediate: false 시)
  clear,     // data를 undefined로 리셋
  error,     // 에러 객체
  status,    // 'idle' | 'pending' | 'success' | 'error'
} = useFetch('/api/users')
```

---

## 주요 옵션

### lazy (비차단 페칭)

```vue
<script setup lang="ts">
const { status, data: posts } = useFetch('/api/posts', { lazy: true })
</script>

<template>
  <div v-if="status === 'pending'">Loading...</div>
  <div v-else>...</div>
</template>
```

단축형: `useLazyFetch`, `useLazyAsyncData`

### server: false (클라이언트 전용)

```ts
const { data: comments } = useFetch('/api/comments', {
  lazy: true,
  server: false,
})
```

### pick / transform (페이로드 최소화)

```ts
// pick: 특정 필드만 선택
const { data: mountain } = await useFetch('/api/mountains/everest', {
  pick: ['title', 'description'],
})

// transform: 변환 함수
const { data: mountains } = await useFetch('/api/mountains', {
  transform: (mountains) =>
    mountains.map((m) => ({ title: m.title, description: m.description }))
})
```

### watch (반응형 재실행)

```ts
const id = ref(1)
const { data } = await useFetch('/api/users', { watch: [id] })
```

### computed URL (동적 URL)

```vue
<script setup lang="ts">
const id = ref(null)
const { data, status } = useLazyFetch(() => `/api/users/${id.value}`, {
  immediate: false,
})
</script>
```

### immediate: false (수동 실행)

```vue
<script setup lang="ts">
const { data, execute, status } = await useLazyFetch('/api/comments', {
  immediate: false,
})
</script>
<template>
  <div v-if="status === 'idle'">
    <button @click="execute">Get data</button>
  </div>
  <div v-else-if="status === 'pending'">Loading...</div>
  <div v-else>{{ data }}</div>
</template>
```

---

## SSR 헤더 & 쿠키

**브라우저 요청:** 쿠키가 `$fetch`에 자동 포함.

**서버 사이드:** `useFetch`는 `useRequestFetch`로 클라이언트 헤더/쿠키를 자동 프록시.

수동 전달:
```vue
<script setup lang="ts">
const headers = useRequestHeaders(['cookie'])
const user = await $fetch('/api/me', { headers })
</script>
```

**절대 프록시하면 안 되는 헤더:** `host`, `accept`, `content-length`, `content-md5`, `content-type`, `x-forwarded-*`, `cf-connecting-ip`, `cf-ray`

---

## 데이터 직렬화

### useAsyncData (서버→클라이언트): `devalue` 사용
- 지원 타입: 기본 JSON + RegExp, Date, Map, Set, Vue ref, NuxtError

### 서버 API 라우트: `JSON.stringify` 사용
- Date 등 복잡한 타입 직렬화 시 `toJSON()` 또는 `superjson` 활용 필요

```ts
// 서버
export default defineEventHandler(() => ({
  createdAt: new Date(),
  toJSON() {
    return { createdAt: { year: this.createdAt.getFullYear(), /* ... */ } }
  }
}))
```

---

## 핵심 요약

1. 클라이언트 인터랙션 → `$fetch`
2. 초기 페이지 데이터 → `useFetch`
3. CMS/서드파티 API → `useAsyncData`
4. navigation 비차단 → `lazy: true` 또는 `useLazyFetch`
5. 캐시 키를 custom composable에서 명시적으로 지정
6. 동적 URL은 computed 함수 형태로 전달
