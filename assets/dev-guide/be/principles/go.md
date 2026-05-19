---
title: Go 원칙
version: 2026-05-18
sources:
  - sources/go-runtime/
---

# Go 원칙

> [공통 원칙](./common.md)을 먼저 따르고, 아래는 Go 특화.

## G0. 의사결정 우선순위

1. **에러는 값** — panic은 진짜 예외(복구 불가)에만
2. **context.Context 전파** — cancellation/deadline은 모든 I/O에 전달
3. **goroutine 생명주기 명확화** — 시작한 곳이 종료 책임 보유
4. **interface는 작게** — consumer 측 정의, 1~3 메서드
5. **lint 자동화** — golangci-lint + go vet + staticcheck CI 필수

---

## G1. 에러는 값으로 반환

근거: `sources/go-runtime/` (Effective Go, Rob Pike "Errors are values")

**panic은 "진짜 프로그래밍 오류" 또는 "복구 불가 상황"에만. 일반 에러는 반환값.**

### G1.1 에러 반환 패턴

```go
// 에러를 항상 마지막 반환값으로
func fetchUser(ctx context.Context, id string) (*User, error) {
    row := db.QueryRowContext(ctx, "SELECT * FROM users WHERE id = $1", id)
    var user User
    if err := row.Scan(&user.ID, &user.Name, &user.Email); err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, ErrUserNotFound  // sentinel error
        }
        return nil, fmt.Errorf("fetchUser %s: %w", id, err)  // 래핑
    }
    return &user, nil
}
```

### G1.2 에러 래핑과 검사

```go
// 에러 래핑: %w 사용 (Go 1.13+)
return fmt.Errorf("processPayment: %w", ErrInsufficientFunds)

// 에러 검사: errors.Is (sentinel), errors.As (타입)
if errors.Is(err, ErrUserNotFound) {
    return http.StatusNotFound, nil
}
var validationErr *ValidationError
if errors.As(err, &validationErr) {
    return http.StatusBadRequest, validationErr.Fields
}
```

### G1.3 Sentinel Error 정의

```go
// 패키지 레벨 sentinel errors
var (
    ErrUserNotFound      = errors.New("user not found")
    ErrInsufficientFunds = errors.New("insufficient funds")
    ErrDuplicateEmail    = errors.New("duplicate email")
)

// 필드 정보가 필요한 구조체 에러
type ValidationError struct {
    Fields map[string]string
}
func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation failed: %v", e.Fields)
}
```

### G1.4 panic 허용 기준

```go
// OK: 프로그래밍 오류 — nil 포인터, 인덱스 초과 등 (런타임 패닉)
// OK: 초기화 실패 — 앱이 시작될 수 없는 상태
func mustParseTemplate(s string) *template.Template {
    t, err := template.New("").Parse(s)
    if err != nil {
        panic(fmt.Sprintf("failed to parse template: %v", err))  // 컴파일 타임 알아야 할 오류
    }
    return t
}

// NOT OK: 일반 런타임 에러 (DB 오류, 네트워크 오류, 검증 실패)
```

---

## G2. context.Context 전파

**모든 I/O 함수의 첫 번째 인자는 context.Context. cancellation/deadline이 반드시 전파되어야 한다.**

### G2.1 함수 시그니처 규칙

```go
// WRONG: context 없는 DB 호출
func (r *UserRepo) FindByID(id string) (*User, error) {
    return r.db.QueryRow("SELECT ...", id).Scan(...)
}

// RIGHT: context 전파
func (r *UserRepo) FindByID(ctx context.Context, id string) (*User, error) {
    return r.db.QueryRowContext(ctx, "SELECT ...", id).Scan(...)
}
```

### G2.2 context 값 사용 기준

```go
// context.Value: 요청 범위 메타데이터만 (request ID, auth user, traceID)
// 비즈니스 로직 파라미터를 context에 넣지 마라

// WRONG
ctx = context.WithValue(ctx, "userID", userID)

// RIGHT: 명시적 파라미터
func processOrder(ctx context.Context, userID string, items []Item) error
```

### G2.3 context 취소 처리

```go
func longOperation(ctx context.Context) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()  // context.Canceled 또는 context.DeadlineExceeded
        default:
            // 작업 계속
        }
        // 또는 I/O 함수에 ctx 전달 시 자동 처리
    }
}
```

### G2.4 Timeout 설정

```go
// HTTP 핸들러: 요청 timeout
ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
defer cancel()  // 반드시 defer cancel() — goroutine/timer 누수 방지

result, err := svc.Process(ctx, input)
```

---

## G3. Goroutine 생명주기

**goroutine을 시작한 쪽이 종료 책임을 진다. goroutine leak은 메모리 누수와 동일하다.**

### G3.1 goroutine leak 패턴과 픽스

```go
// WRONG: 종료 조건 없는 goroutine
func start() {
    go func() {
        for {
            processMessage()  // 영원히 실행
        }
    }()
}

// RIGHT: context 기반 종료
func start(ctx context.Context) {
    go func() {
        for {
            select {
            case <-ctx.Done():
                return
            default:
                processMessage(ctx)
            }
        }
    }()
}
```

### G3.2 WaitGroup으로 완료 대기

```go
func processAll(ctx context.Context, items []Item) error {
    var wg sync.WaitGroup
    errCh := make(chan error, len(items))  // 버퍼드 채널 (모든 에러 수집)

    for _, item := range items {
        wg.Add(1)
        go func(item Item) {
            defer wg.Done()
            if err := process(ctx, item); err != nil {
                errCh <- err
            }
        }(item)  // 루프 변수 캡처 — Go 1.22부터 자동이지만 명시적 인자가 명확
    }

    wg.Wait()
    close(errCh)

    for err := range errCh {
        return err  // 첫 번째 에러 반환 (또는 multierr.Combine)
    }
    return nil
}
```

### G3.3 errgroup 패턴

```go
import "golang.org/x/sync/errgroup"

func fanOut(ctx context.Context) error {
    g, ctx := errgroup.WithContext(ctx)  // 한 goroutine 실패 시 나머지 ctx 취소

    g.Go(func() error { return fetchUsers(ctx) })
    g.Go(func() error { return fetchOrders(ctx) })
    g.Go(func() error { return fetchInventory(ctx) })

    return g.Wait()  // 모든 goroutine 완료 대기, 첫 번째 non-nil 에러 반환
}
```

---

## G4. Channel 단일 책임

**channel은 한 가지 목적으로만. close는 항상 sender가.**

### G4.1 channel 패턴

```go
// 생산자-소비자: sender가 close
func producer(ctx context.Context) <-chan Item {
    ch := make(chan Item)
    go func() {
        defer close(ch)  // sender가 close
        for _, item := range items {
            select {
            case ch <- item:
            case <-ctx.Done():
                return
            }
        }
    }()
    return ch
}

func consumer(ctx context.Context, ch <-chan Item) {
    for item := range ch {  // close 시 자동 종료
        process(ctx, item)
    }
}
```

### G4.2 channel vs sync.Mutex 선택 기준

```
goroutine 간 데이터 전달 → channel
공유 상태 보호 (캐시, 카운터) → sync.Mutex / sync.RWMutex
단발성 신호 (완료 알림) → chan struct{} (또는 context)
```

---

## G5. Interface는 작게

**interface는 큰 것을 정의하지 마라. consumer 측에서, 1~3 메서드로.**

### G5.1 인터페이스 크기 원칙

```go
// WRONG: 모든 것을 포함한 큰 인터페이스
type UserRepository interface {
    Create(ctx context.Context, user *User) error
    Update(ctx context.Context, user *User) error
    Delete(ctx context.Context, id string) error
    FindByID(ctx context.Context, id string) (*User, error)
    FindByEmail(ctx context.Context, email string) (*User, error)
    List(ctx context.Context, filter UserFilter) ([]*User, error)
    Count(ctx context.Context, filter UserFilter) (int, error)
}

// RIGHT: 사용 측이 필요한 것만
type UserFinder interface {
    FindByID(ctx context.Context, id string) (*User, error)
}

type UserCreator interface {
    Create(ctx context.Context, user *User) error
}

// UserService는 필요한 인터페이스만 조합
type UserService struct {
    finder  UserFinder
    creator UserCreator
}
```

### G5.2 Consumer 측 정의

```go
// WRONG: 구현 패키지에서 인터페이스 정의 (Go 안티패턴)
// user/repository.go
type Repository interface { ... }  // 구현 패키지가 자기 인터페이스를 선언

// RIGHT: consumer 패키지에서 필요한 것만 정의
// order/service.go — order 서비스가 필요한 user 기능만 정의
type userProvider interface {
    FindByID(ctx context.Context, id string) (*User, error)
}
```

### G5.3 표준 라이브러리 인터페이스 우선 활용

```go
io.Reader, io.Writer, io.Closer — 스트림
fmt.Stringer — 문자열 표현
error — 에러
http.Handler — HTTP 처리
```

---

## G6. 메모리 재사용 — sync.Pool

**sync.Pool은 신중하게. 올바르게 쓰지 않으면 미묘한 버그 원인.**

### G6.1 sync.Pool 적절한 사용

```go
// 적합: 버퍼, bytes.Buffer, 인코더 같은 임시 객체
var bufPool = sync.Pool{
    New: func() interface{} {
        return new(bytes.Buffer)
    },
}

func encode(v interface{}) ([]byte, error) {
    buf := bufPool.Get().(*bytes.Buffer)
    defer func() {
        buf.Reset()        // 상태 초기화 필수
        bufPool.Put(buf)   // 반환
    }()
    if err := json.NewEncoder(buf).Encode(v); err != nil {
        return nil, err
    }
    return append([]byte{}, buf.Bytes()...), nil  // copy — buf는 pool에 반환되므로
}
```

### G6.2 sync.Pool 주의사항

- Pool에서 꺼낸 객체의 **이전 상태가 남아있을 수 있다** → `Reset()` / `Zero` 필수.
- GC가 Pool을 비울 수 있다 — 영구 캐시 용도로 사용 금지.
- escape analysis 확인: `go build -gcflags='-m'` 으로 heap 할당 여부 확인.

---

## G7. 정적 분석 필수

**린터 없이 코드 리뷰는 없다. CI에서 통과 못하면 merge 불가.**

### G7.1 golangci-lint 설정

```yaml
# .golangci.yml
linters:
  enable:
    - govet          # go vet (공식)
    - staticcheck    # SA/S 룰 (버그 탐지)
    - errcheck       # 에러 무시 탐지
    - gosimple       # 코드 단순화
    - ineffassign    # 불필요한 할당
    - unused         # 미사용 코드
    - gosec          # 보안 룰 (G-시리즈)
    - noctx          # context 없는 HTTP 요청 탐지
    - bodyclose      # http.Response.Body.Close() 확인
    - nilerr         # nil 에러 반환 패턴 탐지
    - wrapcheck      # 외부 패키지 에러 wrap 강제
    - cyclop         # 순환 복잡도 제한

linters-settings:
  cyclop:
    max-complexity: 10
  gosec:
    excludes: ["G304"]  # 파일 경로는 의도적으로 제외 가능

issues:
  exclude-rules:
    - path: "_test.go"
      linters: [wrapcheck, gosec]
```

### G7.2 CI 파이프라인

```yaml
# .github/workflows/go.yml
- name: golangci-lint
  uses: golangci/golangci-lint-action@v4
  with:
    version: latest

- name: go test
  run: go test -race -coverprofile=coverage.out ./...

- name: go vet
  run: go vet ./...
```

- `-race` 플래그 필수 (data race 탐지).
- 커버리지: `go tool cover -func=coverage.out` 으로 함수별 커버리지.

---

## G8. 구조화 로그 (slog)

```go
import "log/slog"  // Go 1.21+

// 기본 설정
logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
    Level: slog.LevelInfo,
    ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
        // 민감 정보 리댁션
        if a.Key == "password" || a.Key == "token" {
            return slog.String(a.Key, "[REDACTED]")
        }
        return a
    },
}))
slog.SetDefault(logger)

// 사용
slog.InfoContext(ctx, "order created",
    slog.String("orderId", order.ID),
    slog.String("userId", order.UserID),
    slog.Float64("amount", order.Amount),
    slog.Duration("duration", time.Since(start)),
)
```

---

## G9. Go 안티패턴 카탈로그

| 안티패턴 | 픽스 |
|----------|------|
| 에러 무시 (`_ = err`) | 에러 처리 또는 이유 주석 |
| `panic` in 일반 에러 경로 | `error` 반환값 사용 |
| context 없는 DB/HTTP 호출 | `xxxContext(ctx, ...)` 버전 사용 |
| goroutine 종료 조건 없음 | context 취소 또는 done 채널 |
| `defer cancel()` 누락 | `ctx, cancel := context.WithTimeout(...)` → `defer cancel()` |
| receiver에서 직접 인터페이스 정의 | consumer 측에서 필요한 것만 |
| 큰 인터페이스 (5+ 메서드) | 목적별 소형 인터페이스 분리 |
| `sync.Mutex` Lock 후 defer Unlock 누락 | `defer mu.Unlock()` 패턴 |
| goroutine 내 루프 변수 캡처 (Go 1.22 미만) | `item := item` 또는 인자로 전달 |
| `http.Get` (context 없음) | `http.NewRequestWithContext(ctx, ...)` |
| `json.Unmarshal` 에러 무시 | 에러 처리 |
| 채널 receiver가 close | sender가 close |
| `fmt.Println` in 프로덕션 코드 | `slog` 구조화 로그 |
| `golangci-lint` CI 미설정 | `.golangci.yml` + CI 단계 추가 |
