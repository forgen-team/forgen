---
title: useFormStatus / form action={} 패턴
source: https://react.dev/reference/react-dom/hooks/useFormStatus
fetched: 2026-05-18
category: api
react_version: 19
---

## 개요

`useFormStatus`는 가장 가까운 부모 `<form>`의 제출 상태 정보를 제공하는 Hook.

```js
const { pending, data, method, action } = useFormStatus();
```

---

## 반환값

| 속성 | 타입 | 설명 |
|------|------|------|
| `pending` | `boolean` | 부모 `<form>` 제출 중이면 `true` |
| `data` | `FormData \| null` | 제출 중인 폼 데이터; 없으면 `null` |
| `method` | `string` | HTTP 메서드 (`'get'` \| `'post'`, 기본 `'get'`) |
| `action` | `function \| null` | 부모 `<form>`의 `action` prop 함수; URI이거나 없으면 `null` |

---

## 핵심 제약 (Critical)

> `useFormStatus`를 호출하는 컴포넌트는 반드시 `<form>` **내부**에 렌더링되어야 함.
> `<form>`을 렌더링하는 **같은 컴포넌트**에서는 호출 불가.

❌ 잘못된 패턴:
```js
function Form() {
  const { pending } = useFormStatus(); // 🚩 pending은 절대 true가 되지 않음
  return <form action={submit}></form>;
}
```

✅ 올바른 패턴:
```js
function Submit() {
  const { pending } = useFormStatus(); // ✅
  return <button disabled={pending}>...</button>;
}

function Form() {
  return (
    <form action={submit}>
      <Submit />
    </form>
  );
}
```

---

## 사용 패턴

### 제출 중 버튼 비활성화

```js
import { useFormStatus } from "react-dom";
import action from './actions';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Submitting..." : "Submit"}
    </button>
  );
}

export default function App() {
  return (
    <form action={action}>
      <Submit />
    </form>
  );
}
```

### 제출 중인 폼 데이터 표시

```js
import { useFormStatus } from 'react-dom';

export default function UsernameForm() {
  const { pending, data } = useFormStatus();

  return (
    <div>
      <h3>Request a Username: </h3>
      <input type="text" name="username" disabled={pending} />
      <button type="submit" disabled={pending}>Submit</button>
      <p>{data ? `Requesting ${data?.get("username")}...` : ''}</p>
    </div>
  );
}
```

```js
import UsernameForm from './UsernameForm';
import { submitForm } from "./actions.js";
import { useRef } from 'react';

export default function App() {
  const ref = useRef(null);
  return (
    <form
      ref={ref}
      action={async (formData) => {
        await submitForm(formData);
        ref.current.reset();
      }}
    >
      <UsernameForm />
    </form>
  );
}
```

---

## form action={} 패턴

React 19에서 `<form>`의 `action` prop에 함수를 직접 전달:

```js
// Server Function을 직접 action으로 전달
import { updateName } from './actions'; // "use server" 함수

function UpdateName() {
  return (
    <form action={updateName}>
      <input type="text" name="name" />
      <button type="submit">Update</button>
    </form>
  );
}
```

- 성공 시 React가 자동으로 폼 리셋
- `useActionState`와 조합 시 pending state, 이전 응답 접근 가능
- JavaScript 로드 전에도 동작하는 점진적 향상 지원

---

## Troubleshooting

**`status.pending`이 항상 `false`인 경우:**
1. `useFormStatus` 호출 컴포넌트가 `<form>` 자식으로 렌더링되는지 확인
2. `<form>`을 렌더링하는 같은 컴포넌트에서 호출하지 않았는지 확인
3. 컴포넌트가 `<form>` 경계 내부에 있는지 확인
