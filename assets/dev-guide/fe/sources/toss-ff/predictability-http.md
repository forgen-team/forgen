---
title: 이름 겹치지 않게 관리하기
source: https://frontend-fundamentals.com/code-quality/code/examples/http.html
fetched: 2026-05-18
principle: predictability
---

# 이름 겹치지 않게 관리하기

같은 이름을 가지는 함수나 변수는 동일한 동작을 해야 해요. 작은 동작 차이가 코드의 예측 가능성을 낮추고, 코드를 읽는 사람에게 혼란을 줄 수 있어요.

## 📝 코드 예시

어떤 프론트엔드 서비스에서 원래 사용하던 HTTP 라이브러리를 감싸서 새로운 형태로 HTTP 요청을 보내는 모듈을 만들었어요.
공교롭게 원래 HTTP 라이브러리와 새로 만든 HTTP 모듈의 이름은 `http`로 같아요.

```typescript
// http.ts
import { http as httpLibrary } from "@some-library/http";

export const http = {
  async get(url: string) {
    const token = await fetchToken();

    return httpLibrary.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
  }
};
```

```typescript
// fetchUser.ts
import { http } from "./http";

export async function fetchUser() {
  return http.get("...");
}
```

## 👃 코드 냄새 맡아보기

### 예측 가능성

이 코드는 기능적으로 문제가 없지만, 읽는 사람에게 혼란을 줄 수 있어요. `http.get`을 호출하는 개발자는 이 함수가 원래의 HTTP 라이브러리가 하는 것처럼 단순한 GET 요청을 보내는 것으로 예상하지만, 실제로는 토큰을 가져오는 추가 작업이 수행돼요.

오해로 인해서 기대 동작과 실제 동작의 차이가 생기고, 버그가 발생하거나, 디버깅 과정을 복잡하고 혼란스럽게 만들 수 있어요.

## ✏️ 개선해보기

서비스에서 만든 함수에는 라이브러리의 함수명과 구분되는 명확한 이름을 사용해서 함수의 동작을 예측 가능하게 만들 수 있어요.

```typescript
// httpService.ts
import { http as httpLibrary } from "@some-library/http";

export const httpService = {
  async getWithAuth(url: string) {
    const token = await fetchToken();

    return httpLibrary.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
  }
};
```

```typescript
// fetchUser.ts
import { httpService } from "./httpService";

export async function fetchUser() {
  return await httpService.getWithAuth("...");
}
```

이렇게 해서 함수의 이름을 봤을 때 동작을 오해할 수 있는 가능성을 줄일 수 있어요.
