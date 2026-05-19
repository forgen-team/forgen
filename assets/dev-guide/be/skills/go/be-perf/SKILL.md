---
name: be-perf-go
description: Go 서비스의 p95/p99 성능 문제를 진단하고 수정. DB N+1, GC pause, goroutine leak, lock contention, allocation 최적화, network roundtrip 카테고리별 절차로 접근한다.
---

# be-perf (Go)

> **호출 시점**: "p99가 800ms야 잡아줘", "GC pause가 심해", "goroutine 수가 계속 올라가", "메모리 사용량이 이상해".
> **선행 로딩**: `principles/common.md` + `principles/go.md` 필수.

## 0. 절대 금지

1. 측정 없이 최적화 추측 금지 — pprof 데이터 없이 "아마 GC겠지"는 근거 없음.
2. p50만 보고 OK 선언 금지 — p95/p99 반드시 확인.
3. unsafe 패키지 성능 최적화 목적 사용 금지 — 이득이 미미하고 버그 위험 높음.

## 1. 진단 절차

### Step 1 — 현재 지표 수집

```bash
# pprof 활성화 (프로덕션에서는 조건부로만)
import _ "net/http/pprof"
go func() { http.ListenAndServe(":6060", nil) }()

# 30초 CPU 프로파일 수집
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# 메모리 프로파일
go tool pprof http://localhost:6060/debug/pprof/heap

# goroutine 덤프
curl http://localhost:6060/debug/pprof/goroutine?debug=2

# 벤치마크 기준선
go test -bench=. -benchmem -count=5 ./...
```

### Step 2 — 병목 카테고리 분류

| 증상 | 카테고리 |
|------|----------|
| pprof CPU에서 GC 관련 함수 상위 | GC pause / allocation 과다 |
| goroutine 수 지속 증가 | goroutine leak |
| 특정 goroutine이 mutex 대기 | lock contention |
| DB slow query | N+1 / 인덱스 누락 |
| 외부 API 대기 | network roundtrip |

## 2. 카테고리별 진단 및 픽스

### 2.1 DB N+1

```go
// WRONG: N+1
orders, _ := repo.FindOrders(ctx)
for _, o := range orders {
    o.User, _ = repo.FindUser(ctx, o.UserID)  // N번 쿼리
}

// RIGHT: JOIN 또는 IN 쿼리
orders, _ := repo.FindOrdersWithUsers(ctx)
// SELECT o.*, u.name FROM orders o JOIN users u ON o.user_id = u.id

// 또는 IN 쿼리
userIDs := make([]string, len(orders))
for i, o := range orders { userIDs[i] = o.UserID }
users, _ := repo.FindUsersByIDs(ctx, userIDs)
// SELECT * FROM users WHERE id = ANY($1)
userMap := make(map[string]*User, len(users))
for _, u := range users { userMap[u.ID] = u }
```

### 2.2 GC Pause / 과도한 Allocation

**탐지**: pprof heap 에서 alloc_objects 상위 함수 확인.

```bash
go tool pprof -alloc_objects http://localhost:6060/debug/pprof/heap
# top 10 으로 allocation 많은 함수 확인
```

**픽스**:
```go
// sync.Pool로 자주 할당하는 버퍼 재사용
var bufPool = sync.Pool{New: func() interface{} { return new(bytes.Buffer) }}

func encodeJSON(v interface{}) ([]byte, error) {
    buf := bufPool.Get().(*bytes.Buffer)
    defer func() { buf.Reset(); bufPool.Put(buf) }()
    if err := json.NewEncoder(buf).Encode(v); err != nil {
        return nil, err
    }
    return append([]byte(nil), buf.Bytes()...), nil
}

// 슬라이스 용량 사전 할당
func buildResult(items []Item) []Result {
    results := make([]Result, 0, len(items))  // capacity 미리 지정
    for _, item := range items {
        results = append(results, transform(item))
    }
    return results
}

// 문자열 빌더 (+ concat 대신)
var sb strings.Builder
sb.Grow(len(parts) * 20)  // 예상 크기 미리 할당
for _, p := range parts {
    sb.WriteString(p)
}
result := sb.String()
```

### 2.3 Goroutine Leak

**탐지**:
```bash
# goroutine 덤프 - 비정상적으로 많으면 leak
curl -s http://localhost:6060/debug/pprof/goroutine?debug=2 | head -50
# 또는 goleak 라이브러리 (테스트에서)
```

```go
// 테스트에서 leak 탐지
import "go.uber.org/goleak"

func TestCreateOrder(t *testing.T) {
    defer goleak.VerifyNone(t)
    // ...
}
```

**픽스**:
```go
// WRONG: 종료 조건 없는 goroutine
func startWorker() {
    go func() {
        for {
            processJob()  // context 없음 — 영원히 실행
        }
    }()
}

// RIGHT: context 기반 종료
func startWorker(ctx context.Context) {
    go func() {
        for {
            select {
            case <-ctx.Done():
                return
            default:
                processJob(ctx)
            }
        }
    }()
}

// 고정 크기 worker pool
func NewWorkerPool(ctx context.Context, n int, jobs <-chan Job) {
    var wg sync.WaitGroup
    for i := 0; i < n; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for {
                select {
                case job, ok := <-jobs:
                    if !ok { return }
                    job.Execute(ctx)
                case <-ctx.Done():
                    return
                }
            }
        }()
    }
    wg.Wait()
}
```

### 2.4 Lock Contention

**탐지**: pprof mutex 프로파일.
```bash
go tool pprof http://localhost:6060/debug/pprof/mutex
```

**픽스**:
```go
// sync.RWMutex: 읽기 많고 쓰기 적을 때
type Cache struct {
    mu    sync.RWMutex
    items map[string]Item
}

func (c *Cache) Get(key string) (Item, bool) {
    c.mu.RLock()           // 읽기 lock (다중 동시 읽기 허용)
    defer c.mu.RUnlock()
    item, ok := c.items[key]
    return item, ok
}

func (c *Cache) Set(key string, item Item) {
    c.mu.Lock()            // 쓰기 lock (단독)
    defer c.mu.Unlock()
    c.items[key] = item
}

// atomic 연산 (카운터)
import "sync/atomic"
var requestCount int64
atomic.AddInt64(&requestCount, 1)  // mutex 불필요
```

### 2.5 Network Roundtrip

```go
// HTTP 클라이언트 연결 풀 설정
transport := &http.Transport{
    MaxIdleConns:        100,
    MaxIdleConnsPerHost: 10,
    IdleConnTimeout:     90 * time.Second,
    // Keep-Alive 기본 활성화
}
client := &http.Client{
    Transport: transport,
    Timeout:   5 * time.Second,
}

// 독립적인 외부 호출 병렬화
g, ctx := errgroup.WithContext(ctx)
var user *User
var inventory *Inventory

g.Go(func() error {
    var err error
    user, err = userClient.GetUser(ctx, userID)
    return err
})
g.Go(func() error {
    var err error
    inventory, err = inventoryClient.GetStock(ctx, productID)
    return err
})
if err := g.Wait(); err != nil { ... }

// gRPC: 스트리밍 활용 (대용량 응답)
// 단건 요청 반복 → 배치 RPC
```

### 2.6 DB 연결 풀 / 쿼리 최적화

```go
db.SetMaxOpenConns(25)
db.SetMaxIdleConns(10)
db.SetConnMaxLifetime(5 * time.Minute)
db.SetConnMaxIdleTime(5 * time.Minute)

// 슬로우 쿼리 로깅
// PostgreSQL: log_min_duration_statement = 100
// 또는 ORM 레벨 후킹
```

## 3. 벤치마크 패턴

```go
func BenchmarkCreateOrder(b *testing.B) {
    svc := setupService(b)
    req := validRequest()

    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            _, err := svc.CreateOrder(context.Background(), req)
            if err != nil {
                b.Fatal(err)
            }
        }
    })
    // 메모리 할당도 확인: go test -bench=. -benchmem
}
```

## 4. 출력 형식

```
## 성능 진단 결과

### 측정 기준선
- p50: Xms / p95: Xms / p99: Xms
- goroutine 수: N
- heap: XMB

### 발견된 병목
1. [DB N+1] internal/service/order.go:55 — 주문 목록 조회 시 N번 user 쿼리
2. [GC] internal/handler/serialize.go:30 — 요청마다 bytes.Buffer 새로 할당

### 적용한 픽스
- 변경 파일: <목록>
- 재측정: p95 Xms → Xms, heap XMB → XMB

### 추가 권고
- ...
```

## 5. 관련 문서

- 원칙: [`principles/common.md`](../../../principles/common.md) F섹션, [`principles/go.md`](../../../principles/go.md) G6
- 코퍼스: `sources/go-runtime/`, `sources/postgres/`
