---
title: 매직 넘버 없애기
source: https://frontend-fundamentals.com/code-quality/code/examples/magic-number-cohesion.html
fetched: 2026-05-18
principle: cohesion
---

# 매직 넘버 없애기

**매직 넘버**(Magic Number)란 정확한 뜻을 밝히지 않고 소스 코드 안에 직접 숫자 값을 넣는 것을 말해요.

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

### 응집도

`300`이라고 하는 숫자를 애니메이션 완료를 기다리려고 사용했다면, 재생하는 애니메이션을 바꿨을 때 조용히 서비스가 깨질 수 있는 위험성이 있어요.
충분한 시간동안 애니메이션을 기다리지 않고 바로 다음 로직이 시작될 수도 있죠.

같이 수정되어야 할 코드 중 한쪽만 수정된다는 점에서, 응집도가 낮은 코드라고도 할 수 있어요.

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

이렇게 하면 애니메이션 지속 시간이 변경될 때, 상수 하나만 수정하면 관련된 모든 곳이 함께 수정돼요.
