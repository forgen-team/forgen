---
name: be-security-go
description: Go 서비스를 OWASP API Security Top 10 기준으로 진단. 카테고리별 체크리스트와 Go 특화 픽스 패턴을 제공한다.
---

# be-security (Go)

> **호출 시점**: "이 핸들러 보안 검토해줘", "OWASP 관점에서 체크해줘", "Go 서비스 보안 감사".
> **선행 로딩**: `principles/common.md` (E섹션) + `principles/go.md` 필수.

## 0. 절대 금지

1. gosec 린터가 잡는 이슈를 무시 (`//nolint:gosec`) 하려면 이유 주석 필수.
2. 보안 이슈를 [LOW]로 다운그레이드 금지.
3. `crypto/md5`, `crypto/sha1` 비밀번호 해싱 사용 금지 — bcrypt/argon2 사용.

## 1. 워크플로우

### Step 1 — gosec 자동 스캔

```bash
# gosec 설치 및 실행
go install github.com/securego/gosec/v2/cmd/gosec@latest
gosec -fmt sarif -out gosec-report.sarif ./...

# 또는 golangci-lint (gosec 포함)
golangci-lint run --enable gosec ./...
```

자동 스캔 후 수동 체크리스트 실행.

### Step 2 — OWASP Top 10 체크리스트

### Step 3 — 취약점 보고 및 픽스

## 2. OWASP API Top 10 체크리스트 (Go 특화)

### API1 — Broken Object Level Authorization

```go
// WRONG: URL params 신뢰
func (h *OrderHandler) Get(w http.ResponseWriter, r *http.Request) {
    orderID := chi.URLParam(r, "orderID")
    order, _ := h.repo.FindByID(r.Context(), orderID)
    json.NewEncoder(w).Encode(order)  // 다른 유저 주문 접근 가능
}

// RIGHT: 소유권 검증
func (h *OrderHandler) Get(w http.ResponseWriter, r *http.Request) {
    orderID := chi.URLParam(r, "orderID")
    userID := userIDFromCtx(r.Context())  // JWT에서 추출

    order, err := h.repo.FindByID(r.Context(), orderID)
    if err != nil {
        if errors.Is(err, domain.ErrNotFound) {
            respondError(w, http.StatusNotFound, "NOT_FOUND", "Order not found", r)
            return
        }
        respondError(w, http.StatusInternalServerError, "INTERNAL", "서버 오류", r)
        return
    }
    if order.UserID != userID {  // 소유권 검증
        respondError(w, http.StatusForbidden, "FORBIDDEN", "접근 권한 없음", r)
        return
    }
    json.NewEncoder(w).Encode(order)
}
```

```
[ ] 모든 리소스 핸들러에 소유권 검증
[ ] JWT claims에서 userID 추출 (URL params 신뢰 금지)
[ ] 관리자 핸들러에도 역할 검증 (미들웨어 단독 의존 금지)
```

### API2 — Broken Authentication

```go
import "github.com/golang-jwt/jwt/v5"

// WRONG: 알고리즘 검증 없음
token, _ := jwt.Parse(tokenString, func(t *jwt.Token) (interface{}, error) {
    return secret, nil  // 알고리즘 검증 안 함 → none 공격 가능
})

// RIGHT: 알고리즘 명시
token, err := jwt.Parse(tokenString, func(t *jwt.Token) (interface{}, error) {
    if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
        return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
    }
    return publicKey, nil
}, jwt.WithExpirationRequired())  // 만료 검증 강제
```

```
[ ] JWT 서명 알고리즘 명시 (RS256 권장)
[ ] 만료 검증 (exp claim)
[ ] 비밀키 환경변수에서 로드
[ ] API Key 해시 저장 (평문 DB 저장 금지)
```

### API3 — Broken Object Property Level Authorization

```go
// WRONG: 전체 모델 반환
type User struct {
    ID           string `json:"id"`
    Email        string `json:"email"`
    PasswordHash string `json:"passwordHash"`  // 노출!
    InternalFlag bool   `json:"internalFlag"`   // 노출!
}

// RIGHT: 응답 전용 구조체
type UserResponse struct {
    ID    string `json:"id"`
    Email string `json:"email"`
    Name  string `json:"name"`
}

func toUserResponse(u *User) UserResponse {
    return UserResponse{ID: u.ID, Email: u.Email, Name: u.Name}
}
```

```
[ ] 응답 전용 DTO/구조체 정의 (DB 모델 직접 직렬화 금지)
[ ] password, hash, secret, internal 태그 필드 응답 제외
[ ] json:"-" 태그로 민감 필드 직렬화 차단
```

### API4 — Unrestricted Resource Consumption

```go
import "golang.org/x/time/rate"

// Rate limiter (토큰 버킷)
type RateLimitMiddleware struct {
    limiter *rate.Limiter
}

func NewRateLimitMiddleware(rps float64, burst int) *RateLimitMiddleware {
    return &RateLimitMiddleware{limiter: rate.NewLimiter(rate.Limit(rps), burst)}
}

func (m *RateLimitMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if !m.limiter.Allow() {
            w.Header().Set("Retry-After", "60")
            respondError(w, http.StatusTooManyRequests, "TOO_MANY_REQUESTS", "요청 한도 초과", r)
            return
        }
        next.ServeHTTP(w, r)
    })
}

// 요청 바디 크기 제한
r.Body = http.MaxBytesReader(w, r.Body, 1<<20)  // 1MB
```

```
[ ] Rate limiting 미들웨어 (전역 + 민감 엔드포인트)
[ ] http.MaxBytesReader 으로 바디 크기 제한
[ ] 페이지네이션 limit 상한 (예: min(limit, 100))
[ ] 429 응답에 Retry-After 헤더
```

### API5 — Broken Function Level Authorization

```go
// 역할 미들웨어
func RequireRole(roles ...string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            userRole := roleFromCtx(r.Context())
            for _, role := range roles {
                if userRole == role {
                    next.ServeHTTP(w, r)
                    return
                }
            }
            respondError(w, http.StatusForbidden, "FORBIDDEN", "권한 없음", r)
        })
    }
}

// 라우터 설정
r.With(RequireRole("admin")).Delete("/api/admin/users/{id}", deleteUser)
```

```
[ ] 관리자 경로에 역할 미들웨어
[ ] /debug, /internal, /admin 경로 외부 노출 여부
[ ] HTTP 메서드별 권한 (DELETE가 GET보다 강한 권한 필요)
```

### API6 — Unrestricted Access to Sensitive Flows

```go
// IP + 이메일 기반 rate limit
type AuthRateLimiter struct {
    mu      sync.Mutex
    buckets map[string]*rate.Limiter
}

func (l *AuthRateLimiter) Allow(ip, email string) bool {
    key := ip + ":" + email
    l.mu.Lock()
    limiter, ok := l.buckets[key]
    if !ok {
        limiter = rate.NewLimiter(rate.Every(time.Minute), 5)  // 분당 5회
        l.buckets[key] = limiter
    }
    l.mu.Unlock()
    return limiter.Allow()
}
```

```
[ ] 로그인 IP + 이메일 조합 rate limit
[ ] OTP 코드 rate limit
[ ] 비밀번호 재설정 토큰 단기 만료 (15분)
[ ] 비밀번호 재설정 토큰 1회 사용 후 무효화
[ ] bcrypt/argon2id 비밀번호 해싱 (md5/sha1 금지)
```

### API7 — SSRF

```go
var allowedHosts = map[string]bool{
    "api.trustedpartner.com": true,
}

func isPrivateIP(ip net.IP) bool {
    private := []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8"}
    for _, cidr := range private {
        _, network, _ := net.ParseCIDR(cidr)
        if network.Contains(ip) { return true }
    }
    return false
}

func validateWebhookURL(rawURL string) error {
    u, err := url.Parse(rawURL)
    if err != nil { return fmt.Errorf("invalid URL: %w", err) }
    if u.Scheme != "https" { return errors.New("only https allowed") }
    if !allowedHosts[u.Hostname()] { return errors.New("host not allowed") }

    addrs, err := net.LookupHost(u.Hostname())
    if err != nil { return fmt.Errorf("DNS lookup: %w", err) }
    for _, addr := range addrs {
        if isPrivateIP(net.ParseIP(addr)) {
            return errors.New("private IP not allowed")
        }
    }
    return nil
}
```

```
[ ] 사용자 입력 URL fetch 전 allowlist 검증
[ ] private IP 차단
[ ] https만 허용
[ ] HTTP redirect follow 횟수 제한
```

### API8 — Security Misconfiguration

```go
// 보안 헤더 미들웨어
func SecurityHeaders(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("X-Content-Type-Options", "nosniff")
        w.Header().Set("X-Frame-Options", "DENY")
        w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        w.Header().Set("Content-Security-Policy", "default-src 'self'")
        next.ServeHTTP(w, r)
    })
}

// CORS 설정
corsMiddleware := cors.New(cors.Options{
    AllowedOrigins:   []string{"https://app.example.com"},
    AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE"},
    AllowCredentials: true,
})
```

```
[ ] 보안 헤더 설정 (HSTS, X-Frame-Options 등)
[ ] CORS origin allowlist (* 사용 금지)
[ ] 에러 응답에 스택 트레이스 미포함 (production)
[ ] /debug/pprof 프로덕션 비활성화 또는 인증 보호
[ ] 불필요한 HTTP 메서드 비활성화
```

### API9 — Improper Inventory Management

```
[ ] API 버전 목록 문서화
[ ] 구 버전 폐기 계획 및 Sunset 날짜
[ ] 스테이징 엔드포인트 인터넷 노출 여부
[ ] pprof, expvar 엔드포인트 보호
```

### API10 — Unsafe Consumption of APIs

```go
// 외부 API 응답 검증
type ExternalPaymentResponse struct {
    TransactionID string  `json:"transactionId"`
    Status        string  `json:"status"`
    Amount        float64 `json:"amount"`
}

func parsePaymentResponse(body io.Reader) (*ExternalPaymentResponse, error) {
    var resp ExternalPaymentResponse
    if err := json.NewDecoder(body).Decode(&resp); err != nil {
        return nil, fmt.Errorf("decode payment response: %w", err)
    }
    // 추가 검증
    if resp.TransactionID == "" {
        return nil, errors.New("missing transactionId in response")
    }
    validStatuses := map[string]bool{"success": true, "pending": true, "failed": true}
    if !validStatuses[resp.Status] {
        return nil, fmt.Errorf("unexpected status: %s", resp.Status)
    }
    return &resp, nil
}
```

```
[ ] 외부 API 응답 구조체 검증
[ ] 외부 API 타임아웃 설정
[ ] tls.Config InsecureSkipVerify = false (기본값)
[ ] 외부 오류 응답 내부로 전파 금지 (사용자에게 내부 서비스 정보 노출)
```

## 3. 출력 형식

```
## 보안 감사 결과 (Go)

### gosec 자동 스캔: N issues
[G201] internal/repo/order.go:42 — SQL string formatting (해결 필요)

### OWASP 수동 체크
[HIGH] API1 internal/handler/order.go:55 — 소유권 검증 없음
[HIGH] API6 internal/handler/auth.go:20 — 로그인 rate limit 없음

### 통과
- API2: JWT RS256 + 만료 검증 ✅
- API8: 보안 헤더 미들웨어 ✅

### 권고
- pprof 엔드포인트에 인증 추가 권장
```

## 4. 관련 문서

- 원칙: [`principles/common.md`](../../../principles/common.md) E섹션
- 코퍼스: `sources/owasp-api/`
