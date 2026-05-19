---
name: be-review-go
description: Go PR을 사내 BE 원칙 기준으로 리뷰. [SEVERITY] file:line — 이슈 형식으로 출력하고, 머지 차단/비차단을 명확히 구분한다.
---

# be-review (Go)

> **호출 시점**: "이 PR 리뷰해줘", "이 Go 코드 리뷰해줘", "OWASP 관점에서 검토해줘".
> **선행 로딩**: `principles/common.md` + `principles/go.md` 필수.

## 0. 절대 금지

1. golangci-lint가 잡는 이슈를 수동 리뷰에 중복 포함하지 마라 (자동 도구 역할 존중).
2. 주관적 스타일 의견을 [HIGH]로 분류 금지.
3. Go idiom이 아닌 이유로 [HIGH] 처리 금지 — 보안/안전성 기준으로만.

## 1. 리뷰 출력 형식

```
## 리뷰 요약
- 변경: N files +X -Y
- HIGH N, MED N, LOW N / 머지 [차단|비차단]

[HIGH] internal/handler/order.go:42 — context 없는 DB 쿼리 (N9 antipa.)
[HIGH] internal/handler/order.go:88 — 에러 무시 (_ = err), 결제 실패 묵살
[MED]  internal/service/order.go:120 — goroutine 종료 조건 없음 (leak 위험)
[LOW]  internal/repository/order.go:55 — 인터페이스 구현 패키지에서 정의
```

### SEVERITY 기준

| SEVERITY | 정의 | 머지 |
|----------|------|------|
| **HIGH** | 에러 묵살, goroutine leak, context 미전파, OWASP 취약점, panic 남용, race condition | 차단 |
| **MED** | 큰 인터페이스, goroutine 종료 조건 불명확, 에러 래핑 누락, defer cancel 누락 | 권고 |
| **LOW** | 네이밍, 패키지 구조, 코멘트 스타일 | 비차단 |

## 2. 체크리스트

### 2.1 에러 처리 (HIGH)

```
[ ] 에러 무시 없음 — _ = err 패턴
[ ] 빈 에러 처리 없음 — if err != nil { return } (로그 없는 경우)
[ ] 에러 래핑 — fmt.Errorf("funcName: %w", err)
[ ] panic 사용이 정당한가 — 초기화 실패 / 프로그래밍 오류에만
[ ] sentinel error 정의 — errors.New로 변수화
[ ] errors.Is / errors.As 올바른 사용
```

### 2.2 context 전파 (HIGH/MED)

```
[ ] I/O 함수 첫 인자가 context.Context
[ ] DB 쿼리: QueryContext, ExecContext, QueryRowContext 사용
[ ] HTTP 요청: http.NewRequestWithContext 사용
[ ] context.WithTimeout 후 defer cancel() 존재
[ ] context.Value — 비즈니스 파라미터 전달에 미사용
```

### 2.3 goroutine 안전성 (HIGH/MED)

```
[ ] goroutine 종료 조건 존재 (ctx.Done() 또는 done channel)
[ ] WaitGroup / errgroup으로 완료 대기
[ ] 채널 close — sender가 담당
[ ] 버퍼드 채널 크기 의도적으로 선택
[ ] sync.Mutex Lock 후 defer Unlock
[ ] go test -race 통과 (PR CI에 포함)
```

### 2.4 보안 (HIGH)

```
[ ] SQL 파라미터화 — 문자열 concat 없음
[ ] 소유권 검증 — URL params로 타인 리소스 접근 불가
[ ] 입력 검증 — 외부 데이터 go-validator 또는 수동 검증
[ ] 응답에 내부 필드 노출 없음
[ ] 시크릿 코드 내 하드코딩 없음
```

### 2.5 인터페이스 설계 (MED/LOW)

```
[ ] 인터페이스 크기 — 1~3 메서드 (5+ 메서드 경고)
[ ] 인터페이스 정의 위치 — consumer 패키지 (구현 패키지 X)
[ ] 표준 라이브러리 인터페이스 재활용 (io.Reader 등)
```

### 2.6 코드 품질 (LOW)

```
[ ] 함수 50줄 이하
[ ] 중첩 깊이 4 이하 (early return 활용)
[ ] 네이밍 — Go 관습 (CamelCase, receiver 단문자)
[ ] 패키지 이름 — 단수 소문자 (orders X → order O)
[ ] golangci-lint 이슈 없음
```

## 3. 이슈 카탈로그 (즉시 참조)

| 패턴 | SEVERITY | 설명 |
|------|----------|------|
| `_ = err` | HIGH | 에러 묵살 |
| `db.Query(ctx, "... WHERE id = " + id)` | HIGH | SQL injection |
| `go func() { for { process() } }()` | HIGH | goroutine leak |
| `ctx, cancel := ...; cancel()` (defer 없음) | MED | context 누수 |
| `resp, _ := http.Get(url)` | HIGH | context 없음 + 에러 무시 |
| `resp.Body.Close()` 누락 | MED | resource leak |
| `interface` 5+ 메서드 | MED | 분리 필요 |
| `type Repo interface { ... }` in repo pkg | LOW | consumer 측 정의 권장 |
| `panic(err)` in handler | HIGH | 서버 크래시 |
| `fmt.Println(...)` in prod | LOW | slog 구조화 로그 |
| `json.Unmarshal(data, &v)` 에러 무시 | HIGH | 에러 처리 |

## 4. 관련 문서

- 원칙: [`principles/common.md`](../../../principles/common.md), [`principles/go.md`](../../../principles/go.md)
- 보안: [`skills/go/be-security/SKILL.md`](../be-security/SKILL.md)
