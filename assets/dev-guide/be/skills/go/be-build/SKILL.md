---
name: be-build-go
description: Go 요구사항을 받아 합의된 사내 원칙대로 구현. 명세→API contract→구현→테스트 매핑을 강제하고, error-as-value·context 전파·goroutine 안전성을 적용한다.
---

# be-build (Go)

> **호출 시점**: "이 API 명세대로 Go로 구현해줘", "이 서비스 Go로 만들어줘".
> **선행 로딩**: `principles/common.md` + `principles/go.md` 필수.

## 0. 절대 금지

1. 명세 읽기 전에 코드 쓰지 마라.
2. `panic` 을 일반 에러 처리에 사용 금지.
3. `context.Context` 없는 DB/HTTP 호출 금지.
4. goroutine 종료 조건 없이 시작 금지.
5. 에러 무시 (`_ = err`) 금지 — 이유가 있으면 주석 필수.
6. 인터페이스를 구현 패키지에서 정의 금지 (consumer 측 정의).

## 1. 워크플로우

### Step 1 — 요구사항 → 체크리스트 변환

명세 받자마자, 다른 어떤 작업도 하기 전에:

```markdown
## 요구사항 체크리스트
- [ ] R-01: <명세 원문 직접 인용>
- [ ] R-02: ...
```

optional/required 구분 명시. optional은 "없어도 통과" 케이스 매핑.

### Step 2 — API Contract 정의

```go
// types/order.go — 계약 먼저
type CreateOrderRequest struct {
    UserID    string      `json:"userId" validate:"required,uuid"`
    Items     []OrderItem `json:"items"  validate:"required,min=1,dive"`
    CouponCode *string    `json:"couponCode,omitempty"`  // optional — pointer로 absent 구분
}

type CreateOrderResponse struct {
    OrderID   string    `json:"orderId"`
    Status    string    `json:"status"`
    CreatedAt time.Time `json:"createdAt"`
}

type OrderItem struct {
    ProductID string `json:"productId" validate:"required,uuid"`
    Quantity  int    `json:"quantity"  validate:"required,min=1"`
}
```

### Step 3 — 체크리스트 → 테스트 매핑표

```markdown
## 매핑표
| 요구사항 | 함수 | 테스트 파일:케이스 |
|----------|------|---------------------|
| R-01 | OrderHandler.Create | order_test.go:TestCreate_Success |
| R-02 | OrderService.Validate | order_test.go:TestCreate_NoCoupon |
```

### Step 4 — 패키지 구조 결정

```
internal/
├─ handler/    HTTP 핸들러 (입력 검증, 라우팅)
├─ service/    비즈니스 로직 (인터페이스 정의)
├─ repository/ DB 접근 (구현)
└─ domain/     엔티티, 도메인 에러
```

결정 기록: "service 레이어가 트랜잭션 경계. repository는 순수 쿼리."

### Step 5 — TDD (Red → Green → Refactor)

```bash
go test ./... -run TestCreate_Success  # 실패 확인
# 구현
go test ./... -run TestCreate_Success  # 통과 확인
go test -race ./...                    # 레이스 컨디션 확인
```

### Step 6 — 셀프 체크리스트

```markdown
- [ ] 모든 함수 첫 인자가 context.Context (I/O 함수)
- [ ] goroutine 시작 시 종료 조건 존재
- [ ] 에러 래핑 — fmt.Errorf("funcName: %w", err)
- [ ] 에러 무시 없음
- [ ] golangci-lint 통과
- [ ] go test -race 통과
- [ ] optional 필드 pointer 또는 omitempty 처리
```

### Step 7 — 완료 선언

매핑표 모든 행 ✅ + 테스트 green + race 없음 + lint 통과.

## 2. 구현 디폴트

### 2.1 HTTP 핸들러 (net/http + chi)

```go
// handler/order.go
func (h *OrderHandler) Create(w http.ResponseWriter, r *http.Request) {
    var req CreateOrderRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        respondError(w, http.StatusBadRequest, "INVALID_JSON", err.Error(), r)
        return
    }
    if err := h.validate.Struct(req); err != nil {
        respondError(w, http.StatusBadRequest, "VALIDATION_ERROR", err.Error(), r)
        return
    }

    order, err := h.svc.CreateOrder(r.Context(), req)
    if err != nil {
        switch {
        case errors.Is(err, domain.ErrUserNotFound):
            respondError(w, http.StatusNotFound, "USER_NOT_FOUND", err.Error(), r)
        case errors.Is(err, domain.ErrInsufficientStock):
            respondError(w, http.StatusUnprocessableEntity, "INSUFFICIENT_STOCK", err.Error(), r)
        default:
            slog.ErrorContext(r.Context(), "create order failed", "err", err, "requestId", requestID(r))
            respondError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "서버 오류가 발생했습니다", r)
        }
        return
    }
    respondJSON(w, http.StatusCreated, order)
}

func respondError(w http.ResponseWriter, status int, code, message string, r *http.Request) {
    respondJSON(w, status, map[string]interface{}{
        "error": map[string]interface{}{
            "code":      code,
            "message":   message,
            "requestId": requestID(r),
        },
    })
}
```

### 2.2 서비스 레이어 (인터페이스 + 트랜잭션)

```go
// service/order.go

// consumer 측 인터페이스 정의
type orderRepository interface {
    Create(ctx context.Context, order *domain.Order) error
    DecrementStock(ctx context.Context, productID string, qty int) error
}

type OrderService struct {
    repo orderRepository
    db   *sql.DB  // 트랜잭션용
}

func (s *OrderService) CreateOrder(ctx context.Context, req CreateOrderRequest) (*domain.Order, error) {
    // TX: order 생성 + stock 차감 원자적 처리
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return nil, fmt.Errorf("CreateOrder begin tx: %w", err)
    }
    defer tx.Rollback()  // 성공 시 Commit 후 Rollback은 no-op

    order := &domain.Order{
        ID:     uuid.New().String(),
        UserID: req.UserID,
        Status: "pending",
    }
    if err := s.repo.Create(ctx, order); err != nil {
        return nil, fmt.Errorf("CreateOrder create: %w", err)
    }
    for _, item := range req.Items {
        if err := s.repo.DecrementStock(ctx, item.ProductID, item.Quantity); err != nil {
            return nil, fmt.Errorf("CreateOrder decrement stock %s: %w", item.ProductID, err)
        }
    }

    if err := tx.Commit(); err != nil {
        return nil, fmt.Errorf("CreateOrder commit: %w", err)
    }
    return order, nil
}
```

### 2.3 에러 모델

```go
// domain/errors.go
var (
    ErrUserNotFound      = errors.New("user not found")
    ErrInsufficientStock = errors.New("insufficient stock")
    ErrOrderNotFound     = errors.New("order not found")
)

// 상세 정보가 필요한 구조체 에러
type ValidationError struct {
    Fields map[string]string
}
func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation failed: %v", e.Fields)
}
```

### 2.4 관찰가능성

```go
import (
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "log/slog"
)

var tracer = otel.Tracer("order-service")

func (s *OrderService) CreateOrder(ctx context.Context, req CreateOrderRequest) (*domain.Order, error) {
    ctx, span := tracer.Start(ctx, "OrderService.CreateOrder")
    defer span.End()

    span.SetAttributes(
        attribute.String("order.userId", req.UserID),
        attribute.Int("order.itemCount", len(req.Items)),
    )

    order, err := s.createInternal(ctx, req)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }
    slog.InfoContext(ctx, "order created",
        slog.String("orderId", order.ID),
        slog.String("userId", order.UserID),
    )
    return order, nil
}
```

## 3. 출력 형식

```
## 완료 보고
- 체크리스트: N/N ✅
- 매핑표: 모든 행 테스트 green
- go test -race: PASS
- golangci-lint: 0 issues
- 변경 파일: <목록>
- 의사결정: <패키지 구조 1-2줄>
```

## 4. 관련 문서

- 원칙: [`principles/common.md`](../../../principles/common.md), [`principles/go.md`](../../../principles/go.md)
- 리뷰: [`skills/go/be-review/SKILL.md`](../be-review/SKILL.md)
- 성능: [`skills/go/be-perf/SKILL.md`](../be-perf/SKILL.md)
