---
title: useActionState
source: https://react.dev/reference/react/useActionState
fetched: 2026-05-18
category: api
react_version: 19
---

## 개요

Action(비동기 작업)의 결과로 state를 관리하는 Hook. 폼 제출 및 비동기 작업에 특히 유용.

---

## 시그니처

```js
const [state, dispatchAction, isPending] = useActionState(reducerAction, initialState, permalink?);
```

### Parameters
- `reducerAction`: `(previousState, actionPayload) => newState` — 사이드 이펙트 수행 후 새 state 반환
- `initialState`: 초기 state (첫 dispatch 이후 무시됨)
- `permalink?` (optional): Server Components 점진적 향상을 위한 URL

### Returns
1. **현재 state** — 초기엔 `initialState`, 이후엔 `reducerAction` 반환값
2. **`dispatchAction`** — action을 트리거하는 함수
3. **`isPending`** — action 처리 중 여부 boolean

---

## 사용 패턴

### 기본 사용

```js
const [count, dispatchAction, isPending] = useActionState(
  async (prevCount) => await addToCart(prevCount),
  0
);

function handleClick() {
  startTransition(() => {
    dispatchAction();
  });
}
```

### 여러 액션 타입 처리

```js
async function updateCartAction(prevCount, actionPayload) {
  switch (actionPayload.type) {
    case 'ADD':
      return await addToCart(prevCount);
    case 'REMOVE':
      return await removeFromCart(prevCount);
  }
  return prevCount;
}

const [count, dispatchAction, isPending] = useActionState(updateCartAction, 0);
dispatchAction({ type: 'ADD' });
```

### Form Action과 함께 사용

```js
<form action={dispatchAction}>
  <input name="quantity" type="number" />
  <button type="submit">Add to Cart</button>
</form>
```

> form과 함께 사용 시 `reducerAction`은 `(previousState, formData)`를 받음.

### useOptimistic과 조합

```js
const [count, dispatchAction, isPending] = useActionState(updateCartAction, 0);
const [optimisticCount, setOptimisticCount] = useOptimistic(count);

function handleAdd() {
  startTransition(() => {
    setOptimisticCount(c => c + 1);
    dispatchAction({ type: 'ADD' });
  });
}
```

### 에러 처리

```js
async function updateCartAction(prevState, quantity) {
  const result = await addToCart(prevState.count, quantity);
  if (result.error) {
    return { ...prevState, error: result.error };
  }
  return { count: result.count, error: null };
}
```

---

## 주요 Caveats

- 최상위에서만 호출 (loop/조건문 내 불가)
- `dispatchAction` 호출은 순서대로 큐에 쌓여 실행됨
- **반드시 Transition 내에서 호출**: `startTransition` 또는 Action prop (form은 자동 래핑)
- `dispatchAction`은 안정적 참조 → Effect 의존성 트리거 안 함
- Server 사용 시 `initialState`와 `actionPayload`는 직렬화 가능해야 함
- `reducerAction`에서 throw 시 큐 취소 + Error Boundary 트리거 → throw 대신 에러 state 반환 권장

---

## Troubleshooting

| 증상 | 원인 | 해결 |
|------|------|------|
| `isPending`이 업데이트 안 됨 | `startTransition` 누락 | `dispatchAction`을 `startTransition` 안에서 호출 |
| form data 못 읽음 | 두 번째 파라미터가 `formData` | `(prevState, formData)` 시그니처 확인 |
| Action이 스킵됨 | `reducerAction`에서 throw | throw 대신 에러 state 반환 |
