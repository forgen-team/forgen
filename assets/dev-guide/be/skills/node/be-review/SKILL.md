---
name: be-review-node
description: Node.js/TypeScript PR을 사내 BE 원칙 기준으로 리뷰. [SEVERITY] file:line — 이슈 형식으로 출력하고, 머지 차단/비차단을 명확히 구분한다.
---

# be-review (Node.js)

> **호출 시점**: "이 PR 리뷰해줘", "이 코드 리뷰해줘", "OWASP 관점에서 검토해줘".
> **선행 로딩**: `principles/common.md` + `principles/node.md` 필수.

## 0. 절대 금지

1. 이슈 없이 "좋아 보입니다" 완료 선언 금지 — 모든 체크리스트 항목 확인.
2. 주관적 스타일 의견을 [HIGH]로 분류 금지.
3. 자동 수정 가능한 포매팅 이슈를 리뷰에 포함 금지 (eslint --fix 로 처리).

## 1. 리뷰 출력 형식

```
## 리뷰 요약
- 변경: N files +X -Y
- HIGH N, MED N, LOW N / 머지 [차단|비차단]

[HIGH] src/orders/order.controller.ts:42 — SQL 문자열 concat, injection 위험
[HIGH] src/orders/order.service.ts:88 — 빈 catch 블록, 에러 묵살
[MED]  src/orders/order.service.ts:120 — optional couponCode를 required 취급 (명세 위반)
[LOW]  src/orders/types.ts:15 — 매직 넘버 300, 상수 추출 권장
```

### SEVERITY 기준

| SEVERITY | 정의 | 머지 |
|----------|------|------|
| **HIGH** | 보안 취약점, 데이터 손실 가능, 명세 위반, 에러 묵살, 프로세스 불안정 | 차단 |
| **MED** | 성능 저하(N+1), 관찰가능성 누락, 타입 안전성 위반, 에러 구조 불일치 | 권고 (팀 합의 시 통과) |
| **LOW** | 가독성, 매직 넘버, 주석, 함수 길이 | 비차단 |

## 2. 체크리스트

### 2.1 보안 (HIGH 기준)

```
[ ] SQL/NoSQL injection — 문자열 concat 쿼리 없음
[ ] 인가 검증 — 모든 리소스 접근에 소유권 확인 (OWASP API1)
[ ] 하드코딩 시크릿 없음 — API key, password, token
[ ] 입력 검증 — 모든 external input에 Zod/joi 검증
[ ] 응답에 민감 필드 노출 없음 — password, hash, internal ID (OWASP API3)
[ ] CORS 설정 — `*` 미사용 (origin allowlist)
```

### 2.2 에러 모델 (HIGH/MED)

```
[ ] 빈 catch 블록 없음 — 최소 logger.error + re-throw
[ ] HTTP 200 + { success: false } 패턴 없음 — 4xx/5xx 적절히 사용
[ ] 에러 응답 구조 일관성 — { error: { code, message, requestId } }
[ ] 4xx와 5xx 경계 올바름 — 클라이언트 오류 vs 서버 오류 혼동 없음
[ ] unhandledRejection 핸들러 존재
```

### 2.3 Node.js 특화 (MED/HIGH)

```
[ ] async/await 일관성 — callback 혼용 없음
[ ] Event Loop 차단 없음 — 동기 I/O (readFileSync 등) 핸들러 내 미사용
[ ] optional 필드를 required로 취급하지 않음 (명세 일치)
[ ] TypeScript strict 통과 — any 타입 남용 없음
[ ] 런타임 검증 — 외부 데이터에 as T 단언 미사용
[ ] process.exit() 직접 호출 없음 (graceful shutdown 우회)
```

### 2.4 성능 (MED)

```
[ ] N+1 쿼리 없음 — 루프 내 DB 쿼리 패턴
[ ] 트랜잭션 내 외부 API 호출 없음
[ ] Promise.all — 독립 async 작업 병렬화
[ ] 인덱스 없는 WHERE 조건 없음 (신규 쿼리)
```

### 2.5 관찰가능성 (MED)

```
[ ] 구조화 로그 (JSON) — console.log 미사용
[ ] 에러 로그에 requestId 포함
[ ] 중요 비즈니스 이벤트 로그 존재 (주문 생성, 결제 완료 등)
[ ] 민감 정보 로그 미포함 (password, 카드번호, PII)
```

### 2.6 코드 품질 (LOW)

```
[ ] 함수 50줄 이하
[ ] 중첩 깊이 4 이하 (early return 활용)
[ ] 매직 넘버 상수화
[ ] 같은 파일 3+회 수정 시 전체 재설계 검토
```

## 3. 이슈 카탈로그 (즉시 참조)

| 패턴 | SEVERITY | 설명 |
|------|----------|------|
| `db.query("... WHERE id = " + id)` | HIGH | SQL injection |
| `catch (err) {}` | HIGH | 에러 묵살 |
| `res.status(200).json({ success: false })` | HIGH | 에러 응답 오용 |
| `const user = cache.get() as User` | MED | 런타임 검증 없는 단언 |
| `for (const x of list) { await db.findBy... }` | MED | N+1 쿼리 |
| `await externalApi()` inside transaction | MED | 트랜잭션 내 외부 호출 |
| `console.log(req.body)` | MED | 구조화 로그 미사용 + PII 노출 위험 |
| `if (req.params.userId !== req.user.id)` 누락 | HIGH | OWASP API1 (소유권 검증) |
| `res.json(await db.findUser(id))` (전체 모델) | MED | OWASP API3 (필드 노출) |
| `fs.readFileSync(...)` in handler | MED | Event loop 차단 |
| 함수 > 50줄 | LOW | 책임별 분리 |

## 4. 관련 문서

- 원칙: [`principles/common.md`](../../../principles/common.md), [`principles/node.md`](../../../principles/node.md)
- 보안 체크리스트: [`skills/node/be-security/SKILL.md`](../be-security/SKILL.md)
