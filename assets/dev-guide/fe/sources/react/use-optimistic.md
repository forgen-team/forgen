---
title: useOptimistic
source: https://react.dev/reference/react/useOptimistic
fetched: 2026-05-18
category: api
react_version: 19
---

## 개요

비동기 Action이 진행되는 동안 UI를 낙관적으로 즉시 업데이트할 수 있는 Hook.

---

## 시그니처

```js
const [optimisticState, setOptimistic] = useOptimistic(value, reducer?);
```

### Parameters
- `value`: 진행 중인 Action이 없을 때 반환할 값
- `reducer(currentState, action)` (optional): 낙관적 state 계산 순수 함수

### Returns
1. **`optimisticState`**: Action 없으면 `value`, Action 중이면 `reducer` 반환값
2. **`set` 함수**: Action 내부에서 낙관적 state를 업데이트

### set 함수 제약
- **반드시 `startTransition` 또는 Action prop 내에서 호출**
- 외부에서 호출 시 경고 + 즉시 원래 값으로 롤백

---

## 동작 흐름

```js
const [value, setValue] = useState('a');
const [optimistic, setOptimistic] = useOptimistic(value);

startTransition(async () => {
  setOptimistic('b');      // 1. 즉시 'b' 표시
  const newValue = await saveChanges('b');  // 2. 서버 요청
  setValue(newValue);      // 3. 실제 state 업데이트 → 낙관적 state 수렴
});
```

> Action 실패 시 자동으로 원래 `value`로 롤백됨.

---

## 사용 패턴

### Form Action과 함께 낙관적 업데이트

```js
import { useOptimistic, startTransition } from 'react';
import { updateName } from './actions.js';

export default function EditName({ name, action }) {
  const [optimisticName, setOptimisticName] = useOptimistic(name);

  async function submitAction(formData) {
    const newName = formData.get('name');
    setOptimisticName(newName); // Action prop 내부이므로 startTransition 불필요

    const updatedName = await updateName(newName);
    startTransition(() => {
      action(updatedName);
    });
  }

  return (
    <form action={submitAction}>
      <p>Your name is: {optimisticName}</p>
      <input type="text" name="name" disabled={name !== optimisticName} />
    </form>
  );
}
```

### Reducer로 복잡한 낙관적 업데이트

```js
const [optimisticState, updateOptimistic] = useOptimistic(
  { isFollowing: user.isFollowing, followerCount: user.followerCount },
  (current, isFollowing) => ({
    isFollowing,
    followerCount: current.followerCount + (isFollowing ? 1 : -1),
  })
);

function handleClick() {
  const newFollowState = !optimisticState.isFollowing;
  startTransition(async () => {
    updateOptimistic(newFollowState);
    await followAction(newFollowState);
  });
}
```

### 목록에 낙관적 항목 추가

```js
const [optimisticTodos, addOptimisticTodo] = useOptimistic(
  todos,
  (currentTodos, newTodo) => [
    ...currentTodos,
    { id: newTodo.id, text: newTodo.text, pending: true },
  ]
);

function handleAddTodo(text) {
  const newTodo = { id: crypto.randomUUID(), text };
  startTransition(async () => {
    addOptimisticTodo(newTodo);
    await addTodoAction(newTodo);
  });
}
```

### 에러 시 롤백 패턴

```js
const [error, setError] = useState(null);
const [optimisticItems, removeItem] = useOptimistic(
  items,
  (currentItems, idToRemove) =>
    currentItems.map(item =>
      item.id === idToRemove ? { ...item, deleting: true } : item
    )
);

function handleDelete(id) {
  setError(null);
  startTransition(async () => {
    removeItem(id);
    try {
      await deleteAction(id);
    } catch (e) {
      setError(e.message); // 실패 시 UI 자동 롤백
    }
  });
}
```

### 여러 독립 낙관적 state

```js
function MyComponent({ age, name, todos }) {
  const [optimisticAge, setOptimisticAge] = useOptimistic(age);
  const [optimisticName, setOptimisticName] = useOptimistic(name);
  const [optimisticTodos, setOptimisticTodos] = useOptimistic(todos, reducer);
}
```

---

## 주요 특성

- **임시성**: Action 진행 중에만 낙관적 state 표시, 완료 후 `value`로 수렴
- **자동 롤백**: Action 실패 시 원래 `value` 렌더링
- **추가 렌더 없음**: Transition 완료 시 낙관적/실제 state가 단일 렌더에서 수렴
- Reducer 사용 시 변경 중인 base state에도 올바르게 적용됨

---

## Troubleshooting

```js
// ❌ Transition 외부에서 호출
function handleClick() {
  setOptimistic(newValue);
}

// ✅ startTransition 내부
function handleClick() {
  startTransition(async () => {
    setOptimistic(newValue);
  });
}
```

**pending 여부 확인 3가지 방법:**
```js
// 1. 값 비교
const isPending = optimisticValue !== value;

// 2. useTransition
const [isPending, startTransition] = useTransition();

// 3. reducer에 pending 플래그 포함
(state, newItem) => [...state, { ...newItem, isPending: true }]
```
