---
title: 시점 이동 줄이기
source: https://frontend-fundamentals.com/code-quality/code/examples/user-policy.html
fetched: 2026-05-18
principle: readability
---

# 시점 이동 줄이기

코드를 읽을 때 코드의 위아래를 왔다갔다 하면서 읽거나, 여러 파일이나 함수, 변수를 넘나들면서 읽는 것을 **시점 이동**이라고 해요.
시점이 여러 번 이동할수록 코드를 파악하는 데에 시간이 더 걸리고, 맥락을 파악하는 데에 어려움이 있을 수 있어요.

## 📝 코드 예시

다음 코드에서는 사용자의 권한에 따라서 버튼을 다르게 보여줘요.

```tsx
function Page() {
  const user = useUser();
  const policy = getPolicyByRole(user.role);

  return (
    <div>
      <Button disabled={!policy.canInvite}>Invite</Button>
      <Button disabled={!policy.canView}>View</Button>
    </div>
  );
}

function getPolicyByRole(role) {
  const policy = POLICY_SET[role];

  return {
    canInvite: policy.includes("invite"),
    canView: policy.includes("view")
  };
}

const POLICY_SET = {
  admin: ["invite", "view"],
  viewer: ["view"]
};
```

## 👃 코드 냄새 맡아보기

### 가독성

이 코드에서 `Invite` 버튼이 비활성화된 이유를 이해하려고 한다면, `policy.canInvite` → `getPolicyByRole(user.role)` → `POLICY_SET` 순으로 코드를 위아래를 오가며 읽어야 해요.
이 과정에서 3번의 시점 이동이 발생해서, 코드를 읽는 사람이 맥락을 유지해 가며 읽기 어려워졌어요.

## ✏️ 개선해보기

### A. 조건을 펼쳐서 그대로 드러내기

```tsx
function Page() {
  const user = useUser();

  switch (user.role) {
    case "admin":
      return (
        <div>
          <Button disabled={false}>Invite</Button>
          <Button disabled={false}>View</Button>
        </div>
      );
    case "viewer":
      return (
        <div>
          <Button disabled={true}>Invite</Button>
          <Button disabled={false}>View</Button>
        </div>
      );
    default:
      return null;
  }
}
```

### B. 조건을 한눈에 볼 수 있는 객체로 만들기

```tsx
function Page() {
  const user = useUser();
  const policy = {
    admin: { canInvite: true, canView: true },
    viewer: { canInvite: false, canView: true }
  }[user.role];

  return (
    <div>
      <Button disabled={!policy.canInvite}>Invite</Button>
      <Button disabled={!policy.canView}>View</Button>
    </div>
  );
}
```
