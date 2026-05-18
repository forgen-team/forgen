---
title: Server Functions ('use server' / 'use client')
source: https://react.dev/reference/rsc/server-functions
fetched: 2026-05-18
category: rsc
react_version: 19
---

## 개요

Server Functions는 `"use server"` 디렉티브로 정의된 서버에서 실행되는 비동기 함수. Client Component에서 호출 가능.

> **Note**: 2024년 9월 이전에는 "Server Actions"라고 불렸음. Server Actions는 action props에 전달되거나 action 내부에서 호출되는 Server Functions이지만, 모든 Server Functions가 Server Actions는 아님.

**동작 원리**: 프레임워크가 자동으로 함수 참조를 생성하고, 클라이언트에서 호출 시 서버로 요청을 전송하고 결과를 반환.

---

## 'use server' vs 'use client'

| 디렉티브 | 위치 | 의미 |
|----------|------|------|
| `"use server"` | 파일 상단 또는 함수 첫 줄 | 이 함수/모듈은 서버에서만 실행 |
| `"use client"` | 파일 상단 | 이 컴포넌트는 클라이언트에서 실행 |
| (없음) | — | Server Component (기본값) |

---

## 사용 패턴

### 1. Server Component 내부에서 Server Function 정의

```js
// Server Component
import Button from './Button';

function EmptyNote() {
  async function createNoteAction() {
    'use server'; // 함수 레벨 디렉티브

    await db.notes.create();
  }

  return <Button onClick={createNoteAction} />;
}
```

Client Component에서 참조 확인:
```js
"use client";

export default function Button({ onClick }) {
  console.log(onClick);
  // { $$typeof: Symbol.for("react.server.reference"), $$id: 'createNoteAction' }
  return <button onClick={() => onClick()}>Create Empty Note</button>;
}
```

### 2. 별도 파일에서 Server Functions 내보내기

```js
// actions.js
"use server"; // 파일 레벨 디렉티브

export async function createNote() {
  await db.notes.create();
}
```

```js
// Client Component
"use client";
import { createNote } from './actions';

function EmptyNote() {
  return <button onClick={() => createNote()} />;
}
```

### 3. useTransition과 함께 (Actions)

```js
// actions.js
"use server";

export async function updateName(name) {
  if (!name) {
    return { error: 'Name is required' };
  }
  await db.users.updateName(name);
}
```

```js
// Client Component
"use client";
import { updateName } from './actions';
import { useTransition, useState } from 'react';

function UpdateName() {
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [isPending, startTransition] = useTransition();

  const submitAction = async () => {
    startTransition(async () => {
      const { error } = await updateName(name);
      if (error) {
        setError(error);
      } else {
        setName('');
      }
    });
  };

  return (
    <form action={submitAction}>
      <input type="text" name="name" disabled={isPending} />
      {error && <span>Failed: {error}</span>}
    </form>
  );
}
```

### 4. Form Action으로 직접 사용

```js
"use client";
import { updateName } from './actions';

function UpdateName() {
  return (
    <form action={updateName}>
      <input type="text" name="name" />
    </form>
  );
}
```

> 성공 시 React가 자동으로 폼 리셋.

### 5. useActionState와 조합

```js
"use client";
import { updateName } from './actions';
import { useActionState } from 'react';

function UpdateName() {
  const [state, submitAction, isPending] = useActionState(updateName, { error: null });

  return (
    <form action={submitAction}>
      <input type="text" name="name" disabled={isPending} />
      {state.error && <span>Failed: {state.error}</span>}
    </form>
  );
}
```

**이점:**
- pending state 접근
- 마지막 반환 응답 접근
- hydration 전 폼 자동 재실행
- 점진적 향상 지원

### 6. 점진적 향상 (Progressive Enhancement)

```js
"use client";
import { updateName } from './actions';
import { useActionState } from 'react';

function UpdateName() {
  const [, submitAction] = useActionState(updateName, null, `/name/update`);

  return (
    <form action={submitAction}>
      {/* form fields */}
    </form>
  );
}
```

> 세 번째 인자(permalink)를 전달하면 JavaScript 로드 전 폼 제출 시 해당 URL로 리다이렉트.

---

## API 안정성

- React 19의 Server Functions 자체: stable
- 번들러/프레임워크 구현 API: semver 미준수, 마이너 버전 간 breaking change 가능
