---
title: 같은 종류의 함수는 반환 타입 통일하기
source: https://frontend-fundamentals.com/code-quality/code/examples/use-user.html
fetched: 2026-05-18
principle: predictability
---

# 같은 종류의 함수는 반환 타입 통일하기

API 호출과 관련된 Hook들처럼 같은 종류의 함수나 Hook이 서로 다른 반환 타입을 가지면 코드의 일관성이 떨어져서, 같이 일하는 동료들이 코드를 읽는 데에 헷갈릴 수 있어요.

## 📝 코드 예시 1: useUser

다음 `useUser` 와 `useServerTime` Hook은 모두 API 호출과 관련된 Hook이에요.

```typescript
function useUser() {
  const query = useQuery({
    queryKey: ["user"],
    queryFn: fetchUser
  });

  return query; // Query 객체 반환
}

function useServerTime() {
  const query = useQuery({
    queryKey: ["serverTime"],
    queryFn: fetchServerTime
  });

  return query.data; // 데이터만 반환
}
```

### 👃 코드 냄새 맡아보기

#### 예측 가능성

서버 API를 호출하는 Hook의 반환 타입이 서로 다르다면, 동료들은 이런 Hook을 쓸 때마다 반환 타입이 무엇인지 확인해야 해요.

같은 종류의 동작을 하는 코드가 일관적인 규칙에 따르고 있지 않으면 코드를 읽고 쓰는 데 헷갈려요.

### ✏️ 개선해보기

서버 API를 호출하는 Hook은 일관적으로 `Query` 객체를 반환하게 하면, 팀원들이 코드에 대한 예측 가능성을 높일 수 있어요.

```typescript
function useUser() {
  const query = useQuery({ queryKey: ["user"], queryFn: fetchUser });
  return query;
}

function useServerTime() {
  const query = useQuery({ queryKey: ["serverTime"], queryFn: fetchServerTime });
  return query; // 이제 Query 객체 반환으로 통일
}
```

## 📝 코드 예시 2: checkIsValid

유효성 검사 함수도 동일한 패턴의 안티패턴이 나타나요.

```typescript
/** 이름 검사: boolean 반환 */
function checkIsNameValid(name: string) {
  return name.length > 0 && name.length < 20;
}

/** 나이 검사: { ok, reason } 객체 반환 */
function checkIsAgeValid(age: number) {
  if (!Number.isInteger(age)) {
    return { ok: false, reason: "나이는 정수여야 해요." };
  }
  if (age < 18) {
    return { ok: false, reason: "나이는 18세 이상이어야 해요." };
  }
  if (age > 99) {
    return { ok: false, reason: "나이는 99세 이하이어야 해요." };
  }
  return { ok: true };
}
```

### 👃 코드 냄새 맡아보기

#### 예측 가능성

반환 값이 다르면 항상 객체인 `{ ok, ... }`는 truthy라서 `if (checkIsAgeValid(age))` 가 항상 실행되는 버그가 발생할 수 있어요.

### ✏️ 개선해보기

Discriminated Union 타입으로 통일:

```typescript
type ValidationCheckReturnType = { ok: true } | { ok: false; reason: string };

function checkIsNameValid(name: string): ValidationCheckReturnType {
  if (name.length === 0) return { ok: false, reason: "이름은 빈 값일 수 없어요." };
  if (name.length >= 20) return { ok: false, reason: "이름은 20자 이상 입력할 수 없어요." };
  return { ok: true };
}

function checkIsAgeValid(age: number): ValidationCheckReturnType {
  if (!Number.isInteger(age)) return { ok: false, reason: "나이는 정수여야 해요." };
  if (age < 18) return { ok: false, reason: "나이는 18세 이상이어야 해요." };
  if (age > 99) return { ok: false, reason: "나이는 99세 이하이어야 해요." };
  return { ok: true };
}
```
