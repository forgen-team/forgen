---
title: 매직 넘버에 이름 붙이기
source: https://frontend-fundamentals.com/code-quality/code/examples/magic-number-readability.html
fetched: 2026-05-18
principle: readability
---

# 매직 넘버에 이름 붙이기

**매직 넘버**(Magic Number)란 정확한 뜻을 밝히지 않고 소스 코드 안에 직접 숫자 값을 넣는 것을 말해요.

예를 들어, 찾을 수 없음(Not Found)을 나타내는 HTTP 상태 코드로 `404` 값을 바로 사용하는 것이나,
하루를 나타내는 `86400`초를 그대로 사용하는 것이 있어요.

## 📝 코드 예시

다음 코드는 좋아요 버튼을 눌렀을 때 좋아요 개수를 새로 내려받는 함수예요.

```typescript
async function onLikeClick() {
  await postLike(url);
  await delay(300);
  await refetchPostLike();
}
```

## 👃 코드 냄새 맡아보기

### 가독성

이 코드는 `delay` 함수에 전달된 `300`이라고 하는 값이 어떤 맥락으로 쓰였는지 알 수 없어요.

- 애니메이션이 완료될 때까지 기다리는 걸까?
- 좋아요 반영에 시간이 걸려서 기다리는 걸까?
- 테스트 코드였는데, 깜빡하고 안 지운 걸까?

## ✏️ 개선해보기

숫자 `300`의 맥락을 정확하게 표시하기 위해서 상수 `ANIMATION_DELAY_MS`로 선언할 수 있어요.

```typescript
const ANIMATION_DELAY_MS = 300;

async function onLikeClick() {
  await postLike(url);
  await delay(ANIMATION_DELAY_MS);
  await refetchPostLike();
}
```

## 🔍 더 알아보기

매직 넘버는 응집도 관점에서도 살펴볼 수 있어요. [매직 넘버 없애서 응집도 높이기](./cohesion-magic-number.md) 문서도 참고해 보세요.
