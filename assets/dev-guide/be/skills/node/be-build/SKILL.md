---
name: be-build-node
description: Node.js/TypeScript 요구사항을 받아 합의된 사내 원칙대로 구현. 명세→API contract→구현→테스트 매핑을 강제하고, 에러 모델·관찰가능성·보안 기준선을 적용한다.
---

# be-build (Node.js)

> **호출 시점**: "이 API 명세대로 구현해줘", "이 요구사항 기반으로 서비스 만들어줘" 같은 신규 기능/API/서비스 구현 요청.
> **선행 로딩**: `principles/common.md` + `principles/node.md` 필수.

## 0. 절대 금지

1. 명세/요구사항 읽기 전에 코드 쓰지 마라.
2. OpenAPI 스펙 없이 구현 먼저 하지 마라 — 계약이 구현보다 먼저.
3. 명세에서 optional인 필드를 검증에서 required 취급하지 마라.
4. `catch (err) {}` 빈 catch 블록 금지.
5. DB 쿼리를 문자열 concatenation으로 작성 금지 (SQL injection).
6. `process.on('unhandledRejection')` 미등록 상태로 완료 선언 금지.

## 1. 워크플로우 (이 순서를 깨지 마라)

### Step 1 — 요구사항 → 체크리스트 변환

명세/요구사항 받자마자, 다른 어떤 작업도 하기 전에:

```markdown
## 요구사항 체크리스트
- [ ] R-01: <요구사항 한 줄 — 명세 원문 직접 인용>
- [ ] R-02: ...
```

- 각 항목은 명세 원문 직접 인용. 해석/추론 금지.
- optional/required 구분 명시. optional은 "없어도 통과" 케이스로 매핑.
- 사용자 확인 후 다음 단계.

### Step 2 — API Contract 정의

체크리스트 확정 후, 구현 전에 OpenAPI 스펙 또는 TypeScript 인터페이스로 계약 작성:

```typescript
// types/order.ts — 계약 먼저
interface CreateOrderRequest {
  userId: string;         // required
  items: OrderItem[];     // required, min: 1
  couponCode?: string;    // optional — 검증에서 required 취급 금지
}

interface CreateOrderResponse {
  orderId: string;
  status: 'pending' | 'confirmed';
  createdAt: string;      // ISO 8601 UTC
}

interface OrderItem {
  productId: string;
  quantity: number;       // positive integer
}
```

### Step 3 — 체크리스트 → 테스트 매핑표

```markdown
## 매핑표
| 요구사항 | 모듈/함수 | 테스트 파일:케이스 |
|----------|-----------|---------------------|
| R-01 | OrderController.create | order.test.ts:"주문 생성 성공" |
| R-02 | OrderService.validate | order.test.ts:"쿠폰 없이도 주문 가능" |
```

- optional 항목은 반드시 "값 없을 때 통과" 케이스를 매핑.
- 에러 케이스도 매핑 (400, 404, 422 등).

### Step 4 — 아키텍처 결정 (레이어 분리)

```
[Controller] → 입력 검증 (Zod) → HTTP 계층
[Service]   → 비즈니스 로직 → 도메인 계층
[Repository]→ DB 접근 → 영속 계층
```

결정 기록 한 줄: "OrderService는 트랜잭션 경계. Repository는 순수 쿼리만."

### Step 5 — TDD (Red → Green → Refactor)

매핑표의 각 행마다:
1. 테스트 먼저 작성 (실패 확인)
2. 최소 구현으로 통과
3. `principles/common.md` + `principles/node.md` 원칙 적용

### Step 6 — 셀프 체크리스트

```markdown
- [ ] Zod 스키마 검증 — optional 필드 optional().처리
- [ ] 에러 응답 구조: { error: { code, message, requestId } }
- [ ] unhandledRejection 핸들러 등록
- [ ] 구조화 로그 (JSON) — 민감정보 제외
- [ ] DB 쿼리 파라미터화 (SQL injection 방지)
- [ ] 트랜잭션 경계 명시
- [ ] TypeScript strict 통과 (tsc --noEmit)
- [ ] N+1 쿼리 없음
```

### Step 7 — 매핑표 갱신 후 완료 선언

매핑표 모든 행 ✅ + 모든 테스트 green + 셀프 체크리스트 통과. 그제서야 "완료" 선언.

## 2. 구현 디폴트

### 2.1 입력 검증 (Zod)

```typescript
import { z } from 'zod';

const CreateOrderSchema = z.object({
  userId: z.string().uuid(),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().positive(),
  })).min(1),
  couponCode: z.string().optional(),  // optional — 없어도 통과
});

// Controller
async function createOrder(req: Request, res: Response) {
  const parsed = CreateOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: '입력값이 올바르지 않습니다',
        details: parsed.error.flatten().fieldErrors,
        requestId: req.id,
      },
    });
  }
  // ...
}
```

### 2.2 에러 모델

```typescript
// 도메인 에러 클래스
class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super('RESOURCE_NOT_FOUND', 404, `${resource} not found: ${id}`);
  }
}

// 글로벌 에러 핸들러
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  const statusCode = err instanceof AppError ? err.statusCode : 500;
  logger.error({ err, requestId: req.id }, 'Request error');
  res.status(statusCode).json({
    error: {
      code: err instanceof AppError ? err.code : 'INTERNAL_ERROR',
      message: statusCode < 500 ? err.message : '서버 오류가 발생했습니다',
      requestId: req.id,
    },
  });
});
```

### 2.3 DB + 트랜잭션

```typescript
// Prisma 예시
async function createOrderWithStock(input: CreateOrderInput) {
  return await prisma.$transaction(async (tx) => {
    // TX: order 생성 + stock 차감 원자적 처리
    const order = await tx.order.create({ data: { userId: input.userId } });
    for (const item of input.items) {
      await tx.stock.update({
        where: { productId: item.productId },
        data: { quantity: { decrement: item.quantity } },
      });
    }
    return order;
  });
}
```

### 2.4 관찰가능성

```typescript
import { trace, SpanStatusCode } from '@opentelemetry/api';
import pino from 'pino';

const logger = pino({ level: 'info', redact: ['*.password', 'req.headers.authorization'] });
const tracer = trace.getTracer('order-service');

async function createOrder(input: CreateOrderInput) {
  const span = tracer.startSpan('OrderService.createOrder');
  try {
    span.setAttributes({ 'order.userId': input.userId, 'order.itemCount': input.items.length });
    const result = await orderRepo.create(input);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}
```

## 3. 출력 형식

작업 완료 시:

```
## 완료 보고
- 체크리스트: N/N ✅
- 매핑표: 모든 행 테스트 green
- 변경 파일: <목록>
- 셀프 체크: 6/6 통과
- API contract: <파일 경로>
- 의사결정: <레이어 분리 기준 1-2줄>
```

## 4. 관련 문서

- 원칙: [`principles/common.md`](../../../principles/common.md), [`principles/node.md`](../../../principles/node.md)
- 리뷰: [`skills/node/be-review/SKILL.md`](../be-review/SKILL.md)
- 성능: [`skills/node/be-perf/SKILL.md`](../be-perf/SKILL.md)
- 보안: [`skills/node/be-security/SKILL.md`](../be-security/SKILL.md)
