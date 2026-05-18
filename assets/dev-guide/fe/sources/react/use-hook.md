---
title: use() Hook
source: https://react.dev/reference/react/use
fetched: 2026-05-18
category: api
react_version: 19
---

## 개요

`use`는 Promise 또는 Context 값을 읽을 수 있는 React API.

```js
const value = use(resource);
```

**일반 Hook과의 차이점:**
- `if`, `for` 등 조건문·반복문 안에서도 호출 가능
- Component 또는 Hook 내부에서만 호출 가능

---

## 시그니처

### `use(resource)`

#### Parameters
- `resource`: 읽을 데이터 소스. Promise 또는 Context.

#### Returns
Promise의 resolved 값 또는 Context 값.

#### Caveats
1. Component 또는 Hook 안에서만 호출
2. Server Component에서는 `use` 대신 `async/await` 선호
3. Client Component에서 Promise를 생성하면 렌더마다 재생성됨 → Server Component에서 생성해 props로 전달

---

## 사용 패턴

### Context 읽기

```js
import { use } from 'react';

function Button() {
  const theme = use(ThemeContext);
  // ...
}
```

**조건부 호출 (일반 Hook은 불가, use는 가능):**
```js
function HorizontalRule({ show }) {
  if (show) {
    const theme = use(ThemeContext);
    return <hr className={theme} />;
  }
  return false;
}
```

> `use(context)`는 컴포넌트 자신이 아닌 가장 가까운 상위 Provider를 탐색.

---

### 서버→클라이언트 데이터 스트리밍

**Server Component:**
```js
import { fetchMessage } from './lib.js';
import { Message } from './message.js';

export default function App() {
  const messagePromise = fetchMessage();
  return (
    <Suspense fallback={<p>waiting for message...</p>}>
      <Message messagePromise={messagePromise} />
    </Suspense>
  );
}
```

**Client Component:**
```js
// message.js
'use client';

import { use } from 'react';

export function Message({ messagePromise }) {
  const messageContent = use(messagePromise);
  return <p>Here is the message: {messageContent}</p>;
}
```

> Promise resolved 값은 직렬화 가능해야 함 (함수 전달 불가).

---

### 거부된 Promise 처리

**Error Boundary 사용:**
```js
import { use, Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";

export function MessageContainer({ messagePromise }) {
  return (
    <ErrorBoundary fallback={<p>⚠️Something went wrong</p>}>
      <Suspense fallback={<p>⌛Downloading message...</p>}>
        <Message messagePromise={messagePromise} />
      </Suspense>
    </ErrorBoundary>
  );
}
```

**Promise.catch 사용:**
```js
const messagePromise = new Promise((resolve, reject) => {
  reject();
}).catch(() => {
  return "no new message found.";
});
```

> `use`는 try-catch 블록 안에서 호출 불가. Error Boundary 또는 Promise.catch 사용.

---

## Troubleshooting

**"Suspense Exception: This is not a real error!"**
- `use`를 React Component/Hook 외부에서 호출했거나
- try-catch 블록 안에서 호출한 경우

❌ 잘못된 예:
```jsx
function MessageComponent({ messagePromise }) {
  function download() {
    const message = use(messagePromise); // 중첩 함수 내부 → 오류
  }
}
```

✅ 올바른 예:
```jsx
function MessageComponent({ messagePromise }) {
  const message = use(messagePromise); // 컴포넌트 최상위 → 정상
}
```
