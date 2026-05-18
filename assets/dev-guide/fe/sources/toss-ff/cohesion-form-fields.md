---
title: 폼의 응집도 생각하기
source: https://frontend-fundamentals.com/code-quality/code/examples/form-fields.html
fetched: 2026-05-18
principle: cohesion
---

# 폼의 응집도 생각하기

프론트엔드 개발을 하다 보면 Form으로 사용자에게 값을 입력받아야 하는 경우가 많아요.
Form을 관리할 때는 2가지의 방법으로 응집도를 관리해서, 함께 수정되어야 할 코드가 함께 수정되도록 할 수 있어요.

## 필드 단위 응집도

필드 단위 응집은 개별 입력 요소를 독립적으로 관리하는 방식이에요.
각 필드가 고유의 검증 로직을 가지므로 변경이 필요한 범위가 줄어들어 특정 필드의 유지보수가 쉬워져요.

```tsx
import { useForm } from "react-hook-form";

export function Form() {
  const { register, formState: { errors }, handleSubmit } = useForm({
    defaultValues: { name: "", email: "" }
  });

  return (
    <form onSubmit={handleSubmit(console.log)}>
      <div>
        <input
          {...register("name", {
            validate: (value) =>
              isEmptyStringOrNil(value) ? "이름을 입력해주세요." : ""
          })}
          placeholder="이름"
        />
        {errors.name && <p>{errors.name.message}</p>}
      </div>

      <div>
        <input
          {...register("email", {
            validate: (value) => {
              if (isEmptyStringOrNil(value)) return "이메일을 입력해주세요.";
              if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(value))
                return "유효한 이메일 주소를 입력해주세요.";
              return "";
            }
          })}
          placeholder="이메일"
        />
        {errors.email && <p>{errors.email.message}</p>}
      </div>

      <button type="submit">제출</button>
    </form>
  );
}
```

## 폼 전체 단위 응집도

폼 전체 응집은 모든 필드의 검증 로직이 폼에 종속되는 방식이에요.

```tsx
import * as z from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

const schema = z.object({
  name: z.string().min(1, "이름을 입력해주세요."),
  email: z
    .string()
    .min(1, "이메일을 입력해주세요.")
    .email("유효한 이메일 주소를 입력해주세요.")
});

export function Form() {
  const { register, formState: { errors }, handleSubmit } = useForm({
    defaultValues: { name: "", email: "" },
    resolver: zodResolver(schema)
  });

  return (
    <form onSubmit={handleSubmit(console.log)}>
      <div>
        <input {...register("name")} placeholder="이름" />
        {errors.name && <p>{errors.name.message}</p>}
      </div>
      <div>
        <input {...register("email")} placeholder="이메일" />
        {errors.email && <p>{errors.email.message}</p>}
      </div>
      <button type="submit">제출</button>
    </form>
  );
}
```

## 필드 단위 vs. 폼 전체 단위 응집도

### 필드 단위 응집도를 선택하면 좋을 때

- **독립적인 검증이 필요할 때**: 이메일 형식 검사, 아이디 중복 확인, 추천 코드 유효성 확인처럼 각 필드가 독립적이고 고유한 검증이 필요할 때
- **재사용이 필요할 때**: 필드와 검증 로직이 다른 폼에서도 동일하게 사용될 수 있는 경우

### 폼 전체 단위 응집도를 선택하면 좋을 때

- **단일 기능을 나타낼 때**: 결제 정보나 배송 정보처럼 모든 필드가 하나의 비즈니스 로직을 이룰 때
- **단계별 입력이 필요할 때**: Wizard Form과 같이 스텝별로 동작하는 복잡한 폼
- **필드 간 의존성이 있을 때**: 비밀번호 확인이나 총액 계산처럼 필드 간 상호작용이 필요할 때
