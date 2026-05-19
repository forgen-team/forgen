---
title: 공통 BE 원칙 (스택 중립)
version: 2026-05-18
sources:
  - sources/12factor/
  - sources/sre-book/
  - sources/owasp-api/
  - sources/otel/
  - sources/ddia/
  - sources/api-design/
  - sources/postgres/
---

# 공통 BE 원칙

> 모든 백엔드 코드(Node.js/Go/기타)에 적용되는 합의 원칙.
> 스택 특화 가이드는 [`node.md`](./node.md), [`go.md`](./go.md) 참조.

## 출처 우선순위 (충돌 시)

충돌이 발생하면 다음 순서로 더 높은 우선순위 출처를 따른다:

1. **12-Factor App** — 실행 환경 이식성·운영 합의 (config, logs, disposability)
2. **Google SRE Book** — 가용성·SLO·에러 예산 기준
3. **OWASP API Security Top 10** — 보안 기준선 (2023)
4. **OpenTelemetry** — 관찰가능성 계측 표준
5. **DDIA** (Designing Data-Intensive Applications) — 데이터 모델·분산 시스템 의사결정
6. **프레임워크 공식 문서** — Fastify / NestJS / Go stdlib 등
7. **벤더 권장** — AWS / GCP / Stripe 등

사용자 영향 우선순위: **security > availability > correctness > performance > readability**.

---

## A. API 설계 4원칙

> fe-guide의 코드 품질 4원칙(가독성/예측성/응집도/결합도)과 미러링.
> 각 원칙은 트레이드오프 관계다. 동시 만족 불가능 시 위 우선순위로 판단.

### A.1 명시성 (Explicitness) — 최우선

**API 계약은 코드보다 먼저, 명시적으로 존재해야 한다.**

- OpenAPI/Protobuf 스펙 파일이 구현보다 먼저 작성되어야 한다. 구현을 reverse로 생성한 스펙은 계약이 아니다.
- 요청/응답 필드의 optional/required를 스펙과 검증 코드에서 동일하게 명시한다.
  - 스펙에 optional인 필드를 서버 검증에서 required 취급하면 명세 위반.
  - 반대로 required 필드를 서버에서 검증 없이 통과시키면 runtime error 원인.
- **nullable vs optional은 다르다**. `"value": null`(nullable, 필드 존재) vs 필드 없음(absent, optional). 혼용 금지.
- 에러 응답 스펙도 동일하게 정의한다. "에러 시 알아서"는 계약이 아니다.

근거: `sources/api-design/`

### A.2 일관성 (Consistency)

**같은 개념은 API 전체에서 동일한 이름·모양을 가져야 한다.**

- 리소스 이름: 복수형 명사 (`/users`, `/orders`). 동사 금지 (`/getUser` X).
- HTTP 메서드: CRUD → GET/POST/PUT·PATCH/DELETE. 멱등성 기반으로 선택.
  - GET: 조회, 부작용 없음
  - POST: 생성 또는 비멱등 액션
  - PUT: 전체 교체 (멱등)
  - PATCH: 부분 수정 (멱등이 바람직하나 필수 아님)
  - DELETE: 삭제 (멱등)
- 날짜/시간: 항상 ISO 8601 UTC (`2026-05-18T07:00:00Z`). epoch int는 ms 단위 명시.
- 페이지네이션: 커서 기반 우선 (`cursor` + `limit`). 오프셋 기반은 대용량에서 퇴화.
  ```json
  { "data": [...], "nextCursor": "eyJpZCI6MTIzfQ==", "hasMore": true }
  ```
- 에러 코드: `SNAKE_CASE` 상수 (`PAYMENT_DECLINED`, `RESOURCE_NOT_FOUND`). HTTP 상태만으로 구분 금지.

근거: `sources/api-design/` (Stripe API + GitHub API + Google AIP)

### A.3 예측 가능성 (Predictability)

**같은 입력에는 항상 같은 출력. 부작용은 명시된 것만.**

- GET 요청이 데이터를 변경해서는 안 된다. CQRS(명령/조회 분리)를 기본 마음가짐으로.
- 같은 조건에서 동일 엔드포인트는 항상 같은 HTTP 상태 코드와 응답 구조를 반환한다.
- 벌크 연산에서 일부 성공/일부 실패 시 응답 모양: `{ "succeeded": [...], "failed": [{"id": ..., "error": {...}}] }` 형식으로 명시. 207 Multi-Status 활용.
- **숨은 부작용 금지**: 조회 API 내부에서 이벤트 발행, 통계 갱신 등을 몰래 수행하지 않는다. 필요하면 별도 endpoint 또는 명시적 문서화.

### A.4 진화 가능성 (Evolvability)

**API는 클라이언트를 깨지 않고 변경될 수 있어야 한다.**

- **하위 호환 변경** (클라이언트 알림 없이 가능):
  - 새 optional 필드 추가
  - 새 endpoint 추가
  - 새 enum 값 추가 (클라이언트가 unknown 처리해야 한다는 전제)
- **파괴적 변경** (버저닝 또는 deprecation notice 필수):
  - 필드 제거 또는 이름 변경
  - 타입 변경 (string → int)
  - 기존 enum 값 제거
  - HTTP 메서드/경로 변경
- URL 버저닝: `/v1/`, `/v2/` — 단순하고 캐시 친화적.
  - Path 버저닝 우선. Header 버저닝은 캐시 레이어에서 문제.
- Deprecation 정책: 최소 6개월 notice + `Deprecation` 응답 헤더 부착.
  ```
  Deprecation: Sun, 01 Jan 2027 00:00:00 GMT
  Sunset: Sun, 01 Jan 2027 00:00:00 GMT
  Link: <https://docs.example.com/migration/v2>; rel="deprecation"
  ```

근거: `sources/api-design/` (Google AIP-180)

---

## B. Error Model

**절대 silent fail 금지. 에러는 구조화된 값으로 반환한다.**

### B.1 에러 응답 구조

모든 에러 응답은 다음 구조를 준수한다:

```json
{
  "error": {
    "code": "PAYMENT_DECLINED",
    "message": "결제가 거절되었습니다. 카드 정보를 확인하세요.",
    "details": [
      {
        "field": "card.number",
        "reason": "INVALID_FORMAT"
      }
    ],
    "requestId": "req_01HX2V3K8..."
  }
}
```

- `code`: 기계가 읽는 SNAKE_CASE 상수. 클라이언트 분기 처리용.
- `message`: 사람이 읽는 설명. 필요 시 다국어화.
- `details`: 필드별 검증 오류 배열 (optional). 빈 배열이면 생략.
- `requestId`: 로그 추적용. 항상 포함. (correlation ID)

### B.2 4xx vs 5xx 경계

| 상황 | 코드 | 원칙 |
|------|------|------|
| 클라이언트 입력 오류 | 400 | 클라이언트가 고쳐야 함 — 재시도 의미 없음 |
| 인증 없음 | 401 | 자격증명 제공 필요 |
| 권한 없음 | 403 | 자격증명 있어도 불가 |
| 리소스 없음 | 404 | 존재하지 않음 |
| 비즈니스 규칙 위반 | 422 | 입력 형식은 맞지만 도메인 거부 |
| 속도 제한 | 429 | `Retry-After` 헤더 필수 |
| 서버 내부 오류 | 500 | 서버가 고쳐야 함 |
| 외부 의존성 실패 | 502/503 | 인프라/upstream 문제 |

**황금 규칙**: 4xx는 클라이언트 책임, 5xx는 서버 책임. 서버 오류를 200 + `{ "success": false }` 로 숨기지 마라.

### B.3 에러 로깅 기준

- 4xx: `warn` 레벨 (클라이언트 문제, 운영 알람 불필요)
- 5xx: `error` 레벨 + stack trace + requestId (즉시 알람 대상)
- 빈 catch 블록 절대 금지. 최소 `logger.error(err, { context: '...' })` + re-throw.

---

## C. Observability Triple

**로그 + 메트릭 + 트레이스. 세 가지 없으면 프로덕션 불가.**

### C.1 구조화 로그 (Structured Logging)

근거: `sources/sre-book/`, `sources/12factor/`

- **JSON 형식** 강제. 평문 로그는 파싱 불가 → 검색 불가.
  ```json
  {
    "timestamp": "2026-05-18T07:00:00.123Z",
    "level": "info",
    "message": "Order created",
    "service": "order-service",
    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
    "spanId": "00f067aa0ba902b7",
    "orderId": "ord_01HX2V3K8",
    "userId": "usr_01HX2V3K8",
    "durationMs": 142
  }
  ```
- **민감 정보 금지**: 비밀번호, 카드번호, 개인식별정보를 로그에 직접 기록하지 않는다. 마스킹 또는 토큰화.
- 12-Factor App Factor 11: 앱은 로그를 파일에 쓰지 않고 stdout으로만 출력. 수집은 인프라 책임.

### C.2 메트릭 — RED Method

근거: `sources/sre-book/` (4 Golden Signals의 서비스 중심 변형)

모든 서비스/엔드포인트에 대해:

| 메트릭 | 설명 | 예시 |
|--------|------|------|
| **Rate** | 요청 수 / 초 | `http_requests_total{method, path, status}` |
| **Errors** | 에러 비율 (5xx) | `http_errors_total{method, path, status}` |
| **Duration** | 응답 시간 분포 | `http_request_duration_seconds{quantile}` |

- histogram 버킷: 5ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s.
- p50/p95/p99 SLO는 코드베이스 README 또는 `docs/slo.md`에 명시 의무.

### C.3 분산 트레이스 (OpenTelemetry)

근거: `sources/otel/`

- **자동 계측(auto-instrumentation) 먼저**: HTTP 서버, DB 클라이언트, 메시지 큐는 OTel SDK 자동 계측 사용.
- **수동 span 추가 기준**: 비즈니스 로직 경계, 외부 API 호출, 중요한 내부 함수.
  ```typescript
  const span = tracer.startSpan('processPayment');
  try {
    span.setAttributes({ 'payment.amount': amount, 'payment.currency': currency });
    const result = await chargeCard(cardId, amount);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
  ```
- W3C TraceContext 헤더(`traceparent`) 전파: 모든 outbound HTTP 요청에 포함.
- `traceId`는 에러 응답의 `requestId`와 동일하게 사용해 로그-트레이스 연결.

---

## D. Idempotency & Retry

### D.1 멱등성 설계

- GET / DELETE / PUT: 본래 멱등. 재시도 안전.
- POST (생성 액션): **Idempotency-Key** 헤더로 멱등성 보장.
  ```
  POST /v1/payments
  Idempotency-Key: a8098c1a-f86e-11da-bd1a-00112444be1e
  ```
  - 서버는 Key를 캐시하고 동일 Key 재요청 시 캐시된 응답 반환 (24시간~7일 TTL).
  - 응답에 `Idempotency-Key` 반영 권장.
- **자연스럽지 않은 멱등성 강제 금지**: 복잡한 비즈니스 로직을 억지로 멱등화하기보다 클라이언트 재시도 전략을 명확히 하는 것이 낫다.

### D.2 재시도 전략 (Exponential Backoff + Jitter)

클라이언트 재시도 기준:

- 재시도 가능: 429, 500, 502, 503, 504, 네트워크 타임아웃
- 재시도 불가: 400, 401, 403, 404, 422 (클라이언트 오류는 재시도 의미 없음)

권장 공식:
```
delay = min(base * 2^attempt + random(0, base), max_delay)
```
- base: 1s, max_delay: 30s, max_attempts: 5
- **Full Jitter**: `random(0, min(cap, base * 2^attempt))` — thundering herd 방지

서버 측: 429 응답에 `Retry-After: 60` 헤더 필수.

---

## E. Security Baseline

근거: `sources/owasp-api/`

### E.1 입력 검증 경계

**외부에서 들어오는 모든 데이터는 신뢰하지 않는다.** 신뢰 경계를 명확히 그어라.

```
[Client] → [API Gateway / Load Balancer] → [Service] → [DB/Storage]
              ↑ TLS Termination               ↑ 여기서 검증
              ↑ Rate Limiting                  ↑ Business rule 검증
              ↑ Auth token 검증
```

- **경계에서 즉시 검증**: 컨트롤러/핸들러 진입 시 스키마 검증 통과 후에만 비즈니스 로직 진입.
- Path parameter, query string, request body, headers 모두 검증 대상.
- SQL/NoSQL Injection: ORM/parameterized query 강제. 문자열 concatenation으로 쿼리 작성 절대 금지.
- 파일 업로드: MIME type + magic bytes 검증, 저장 경로 path traversal 방지.

### E.2 인증/인가 분리

- **인증(Authentication)**: "누구인가?" — JWT / OAuth 2.0 / API Key
- **인가(Authorization)**: "무엇을 할 수 있는가?" — RBAC / ABAC
- **OWASP API1**: Broken Object Level Authorization — 매 요청마다 리소스 소유권 확인. `userId`를 JWT에서 추출, 경로 파라미터 `userId`와 일치 검증. URL 파라미터 변조로 타인 데이터 접근하는 패턴.
- 인가 로직은 서비스 레이어에서. 프레임워크 미들웨어에 전적으로 의존 금지.

### E.3 비밀 관리

- `.env` 파일 커밋 금지 (`.gitignore` + pre-commit hook).
- 프로덕션 시크릿: AWS Secrets Manager / GCP Secret Manager / Vault.
- 코드에 하드코딩된 시크릿 탐지: `git-secrets` 또는 CI gitleaks.
- **환경별 분리**: dev/staging/prod 시크릿 완전 분리. dev 시크릿이 prod에 닿아서는 안 됨.
- 12-Factor App Factor 3: Config를 환경변수에 저장.

### E.4 OWASP API Security Top 10 (2023) 매핑

| # | 취약점 | 핵심 대응 |
|---|--------|-----------|
| API1 | Broken Object Level Authorization | 모든 리소스 접근에 소유권 검증 |
| API2 | Broken Authentication | JWT 서명 알고리즘 명시 (`RS256`), 토큰 만료 검증 |
| API3 | Broken Object Property Level Auth | 응답에서 민감 필드 선택적 노출 (allowlist projection) |
| API4 | Unrestricted Resource Consumption | Rate limiting + 페이로드 크기 제한 |
| API5 | Broken Function Level Authorization | admin/user 기능 분리, HTTP 메서드 별 권한 검증 |
| API6 | Unrestricted Access to Sensitive Flows | 로그인/OTP에 rate limit + account lockout |
| API7 | Server Side Request Forgery | 외부 URL fetch 전 allowlist 검증 |
| API8 | Security Misconfiguration | CORS, 불필요 HTTP 메서드, 디버그 엔드포인트 비활성화 |
| API9 | Improper Inventory Management | API 버전 폐기 정책 + 스테이징 엔드포인트 노출 금지 |
| API10 | Unsafe Consumption of APIs | 외부 API 응답도 검증 (신뢰하지 않음) |

---

## F. Performance Baseline

### F.1 SLO 명시 의무

**p50/p95/p99 SLO를 코드와 함께 문서화하지 않으면 "빠르다"는 주장은 의미 없다.**

- `docs/slo.md` 또는 서비스 README에 명시:
  ```
  | Endpoint         | p50   | p95    | p99    | Error Budget |
  |------------------|-------|--------|--------|--------------|
  | GET /orders      | 50ms  | 200ms  | 500ms  | 99.9% / mo   |
  | POST /payments   | 200ms | 500ms  | 1000ms | 99.95% / mo  |
  ```
- 신규 기능 추가 시 해당 엔드포인트 SLO 영향도 검토 의무.

### F.2 N+1 쿼리 금지

ORM 사용 시 N+1은 가장 흔한 성능 함정:

```typescript
// WRONG: N개 주문마다 N번 쿼리
const orders = await Order.findAll();
for (const order of orders) {
  order.user = await User.findById(order.userId); // N번!
}

// RIGHT: JOIN 또는 별도 IN 쿼리로 한 번에
const orders = await Order.findAll({ include: [User] });
// 또는
const userIds = orders.map(o => o.userId);
const users = await User.findAll({ where: { id: { [Op.in]: userIds } } });
```

- Prisma: `include` / `select` 명시. `findMany` 후 루프 내 `findUnique` 패턴 금지.
- GORM: `Preload`, `Joins` 활용.
- DataLoader 패턴: GraphQL 또는 배치 처리 컨텍스트.

### F.3 캐싱 계층 명시

캐싱 전략을 코드 주석 또는 문서에 명시:

```
[요청] → [CDN / Edge Cache] → [API] → [Redis / Memcached] → [DB]
```

| 계층 | 적합한 데이터 | TTL 기준 |
|------|---------------|----------|
| CDN Edge | 공개 정적/준정적 API | 분~시간 |
| Redis/Memcached | 세션, 자주 읽히는 비공개 데이터 | 초~분 |
| Local (in-process) | 설정, enum 같은 불변 데이터 | 앱 수명 |

- **캐시 무효화 전략 명시**: TTL 기반 / 이벤트 기반 중 선택. "나중에 생각"은 캐시 불일치 버그 원인.
- **캐시 스탬피드 방지**: 만료 TTL에 jitter 추가 + lock/singleflight 패턴.

---

## G. DB 기본기

근거: `sources/ddia/`, `sources/postgres/`

### G.1 트랜잭션 경계 명시

- 트랜잭션 범위를 코드 주석으로 명시:
  ```typescript
  // TX: order 생성 + stock 차감 원자적 처리
  await db.transaction(async (trx) => {
    await Order.create({ ... }, { transaction: trx });
    await Stock.decrement('quantity', { by: 1, where: { productId }, transaction: trx });
  });
  ```
- **분산 트랜잭션은 피한다**. 마이크로서비스 간 2PC 대신 Saga 패턴 또는 보상 트랜잭션.
- 트랜잭션 내에서 외부 API 호출 금지 — 네트워크 지연이 lock 보유 시간을 늘린다.

### G.2 무중단 마이그레이션 (Expand/Contract)

**DB 스키마 변경은 배포와 분리해야 한다.** Breaking change를 피하는 3단계:

```
Phase 1 — Expand: 새 컬럼/테이블 추가. 기존 컬럼 유지. 앱은 둘 다 쓸 수 있게.
Phase 2 — Migrate: 기존 데이터를 새 구조로 이전. 앱 배포.
Phase 3 — Contract: 구 컬럼/테이블 제거. (Phase 2 완료 후 최소 1 릴리스 후)
```

- `DROP COLUMN` / `RENAME COLUMN` / 타입 변경은 반드시 Expand/Contract.
- NOT NULL 컬럼 추가: 기본값 있는 nullable로 먼저 추가 → 데이터 채움 → NOT NULL 제약.
- 마이그레이션 도구: Flyway / Liquibase / Alembic / golang-migrate. 파일 이름에 버전/타임스탬프.

### G.3 인덱스 의도 주석

```sql
-- 주문 목록 API: WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
-- 복합 인덱스로 index scan + filesort 없이 처리
CREATE INDEX idx_orders_user_created
  ON orders(user_id, created_at DESC);
```

- 인덱스 추가 시 반드시 "어떤 쿼리를 위한 인덱스인가" 주석.
- 사용되지 않는 인덱스는 제거한다 (write 부하 + vacuum 비용).
- `EXPLAIN ANALYZE` 결과를 PR에 첨부하는 관행을 유지한다.

---

## H. 안티패턴 카탈로그 (리뷰에서 즉시 [HIGH] 잡아라)

| 안티패턴 | 근거 | 픽스 |
|----------|------|------|
| 빈 catch 블록 | global rules / anti-pattern | 최소 로그 + re-throw |
| 50줄 초과 함수 | global rules | 책임별 분리 |
| 중첩 깊이 5+ | global rules | early return |
| HTTP 200 + `{ "success": false }` | Error Model B.2 | 적절한 4xx/5xx 사용 |
| 문자열 concatenation SQL | Security E.1 | parameterized query |
| 루프 내 DB 쿼리 (N+1) | Performance F.2 | 배치 쿼리 / JOIN |
| 하드코딩 시크릿 | Security E.3 | 환경변수 / 시크릿 매니저 |
| 트랜잭션 내 외부 API 호출 | DB G.1 | 트랜잭션 밖으로 이동 |
| 분산 트랜잭션 (2PC) | DB G.1 | Saga / 보상 트랜잭션 |
| SLO 없이 "빠르다" 주장 | Performance F.1 | docs/slo.md 작성 |
| 인덱스 의도 주석 없음 | DB G.3 | 쿼리 → 인덱스 주석 |
| URL 파라미터로 타인 리소스 접근 | OWASP API1 | 소유권 검증 |
| 응답에 전체 모델 그대로 반환 | OWASP API3 | allowlist projection |
| 로그에 개인정보 | Security E.1 | 마스킹 / 토큰화 |
| 환경별 시크릿 미분리 | Security E.3 | 환경별 완전 분리 |
| `DROP COLUMN` 즉시 실행 | DB G.2 | Expand/Contract 패턴 |
| 평문 로그 (비구조화) | Observability C.1 | JSON 구조화 로그 |
| traceId 없는 에러 응답 | Observability C.3 | requestId 포함 |
