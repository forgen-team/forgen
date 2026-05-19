---
name: fe-build-react
description: React/Next.js 요구사항을 받아 합의된 사내 원칙대로 구현. 명세→체크리스트→테스트 매핑을 강제하고, Server Components·React Compiler·Action 우선 패턴을 적용한다.
---

# fe-build (React)

> **호출 시점**: "요구사항 명세 줄게, 이대로 구현해줘" 같은 신규 기능/페이지/컴포넌트 구현 요청.
> **선행 로딩**: `principles/common.md` + `principles/react.md` 필수.

## 0. 절대 금지

1. 명세 읽기 전에 코드 쓰지 마라.
2. 명세에 없는 UX 결정 추가하지 마라 (명세 100% 충족 후에만).
3. 명세에서 "옵셔널"이라고 한 항목 → 안 골라도 통과 테스트 *반드시* 작성.
4. `useEffect` 안에서 데이터 변환/체인 setState 금지 (`principles/react.md` R2).
5. Client Component 안에서 Server Component import 금지.

## 1. 워크플로우 (이 순서를 깨지 마라)

### Step 1 — 명세 → 체크리스트 변환

명세 문서(또는 사용자 메시지) 받자마자, **다른 어떤 작업도 하기 전에**:

```markdown
## 체크리스트
- [ ] R-01: <명세 요구사항 한 줄>
- [ ] R-02: ...
```

각 항목은 **명세 원문 직접 인용**으로 작성. 해석/추론 금지.
이 체크리스트를 사용자에게 보여주고, 빠진 게 있는지 *확인 후* 다음 단계.

### Step 2 — 체크리스트 → 테스트 라인 매핑표

```markdown
## 매핑표
| 요구사항 | 컴포넌트/함수 | 테스트 파일:케이스 |
|----------|---------------|---------------------|
| R-01 | OrderForm | OrderForm.test.tsx:"제출 시 ..." |
| R-02 | useCart | useCart.test.ts:"select 옵션 미선택 시 통과해야 한다" |
```

**옵셔널 항목은 반드시 "안 골라도 통과" 케이스로 매핑**. 표시(UI 분기)와 검증(로직 분기)이 같은 진실을 보는지 점검 — 이 불일치가 가장 흔한 명세 위반.

### Step 3 — 아키텍처 결정

Server Component 기본. Client Component 가 필요한 신호 (R1) 가 있는 부분만 `'use client'`:

- `useState`/`useEffect` 필요
- 브라우저 API
- 이벤트 핸들러

**결정 기록 한 줄** (코드 주석 X, 사용자 메시지로):
"OrderForm은 Client (제출 핸들러). 상품 목록은 Server (정적)."

### Step 4 — TDD (Red → Green → Refactor)

매핑표의 각 행마다:
1. 테스트 먼저 작성 (실패 확인)
2. 최소 구현으로 통과
3. 리팩터: [`common.md`](../../principles/common.md) 4원칙 적용

### Step 5 — 셀프 리뷰

구현 완료 후 [`fe-review/SKILL.md`](../fe-review/SKILL.md) 의 체크리스트로 자가 점검. 통과 못 한 항목 있으면 Step 4 로 회귀.

### Step 6 — 매핑표 갱신 후 완료 선언

매핑표 모든 행 ✅ + 모든 테스트 green. 그제서야 "완료" 선언.

## 2. 구현 디폴트

### 2.1 데이터 페칭

```tsx
// Server Component — 기본
export default async function Page({ params }) {
  const data = await fetch(`/api/items/${params.id}`, {
    next: { tags: [`item-${params.id}`], revalidate: 60 }
  }).then(r => r.json());
  return <ItemView data={data} />;
}

// Client Component — 인터랙션 후 mutation
'use client';
import { useActionState } from 'react';
async function submitAction(state, formData) {
  'use server';
  await db.update(...);
  revalidateTag(`item-${id}`); // 캐시 무효화 필수
  return { ok: true };
}
```

### 2.2 폼

- 단순 폼 → `<form action>` + `useActionState` + `useFormStatus`
- 복잡한 검증 → React Hook Form + zod (조건: 5+ 필드 또는 cross-field 검증)
- **검증 규칙은 `optional` 케이스 빠뜨리지 마라** (`z.string().optional()` 분기 명시)

### 2.3 상태

- 로컬: `useState`
- 페이지 단위 파생: `useSearchParams` (URL 단일 진실)
- 글로벌: Zustand 또는 Jotai (Redux 신규 도입 지양)
- 서버 상태: React Query (Pages Router) 또는 RSC fetch + revalidate (App Router)

### 2.4 스타일

- Tailwind 또는 CSS Module + 디자인 토큰 (사내 디자인 시스템 우선)
- `next/image` 강제 (`<img>` 직접 사용 시 [HIGH] 리뷰 대상)

### 2.5 접근성 디폴트

- 폼: `<label htmlFor>` 또는 `aria-label`
- 버튼 vs 링크: 동작 = `<button>`, 이동 = `<Link>`
- 모달: `<dialog>` 또는 focus trap 라이브러리 + `aria-modal`
- 인터랙티브 영역 최소 24×24 CSS px (WCAG 2.5.8)

## 3. 출력 형식

작업 완료 시 사용자에게:

```
## 완료 보고
- 체크리스트: 5/5 ✅
- 매핑표: 모든 행 테스트 green
- 변경 파일: <목록>
- 셀프 리뷰: principles/react.md R1-R9 통과
- 의사결정: <Server/Client 분리 기준 1-2줄>
```

## 4. 관련 문서

- 원칙: [`principles/common.md`](../../principles/common.md), [`principles/react.md`](../../principles/react.md)
- 리뷰: [`skills/react/fe-review/SKILL.md`](../fe-review/SKILL.md)
- 성능: [`skills/react/fe-perf/SKILL.md`](../fe-perf/SKILL.md)
- 코퍼스 원본: `sources/react/`, `sources/perf/`, `sources/toss-ff/`
