---
name: be-perf-node
description: Node.js 서비스의 p95/p99 성능 문제를 진단하고 수정. DB N+1, Event Loop 차단, GC 압박, 동기 차단, lock contention, network roundtrip 카테고리별 절차로 접근한다.
---

# be-perf (Node.js)

> **호출 시점**: "p99가 800ms야 잡아줘", "메모리가 계속 올라가", "DB 쿼리가 느려졌어", "CPU가 치솟아".
> **선행 로딩**: `principles/common.md` + `principles/node.md` 필수.

## 0. 절대 금지

1. 측정 없이 최적화 추측 금지 — "아마 이게 느릴 것 같아"는 근거 없음.
2. p50만 보고 OK 선언 금지 — p95/p99 반드시 확인.
3. 프로파일링 없이 `async/await` → callback 전환 금지 (성능 개선 미미, 가독성 손실 큼).

## 1. 진단 절차

### Step 1 — 현재 지표 수집

먼저 수치를 확인하라. 추측으로 시작하지 마라.

```bash
# APM 또는 Prometheus 메트릭
# http_request_duration_seconds{quantile="0.95"} — p95
# http_request_duration_seconds{quantile="0.99"} — p99

# 로드 테스트로 현재 기준선 측정
npx autocannon -c 100 -d 30 http://localhost:3000/api/orders
# Requests/sec, Latency 분포, Errors 확인
```

### Step 2 — 병목 카테고리 분류

| 증상 | 가능한 카테고리 |
|------|-----------------|
| DB 쿼리가 느림 (APM에서 확인) | N+1, 인덱스 누락, 슬로우 쿼리 |
| CPU 사용률 치솟음 | Event Loop 차단, GC 압박, 동기 연산 |
| 메모리 지속 증가 | 메모리 누수, GC 부족 |
| 특정 엔드포인트만 느림 | 해당 경로 분석 (외부 API, 직렬화) |
| 모든 요청 느림 | Event Loop 차단, 연결 풀 소진 |

### Step 3 — 카테고리별 진단 실행

## 2. 카테고리별 진단 및 픽스

### 2.1 DB N+1

**탐지**: APM에서 단일 요청에 DB 쿼리 N+1개 발생. 로그에서 반복 쿼리 패턴.

```typescript
// Prisma 탐지: queryRawUnsafe 이벤트 로깅
prisma.$on('query', (e) => {
  if (process.env.NODE_ENV === 'development') {
    logger.debug({ query: e.query, duration: e.duration }, 'DB query');
  }
});
```

**픽스**:
```typescript
// WRONG: N+1
const orders = await prisma.order.findMany();
for (const order of orders) {
  order.user = await prisma.user.findUnique({ where: { id: order.userId } });
}

// RIGHT: include로 JOIN
const orders = await prisma.order.findMany({
  include: { user: { select: { id: true, name: true } } },  // 필요한 필드만
});

// 대용량: DataLoader 패턴
import DataLoader from 'dataloader';
const userLoader = new DataLoader<string, User>(async (ids) => {
  const users = await prisma.user.findMany({ where: { id: { in: [...ids] } } });
  return ids.map(id => users.find(u => u.id === id) ?? null);
});
```

### 2.2 Event Loop 차단

**탐지**: `--inspect` 플래그로 Node.js 프로파일러 실행.

```bash
node --inspect --prof app.js  # V8 프로파일 생성
node --prof-process isolate-*.log > profile.txt  # 분석
```

또는 clinic.js (권장):
```bash
npx clinic doctor -- node app.js
npx clinic flame -- node app.js  # Flamegraph
```

**픽스**:
```typescript
// 동기 블로킹 → 비동기
// WRONG
import { readFileSync } from 'node:fs';
app.get('/config', (req, res) => {
  const config = readFileSync('config.json', 'utf-8');  // 차단!
  res.json(JSON.parse(config));
});

// RIGHT
import { readFile } from 'node:fs/promises';
app.get('/config', async (req, res) => {
  const config = await readFile('config.json', 'utf-8');
  res.json(JSON.parse(config));
});

// CPU 집약 작업 → worker_threads
import { Worker } from 'node:worker_threads';
function runInWorker(data: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker('./workers/compute.js', { workerData: data });
    worker.on('message', resolve);
    worker.on('error', reject);
  });
}
```

### 2.3 GC 압박 (메모리)

**탐지**:
```bash
# heapdump 분석
node --expose-gc app.js
# 또는
npx clinic heapprofiler -- node app.js
```

```typescript
// 메모리 사용량 모니터링
setInterval(() => {
  const mem = process.memoryUsage();
  logger.info({
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
    rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
  }, 'Memory usage');
}, 30_000);
```

**흔한 누수 패턴**:
```typescript
// WRONG: EventEmitter 리스너 누수
app.on('request', handler);  // 제거 없음

// RIGHT: 명시적 제거
const handler = () => { ... };
app.on('request', handler);
// ... 정리 시
app.off('request', handler);

// WRONG: 클로저가 큰 객체 참조
function processRequest(req: Request) {
  const hugeBuffer = Buffer.alloc(1024 * 1024 * 100);  // 100MB
  return async () => {
    // hugeBuffer가 클로저에 갇혀 GC 불가
    return hugeBuffer.length;
  };
}
```

### 2.4 외부 API 지연 (Network Roundtrip)

**탐지**: OpenTelemetry span에서 external call duration 확인.

**픽스**:
```typescript
// 병렬화 — 독립적인 외부 호출은 동시 실행
const [user, inventory] = await Promise.all([
  userApiClient.getUser(userId),
  inventoryApiClient.getStock(productId),
]);

// 타임아웃 설정 (기본값 없음에 의존 금지)
const response = await fetch(url, {
  signal: AbortSignal.timeout(3000),  // 3초 타임아웃
});

// 서킷 브레이커 (opossum)
import CircuitBreaker from 'opossum';
const breaker = new CircuitBreaker(externalApiCall, {
  timeout: 3000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
});
```

### 2.5 DB 연결 풀 소진

**탐지**: DB 응답 느림 + 연결 대기 큐 증가.

```typescript
// Prisma 연결 풀 설정
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: `${DATABASE_URL}?connection_limit=10&pool_timeout=10`,
    },
  },
});

// pg (node-postgres) 연결 풀
import { Pool } from 'pg';
const pool = new Pool({
  max: 10,              // 최대 연결 수
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// 연결 풀 모니터링
setInterval(() => {
  logger.info({
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  }, 'Connection pool stats');
}, 10_000);
```

### 2.6 직렬화 비용 (대용량 JSON)

```typescript
// WRONG: 대용량 객체 통째로 JSON.stringify
res.json(await db.findManyWithAllFields());

// RIGHT: 필요한 필드만 선택 (projection)
const orders = await prisma.order.findMany({
  select: { id: true, status: true, createdAt: true },  // 필요한 것만
  take: 20,  // 페이지네이션
});

// 대용량 응답: 스트리밍
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
app.get('/export', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  const cursor = db.findManyCursor();  // DB 커서
  await pipeline(cursor, res);
});
```

## 3. 출력 형식

```
## 성능 진단 결과

### 측정 기준선
- p50: Xms / p95: Xms / p99: Xms
- 목표 SLO: p95 < Xms (docs/slo.md)

### 발견된 병목
1. [카테고리] file:line — 설명 (예상 개선: X%)
2. ...

### 적용한 픽스
- 변경 파일: <목록>
- 재측정 결과: p95 Xms → Xms

### 추가 권고 (이번 PR 범위 외)
- ...
```

## 4. 관련 문서

- 원칙: [`principles/common.md`](../../../principles/common.md) F섹션 (Performance Baseline)
- 리뷰: [`skills/node/be-review/SKILL.md`](../be-review/SKILL.md)
- 코퍼스: `sources/node-runtime/`, `sources/postgres/`
