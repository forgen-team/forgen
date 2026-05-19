---
name: be-security-node
description: Node.js/TypeScript 서비스를 OWASP API Security Top 10 기준으로 진단. 카테고리별 체크리스트와 픽스 패턴을 제공한다.
---

# be-security (Node.js)

> **호출 시점**: "이 핸들러 보안 검토해줘", "OWASP 관점에서 체크해줘", "보안 감사 준비해줘".
> **선행 로딩**: `principles/common.md` (E섹션 Security Baseline) + `principles/node.md` 필수.

## 0. 절대 금지

1. "보안은 나중에" 금지 — 설계 단계부터 체크리스트 적용.
2. 보안 이슈를 [LOW]로 다운그레이드 금지 — OWASP Top 10은 모두 [HIGH].
3. 취약점 발견 후 "일단 배포" 금지 — 패치 후 배포.

## 1. 워크플로우

### Step 1 — 공격 표면 파악

```markdown
## 공격 표면 목록
- 공개 엔드포인트: GET /api/orders, POST /api/payments, ...
- 인증 필요: PUT /api/orders/:id, DELETE /api/...
- 관리자 전용: POST /api/admin/...
- 외부 입력: req.body, req.params, req.query, req.headers
- 파일 업로드: POST /api/uploads
```

### Step 2 — OWASP Top 10 순서로 진단

각 카테고리를 순서대로 실행. 발견 즉시 기록.

### Step 3 — 취약점 보고

```
[HIGH] src/orders/order.controller.ts:42 — API1: 소유권 검증 없음, req.user.id vs params.userId 비교 누락
[HIGH] src/auth/auth.controller.ts:88 — API6: 로그인 엔드포인트에 rate limit 없음
```

### Step 4 — 픽스 + 검증

픽스 후 해당 패턴 재검증. 테스트 케이스 추가 권장.

## 2. OWASP API Top 10 체크리스트 (2023)

### API1 — Broken Object Level Authorization

**"내 리소스만 접근 가능한가?"**

```typescript
// WRONG: URL params userId를 그대로 신뢰
app.get('/api/orders/:orderId', async (req, res) => {
  const order = await orderRepo.findById(req.params.orderId);
  res.json(order);  // 다른 유저 주문도 접근 가능!
});

// RIGHT: 요청자 소유권 확인
app.get('/api/orders/:orderId', authenticate, async (req, res) => {
  const order = await orderRepo.findById(req.params.orderId);
  if (!order) return res.status(404).json({ error: { code: 'NOT_FOUND' } });
  if (order.userId !== req.user.id) {  // 소유권 검증 필수
    return res.status(403).json({ error: { code: 'FORBIDDEN' } });
  }
  res.json(order);
});
```

체크:
```
[ ] 모든 리소스 접근에 소유권 검증 존재
[ ] JWT에서 userId 추출 (req.params.userId 신뢰 금지)
[ ] 관리자 우회 경로에도 권한 검증
```

### API2 — Broken Authentication

**"토큰이 진짜인가? 만료됐는가?"**

```typescript
import jwt from 'jsonwebtoken';

// WRONG: 알고리즘 명시 안 함 (none 알고리즘 공격 위험)
jwt.verify(token, secret);

// RIGHT: 알고리즘 명시
jwt.verify(token, process.env.JWT_PUBLIC_KEY!, {
  algorithms: ['RS256'],  // HS256도 가능하지만 RS256 권장 (비대칭)
  issuer: 'auth.example.com',
  audience: 'api.example.com',
});
```

체크:
```
[ ] JWT 알고리즘 명시 (algorithms: ['RS256'])
[ ] 토큰 만료 검증 (exp claim)
[ ] 시크릿/키가 env에서 로드 (하드코딩 금지)
[ ] Refresh token rotation 구현 (refresh 후 구 토큰 무효화)
[ ] 로그아웃 시 토큰 블랙리스트 또는 단기 만료
```

### API3 — Broken Object Property Level Authorization

**"응답에 불필요한 필드가 포함되는가?"**

```typescript
// WRONG: DB 모델 그대로 반환
const user = await prisma.user.findUnique({ where: { id } });
res.json(user);  // password hash, internal flags 등 노출!

// RIGHT: allowlist projection
const user = await prisma.user.findUnique({
  where: { id },
  select: { id: true, name: true, email: true },  // 필요한 것만
});
res.json(user);

// 또는 직렬화 레이어
function serializeUser(user: User): PublicUser {
  const { passwordHash, internalFlags, ...publicFields } = user;
  return publicFields;
}
```

체크:
```
[ ] 응답 스키마 allowlist 정의 (전체 모델 반환 금지)
[ ] password, hash, secret, internal 필드 응답 제외
[ ] mass assignment 방지 (req.body를 DB에 spread 금지)
```

### API4 — Unrestricted Resource Consumption

**"무한 요청/대용량 페이로드를 막는가?"**

```typescript
import rateLimit from 'express-rate-limit';

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15분
  max: 100,                    // 최대 100 요청
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: { code: 'TOO_MANY_REQUESTS', message: '요청 한도 초과' },
    });
  },
});

// 페이로드 크기 제한
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 파일 업로드 크기 제한
import multer from 'multer';
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });  // 10MB
```

체크:
```
[ ] Rate limiting — 전역 + 민감 엔드포인트별 강화
[ ] Request body 크기 제한 (1MB 이하 권장)
[ ] 파일 업로드 크기 제한
[ ] 페이지네이션 limit 상한 (limit=10000 같은 무한 요청 방지)
[ ] Retry-After 헤더 (429 응답 시)
```

### API5 — Broken Function Level Authorization

**"관리자 기능을 일반 유저가 호출할 수 없는가?"**

```typescript
// 역할 기반 미들웨어
function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN' } });
    }
    next();
  };
}

app.delete('/api/admin/users/:id', authenticate, requireRole('admin'), deleteUser);
app.get('/api/admin/stats', authenticate, requireRole('admin', 'analyst'), getStats);
```

체크:
```
[ ] 관리자 엔드포인트 별도 인가 미들웨어
[ ] HTTP 메서드별 권한 분리 (GET vs DELETE 다른 권한)
[ ] 숨겨진 관리자 경로 (/api/internal, /debug) 외부 노출 여부
[ ] 권한 검사를 비즈니스 로직 내부에도 (미들웨어 우회 가능성 고려)
```

### API6 — Unrestricted Access to Sensitive Flows

**"로그인/OTP/비밀번호 재설정에 무차별 대입 방어가 있는가?"**

```typescript
// 로그인 전용 강화 rate limit
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,  // 15분에 10회
  skipSuccessfulRequests: true,
  keyGenerator: (req) => req.ip + ':' + req.body?.email,  // IP + 이메일 조합
});

app.post('/api/auth/login', authLimiter, loginHandler);
app.post('/api/auth/forgot-password', authLimiter, forgotPasswordHandler);

// 계정 잠금 (DB에서 실패 횟수 추적)
async function loginHandler(req: Request, res: Response) {
  const user = await userRepo.findByEmail(req.body.email);
  if (user && user.failedAttempts >= 5 && user.lockedUntil > new Date()) {
    return res.status(429).json({ error: { code: 'ACCOUNT_LOCKED' } });
  }
  // ...
}
```

체크:
```
[ ] 로그인 엔드포인트 rate limit (IP + 이메일 조합)
[ ] OTP/인증코드 rate limit
[ ] 계정 잠금 정책 (N회 실패 → 잠금)
[ ] 비밀번호 재설정 토큰 단기 만료 (15분)
[ ] 비밀번호 재설정 토큰 1회 사용 후 무효화
```

### API7 — Server Side Request Forgery (SSRF)

**"사용자가 지정한 URL로 서버가 요청을 보내는가?"**

```typescript
import { URL } from 'node:url';

const ALLOWED_HOSTS = new Set(['api.trustedpartner.com', 'webhooks.example.com']);

function validateWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['https:'].includes(parsed.protocol)) return false;
    if (!ALLOWED_HOSTS.has(parsed.hostname)) return false;
    // private IP 차단
    const ip = await resolveHostname(parsed.hostname);
    if (isPrivateIP(ip)) return false;
    return true;
  } catch {
    return false;
  }
}
```

체크:
```
[ ] 사용자 입력 URL fetch 전 allowlist 검증
[ ] private IP (10.x, 172.16.x, 192.168.x, 127.x) 접근 차단
[ ] protocol 검증 (https만 허용)
[ ] redirect follow 제한
```

### API8 — Security Misconfiguration

```typescript
// Helmet.js — 보안 헤더 자동 설정
import helmet from 'helmet';
app.use(helmet());  // CSP, HSTS, X-Frame-Options 등

// CORS — allowlist 기반
import cors from 'cors';
app.use(cors({
  origin: ['https://app.example.com', 'https://admin.example.com'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
}));

// 개발 전용 엔드포인트 프로덕션 노출 금지
if (process.env.NODE_ENV !== 'production') {
  app.get('/debug/health-detail', debugHandler);
}
```

체크:
```
[ ] CORS origin이 * 아님 (allowlist)
[ ] Helmet.js 또는 동등한 보안 헤더
[ ] 스택 trace가 에러 응답에 포함되지 않음 (production)
[ ] 디버그/내부 엔드포인트 프로덕션 비활성화
[ ] 불필요한 HTTP 메서드 비활성화
[ ] X-Powered-By 헤더 제거 (프레임워크 노출)
```

### API9 — Improper Inventory Management

```
[ ] API 버전 목록 문서화 (deprecated 포함)
[ ] 구 버전 /v0, /v1 폐기 계획 및 Sunset 날짜
[ ] 스테이징/개발 엔드포인트 인터넷 노출 여부
[ ] API 게이트웨이에서 활성 엔드포인트 목록 관리
```

### API10 — Unsafe Consumption of APIs

**"외부 API 응답을 그대로 신뢰하는가?"**

```typescript
// WRONG: 외부 응답 신뢰
const externalData = await fetch(externalApiUrl).then(r => r.json());
await db.insert(externalData);  // 외부 데이터를 검증 없이 삽입!

// RIGHT: 외부 응답도 Zod로 검증
const ExternalResponseSchema = z.object({
  id: z.string(),
  amount: z.number().positive(),
  status: z.enum(['pending', 'completed', 'failed']),
});

const raw = await fetch(externalApiUrl).then(r => r.json());
const validated = ExternalResponseSchema.parse(raw);  // 검증 후 사용
```

체크:
```
[ ] 외부 API 응답 스키마 검증 (Zod 등)
[ ] 외부 API 타임아웃 설정
[ ] 외부 API 실패 시 fallback 또는 에러 전파
[ ] 외부 API SSL 인증서 검증 (rejectUnauthorized: false 금지)
```

## 3. 출력 형식

```
## 보안 감사 결과

### 공격 표면: N개 엔드포인트

### 발견된 취약점
[HIGH] API1 src/orders/order.controller.ts:42 — 소유권 검증 없음
[HIGH] API6 src/auth/auth.controller.ts:15 — 로그인 rate limit 없음

### 통과한 항목
- API2: JWT RS256 + 만료 검증 ✅
- API4: Rate limit (전역 100/15min) ✅

### 권고 사항
- API8: helmet.js 미적용 → 즉시 적용 권장
```

## 4. 관련 문서

- 원칙: [`principles/common.md`](../../../principles/common.md) E섹션
- 코퍼스: `sources/owasp-api/`
