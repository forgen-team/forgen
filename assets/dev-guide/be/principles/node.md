---
title: Node.js + TypeScript 원칙
version: 2026-05-18
sources:
  - sources/node-runtime/
---

# Node.js + TypeScript 원칙

> [공통 원칙](./common.md)을 먼저 따르고, 아래는 Node.js/TypeScript 특화.

## N0. 의사결정 우선순위

1. **비동기는 async/await 일관성** — callback 혼용 금지
2. **process 안정성** — unhandledRejection / uncaughtException 반드시 처리
3. **Event Loop 보호** — CPU heavy는 worker_threads로 격리
4. **입력 경계 강화** — Zod/io-ts 런타임 검증
5. **TypeScript strict** — 타입 시스템을 안전망으로 최대 활용

---

## N1. async/await 일관성

**callback과 async/await를 혼용하지 마라. async/await로 통일한다.**

### N1.1 기본 규칙

```typescript
// WRONG: Promise + callback 혼용
function fetchUser(id: string, callback: (err: Error | null, user?: User) => void) {
  db.query('SELECT * FROM users WHERE id = ?', [id])
    .then(result => callback(null, result))
    .catch(err => callback(err));
}

// RIGHT: async/await 통일
async function fetchUser(id: string): Promise<User> {
  const result = await db.query('SELECT * FROM users WHERE id = ?', [id]);
  return result;
}
```

### N1.2 기존 callback API 래핑

Node.js 레거시 API (`fs.readFile` 등)는 `util.promisify` 또는 `fs/promises` 사용:

```typescript
import { readFile } from 'node:fs/promises';  // 모던 방식
// 또는
import { promisify } from 'node:util';
import { readFile } from 'node:fs';
const readFileAsync = promisify(readFile);     // 레거시 래핑
```

### N1.3 병렬 처리

독립적인 async 작업은 `Promise.all` / `Promise.allSettled`:

```typescript
// WRONG: 순차 await (불필요한 직렬화)
const user = await fetchUser(userId);
const orders = await fetchOrders(userId);

// RIGHT: 병렬 실행
const [user, orders] = await Promise.all([fetchUser(userId), fetchOrders(userId)]);

// 일부 실패 허용 시
const results = await Promise.allSettled([fetchUser(userId), fetchOrders(userId)]);
results.forEach(result => {
  if (result.status === 'rejected') logger.warn('fetch failed', result.reason);
});
```

---

## N2. Top-Level Error Handler

**process 수준 에러를 반드시 처리한다. 처리하지 않으면 서비스가 조용히 죽는다.**

```typescript
// app.ts — 진입점에서 최우선 등록
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled Promise Rejection');
  // graceful exit: 진행 중인 요청 처리 후 종료
  gracefulShutdown(1);
});

process.on('uncaughtException', (err, origin) => {
  logger.fatal({ err, origin }, 'Uncaught Exception — process will exit');
  // uncaughtException 후 프로세스 상태 보장 불가 → 즉시 종료
  process.exit(1);
});

// Graceful shutdown: SIGTERM (Docker/K8s 종료 신호)
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, starting graceful shutdown');
  gracefulShutdown(0);
});

async function gracefulShutdown(exitCode: number) {
  // 1. 새 요청 거부 (load balancer 헬스체크 실패 대기)
  server.close();
  // 2. 진행 중 요청 완료 대기 (max 30s)
  await new Promise(resolve => setTimeout(resolve, 30_000));
  // 3. DB 연결 종료
  await db.destroy();
  process.exit(exitCode);
}
```

### N2.1 Express/Fastify 에러 핸들러

```typescript
// Express 에러 핸들러 (4인자 필수)
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  const statusCode = err instanceof AppError ? err.statusCode : 500;
  logger.error({ err, requestId: req.id, path: req.path }, 'Request error');
  res.status(statusCode).json({
    error: {
      code: err instanceof AppError ? err.code : 'INTERNAL_ERROR',
      message: statusCode < 500 ? err.message : '서버 오류가 발생했습니다',
      requestId: req.id,
    },
  });
});

// Fastify는 setErrorHandler 사용
fastify.setErrorHandler((err, request, reply) => {
  request.log.error({ err }, 'Request error');
  reply.status(err.statusCode ?? 500).send({ error: { ... } });
});
```

---

## N3. Event Loop 보호

**Node.js는 단일 스레드. CPU heavy 작업이 Event Loop를 막으면 모든 요청이 멈춘다.**

### N3.1 Event Loop 차단 탐지

```typescript
// 차단 탐지: toobusy-js 또는 clinic.js
import toobusy from 'toobusy-js';
app.use((req, res, next) => {
  if (toobusy()) {
    res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: '일시적 과부하' } });
    return;
  }
  next();
});
```

### N3.2 CPU Heavy 작업 격리

```typescript
// worker_threads로 CPU 집약 작업 격리
import { Worker, workerData, parentPort } from 'node:worker_threads';
import { resolve } from 'node:path';

function runHeavyTask(input: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(resolve(__dirname, 'workers/heavy-task.js'), {
      workerData: input,
    });
    worker.on('message', resolve);
    worker.on('error', reject);
    worker.on('exit', code => {
      if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
    });
  });
}
```

차단 기준: 10ms 이상 동기 CPU 연산 → worker_threads 고려.
- 이미지 리사이징 (sharp는 내부 libuv 스레드풀 사용 → 괜찮음)
- 암호화 (crypto 모듈 → 내부 C++ 바인딩, 대부분 OK)
- JSON 파싱 대용량 (>1MB) → 차단 위험
- bcrypt 해싱 → 동기 방식 금지, 비동기 사용

### N3.3 setImmediate / process.nextTick 사용 기준

```typescript
// process.nextTick: 현재 operation 완료 즉시 (I/O 앞)
// 주의: 무한 루프 가능 → 재귀 호출 금지
process.nextTick(() => emitter.emit('ready'));

// setImmediate: 현재 I/O 이벤트 사이클 이후
// 긴 작업을 여러 tick으로 분산할 때
function processLargeArray(arr: unknown[], callback: () => void, index = 0) {
  if (index >= arr.length) return callback();
  processSingleItem(arr[index]);
  setImmediate(() => processLargeArray(arr, callback, index + 1));
}
```

---

## N4. Stream Backpressure 존중

**readable.pipe()는 자동으로 backpressure를 처리한다. 수동 구현 시 반드시 확인.**

```typescript
// WRONG: backpressure 무시
readable.on('data', chunk => {
  writable.write(chunk); // writable buffer가 가득 차도 계속 push
});

// RIGHT: pipe 사용 (자동 backpressure)
readable.pipe(writable);

// 또는 stream.pipeline (에러 처리 포함)
import { pipeline } from 'node:stream/promises';
await pipeline(
  fs.createReadStream('large-file.csv'),
  new TransformStream(), // 변환 단계
  fs.createWriteStream('output.csv'),
);
```

### N4.1 고수량 스트림 패턴

```typescript
// Readable stream async iterator (Node.js 10+)
async function processCSV(filePath: string): Promise<void> {
  const readable = fs.createReadStream(filePath).pipe(csvParser());
  for await (const row of readable) {
    await processRow(row); // 처리 완료 후 다음 청크 요청 (backpressure 자연스럽게 적용)
  }
}
```

---

## N5. 입력 경계 검증 (Zod)

**런타임 검증 없는 TypeScript 타입 단언(`as User`)은 안전하지 않다.**

```typescript
import { z } from 'zod';

// 스키마 정의 — single source of truth
const CreateOrderSchema = z.object({
  userId: z.string().uuid(),
  items: z.array(
    z.object({
      productId: z.string().uuid(),
      quantity: z.number().int().positive(),
    })
  ).min(1),
  couponCode: z.string().optional(),  // 옵셔널 명시 — 검증 로직에서 required 취급 금지
});

type CreateOrderInput = z.infer<typeof CreateOrderSchema>;

// 핸들러
async function createOrder(req: Request, res: Response) {
  const parsed = CreateOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: '입력값이 올바르지 않습니다',
        details: parsed.error.flatten().fieldErrors,
      },
    });
  }
  const input: CreateOrderInput = parsed.data;
  // 이 시점부터 input은 타입 안전
  await orderService.create(input);
}
```

- **옵셔널 필드는 스키마와 비즈니스 로직에서 동일하게 처리**: `.optional()` 이면 값이 없어도 통과.
- 응답 직렬화도 검증: `z.output` 또는 `.transform()` 으로 응답 필드 선택.

---

## N6. TypeScript Strict 설정

```json
// tsconfig.json — 최소 설정
{
  "compilerOptions": {
    "strict": true,                        // null 체크, implicit any, 등 통합
    "noUncheckedIndexedAccess": true,      // arr[0] 타입이 T | undefined (배열 경계 안전)
    "exactOptionalPropertyTypes": true,    // optional: 값이 undefined일 때 assign 금지
    "noImplicitReturns": true,             // 모든 분기에서 return 강제
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "bundler",         // ESM + bundler 환경
    "target": "ES2022",
    "lib": ["ES2022"]
  }
}
```

### N6.1 타입 단언 규칙

```typescript
// WRONG: 타입 단언으로 런타임 오류 숨김
const user = cache.get('user') as User;  // undefined일 수 있음

// RIGHT: 명시적 가드
const raw = cache.get('user');
if (!raw) throw new Error('Cache miss: user');
const user = UserSchema.parse(raw);  // 런타임 검증
```

- `as T` 단언은 외부 데이터, 레거시 코드와의 경계에서만 허용. 내부 코드에서는 타입 추론 활용.
- `!` non-null assertion은 null/undefined가 불가능한 이유를 주석으로 설명.

---

## N7. 의존성 트리 관리

근거: `sources/node-runtime/`

### N7.1 의존성 최소화 원칙

- 새 패키지 도입 전 체크리스트:
  1. 표준 라이브러리(`node:fs`, `node:crypto`)로 해결 가능한가?
  2. 기존 의존성으로 해결 가능한가?
  3. 코드 10줄 미만이면 직접 구현하는 것이 낫지 않은가?
- 번들 크기 영향: `bundlephobia.com` 또는 `npm ls --depth=0` 확인.

### N7.2 보안 감사

```bash
# 의존성 취약점 감사 (CI에 포함)
npm audit --audit-level=high

# 의존성 업데이트 (weekly)
npx npm-check-updates -u && npm install

# supply chain 감사
npx audit-ci --high
```

### N7.3 Lock 파일 정책

- `package-lock.json` 또는 `pnpm-lock.yaml` 반드시 커밋.
- CI에서 `npm ci` (lockfile 기반 설치). `npm install` 금지.
- 의존성 업데이트는 별도 PR — 기능 PR에 섞지 않는다.

---

## N8. 구조화 로그 (Pino)

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // 프로덕션: JSON 출력 (stdout)
  // 개발: pino-pretty로 가독성 향상
  transport: process.env.NODE_ENV === 'development'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
  // 민감 정보 자동 리댁션
  redact: ['req.headers.authorization', '*.password', '*.cardNumber'],
  base: {
    service: process.env.SERVICE_NAME ?? 'unknown',
    env: process.env.NODE_ENV ?? 'development',
  },
});

// Request logger 미들웨어 (Fastify는 내장, Express는 pino-http)
import pinoHttp from 'pino-http';
app.use(pinoHttp({ logger }));
```

---

## N9. Node.js 안티패턴 카탈로그

| 안티패턴 | 픽스 |
|----------|------|
| `process.on('unhandledRejection')` 미등록 | 앱 진입점에서 즉시 등록 |
| 동기 I/O (`fs.readFileSync`) in 핸들러 | `fs/promises` 비동기 버전 |
| `require()` 루프 내 동적 로딩 | 모듈 수준 캐싱 (require는 캐시됨, import() 동적 주의) |
| callback + async 혼용 | async/await 통일 |
| 런타임 검증 없는 `as T` 단언 | Zod safeParse |
| `npm install` in CI | `npm ci` (lockfile 기반) |
| 로그에 `req.body` 통째로 기록 | redact 설정 |
| `bcrypt.hashSync()` | `bcrypt.hash()` (비동기) |
| `JSON.parse(hugeString)` 동기 | 청크 분할 또는 worker_threads |
| `tsconfig.strict: false` | strict 활성화 |
