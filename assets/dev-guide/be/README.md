# be-guide — 사내 백엔드 스킬 (Claude + Codex)

> AI 코딩 에이전트가 사내 합의된 BE 원칙대로 *구현 / 리뷰 / 성능 진단 / 보안 감사* 하게 만드는 스킬 번들.
> 단일 소스 (이 폴더), 양쪽 어댑터 (Claude SKILL.md / Codex AGENTS.md).

## 1. 무엇이 들어있는가

```
be-guide/
├─ sources/          # 원본 코퍼스 (수집일 예정 — 2026-05-18 스캐폴드)
│  ├─ 12factor/        12-Factor App (12개 Factor)
│  ├─ sre-book/        Google SRE Book (SLO, RED Method, Monitoring)
│  ├─ owasp-api/       OWASP API Security Top 10 (2023)
│  ├─ otel/            OpenTelemetry (Traces/Metrics/Logs)
│  ├─ ddia/            Designing Data-Intensive Applications
│  ├─ api-design/      Stripe + GitHub + Google AIP
│  ├─ postgres/        Use The Index Luke + PostgreSQL 공식
│  ├─ node-runtime/    Node.js docs + Fastify + NestJS + Pino
│  └─ go-runtime/      Effective Go + Go scheduler + pprof + golangci-lint
├─ principles/       # 합의 원칙 (코퍼스 위에서 사내 의사결정)
│  ├─ common.md        스택 중립 (API 설계 4원칙, Error Model, Observability, Security, DB)
│  ├─ node.md          Node.js/TypeScript 특화
│  └─ go.md            Go 특화
├─ skills/           # 실제 호출되는 스킬
│  ├─ node/{be-build,be-review,be-perf,be-security}/SKILL.md
│  └─ go/{be-build,be-review,be-perf,be-security}/SKILL.md
├─ adapters/
│  └─ build-agents-md.sh   SKILL.md → Codex AGENTS.md 변환
└─ README.md
```

4개 스킬 × 2개 스택 = **8개 스킬**:

| 스킬 | 호출 시점 | 무엇을 해주는가 |
|------|-----------|----------------|
| **be-build** | "이 API 명세대로 구현해줘" | 명세→API contract→체크리스트→테스트 매핑 강제, 에러 모델·관찰가능성·보안 기준선 적용 |
| **be-review** | "이 OpenAPI 스펙 리뷰해줘", "이 PR 리뷰해줘" | `[SEVERITY] file:line — 이슈` 형식 리뷰, 머지 차단/비차단 명시 |
| **be-perf** | "p99가 800ms야 잡아줘", "DB 쿼리 느려졌어" | p95/p99 진단 절차 (N+1, GC, Event Loop, lock, network) |
| **be-security** | "이 핸들러 OWASP 관점에서 검토해줘" | OWASP API Top 10 카테고리별 체크리스트 + 픽스 패턴 |

## 2. Claude Code 사용법

### 2.1 전역 설치 (모든 프로젝트에서 사용)

```bash
# 1. be-guide 를 원하는 위치에 clone (또는 이미 받아둔 경로)
export BE_GUIDE_ROOT=~/work/be-guide   # 본인 환경에 맞게

# 2. ~/.claude/skills 에 심볼릭 링크
cd ~/.claude/skills
ln -s "$BE_GUIDE_ROOT/skills/node/be-build"    be-build-node
ln -s "$BE_GUIDE_ROOT/skills/node/be-review"   be-review-node
ln -s "$BE_GUIDE_ROOT/skills/node/be-perf"     be-perf-node
ln -s "$BE_GUIDE_ROOT/skills/node/be-security" be-security-node
ln -s "$BE_GUIDE_ROOT/skills/go/be-build"      be-build-go
ln -s "$BE_GUIDE_ROOT/skills/go/be-review"     be-review-go
ln -s "$BE_GUIDE_ROOT/skills/go/be-perf"       be-perf-go
ln -s "$BE_GUIDE_ROOT/skills/go/be-security"   be-security-go
```

이후 Claude Code 에서:
```
/be-build-node  # 또는 자연어로 "be-build-node 스킬로 이 명세 구현해줘"
```

### 2.2 프로젝트별 설치 (저장소에 묶어 배포)

```bash
cd <your-repo>
mkdir -p .claude/skills
ln -s "$BE_GUIDE_ROOT/skills/node/be-build" .claude/skills/be-build
# 또는 git submodule / sparse-checkout 으로 be-guide 자체를 묶음
```

`.claude/skills/` 의 SKILL.md 는 Claude Code 가 자동 인식.

## 3. Codex CLI 사용법

Codex 는 프로젝트 루트의 `AGENTS.md` (또는 `~/.codex/AGENTS.md` 전역) 를 읽음.

### 3.1 AGENTS.md 생성

```bash
export BE_GUIDE_ROOT=~/work/be-guide
export BE_GUIDE_SOURCE="사내 공유 be-guide v2026-05-18 (배포: <본인 이름>)"  # AGENTS.md 출처 표기용 (선택)

cd <your-repo>
"$BE_GUIDE_ROOT/adapters/build-agents-md.sh" node be-build > AGENTS.md

# 또는 여러 스킬 합치기:
{
  "$BE_GUIDE_ROOT/adapters/build-agents-md.sh" node be-build
  echo
  "$BE_GUIDE_ROOT/adapters/build-agents-md.sh" node be-review
  echo
  "$BE_GUIDE_ROOT/adapters/build-agents-md.sh" node be-perf
  echo
  "$BE_GUIDE_ROOT/adapters/build-agents-md.sh" node be-security
} > AGENTS.md
```

생성된 `AGENTS.md` 는 Codex 가 매 세션 자동 로딩.

### 3.2 sources/principles 도 같이 배포

`AGENTS.md` 가 `principles/common.md`, `principles/node.md` 를 참조하므로:

- **Option A** — `be-guide/` 자체를 저장소에 git submodule 로 포함
- **Option B** — 빌드 시 `cp -R be-guide/{principles,sources} <repo>/.be-guide/`
- **Option C** — 사내 npm 패키지 또는 Go 모듈로 배포

권장: **A (submodule)** — 버전 명시적, AI가 직접 참조 가능.

## 4. 사용 시나리오 예시

### 4.1 be-build

```
사용자: 첨부한 OpenAPI 명세대로 주문 생성 API 구현해줘.
       /be-build-node

AI: ## 요구사항 체크리스트
    - [ ] R-01: "POST /v1/orders, userId와 items 필수"
    - [ ] R-02: "couponCode는 optional"
    ...
    체크리스트 확인 후 API contract → TDD 들어갑니다.
```

### 4.2 be-review

```
사용자: PR #456 리뷰해줘. 이 OpenAPI 스펙 기준으로.
       /be-review-go

AI: ## 리뷰 요약
    - 변경: 5 files +248 -32
    - HIGH 2, MED 3, LOW 1 / 머지 차단

    [HIGH] internal/handler/order.go:55 — API1: 소유권 검증 없음
    [HIGH] internal/repo/order.go:88 — SQL 문자열 concat, injection 위험
    [MED]  internal/service/order.go:120 — goroutine 종료 조건 없음
    ...
```

### 4.3 be-perf

```
사용자: 주문 목록 API p99가 800ms야. 잡아줘.
       /be-perf-node

AI: ## p99 진단
    - 분류: DB N+1
    - 측정 절차: Prisma 쿼리 이벤트 로깅으로 단일 요청 쿼리 수 확인
    - 가설: findMany 후 루프에서 user를 N번 조회
    - 검증 후 픽스: include: { user: { select: { id, name } } }
```

### 4.4 be-security

```
사용자: 이 결제 핸들러 OWASP 관점에서 검토해줘.
       /be-security-node

AI: ## 보안 감사 결과
    [HIGH] API1 src/payments/payment.handler.ts:42 — 소유권 검증 없음
    [HIGH] API6 src/auth/auth.handler.ts:15 — 로그인 rate limit 없음
    - API2: JWT RS256 + 만료 검증 ✅
    - API4: Rate limit 전역 설정 ✅
```

## 5. 유지보수

### 5.1 코퍼스 갱신

외부 문서 (OWASP, OTel, Go 공식 등) 가 갱신될 수 있으므로 **분기 1회 수동 갱신** 권장:

```
sources/<dir>/INDEX.md 의 출처들을 최신화해서 같은 형식으로 재저장해줘
```

### 5.2 principles 수정 시

`principles/*.md` 는 사내 합의 문서. 수정 시:
1. 출처 (sources/ 또는 외부 URL) 명시
2. 변경 이력 PR 로 남김
3. 영향받는 SKILL.md 의 참조 위치 확인

### 5.3 새 스킬 추가

`skills/<stack>/<name>/SKILL.md` 한 파일 추가 + `adapters/build-agents-md.sh` 그대로 사용.

## 6. 출처 우선순위 (충돌 시)

코퍼스 간 충돌 발생 시 `principles/common.md` 에 명시된 순서 적용:

1. **12-Factor App** (실행 환경·운영 기준)
2. **Google SRE Book** (가용성·SLO)
3. **OWASP API Security** (보안)
4. **OpenTelemetry** (관찰가능성)
5. **DDIA** (데이터 시스템)
6. **프레임워크 공식** (Fastify, NestJS, Go stdlib)
7. **벤더 권장** (AWS, Stripe 등)

사용자 영향 우선순위: **security > availability > correctness > performance > readability**.

## 7. 라이선스 / 출처 주의

- 12-Factor App: CC BY 4.0
- Google SRE Book: CC BY-NC-ND 4.0 (비상업적 사용)
- OWASP API Security: CC BY-SA 4.0
- OpenTelemetry: Apache-2.0
- DDIA: O'Reilly 저작권 (요약만 수록, 원문 미포함)
- Stripe API 문서: 공개 참조 가능, 재배포 금지
- GitHub REST API 문서: CC BY 4.0
- Google AIP: Apache-2.0
- Use The Index, Luke: CC BY-NC 4.0
- PostgreSQL 공식 문서: PostgreSQL License
- Node.js / Fastify / NestJS / Pino: MIT
- Go 공식 문서: BSD-3-Clause

사내 배포 시 각 코퍼스 원본 출처 보존 (`sources/<dir>/INDEX.md` 에 명시됨).

## 8. 관련 문서

- fe-guide: `../fe/README.md` — 자매 프로젝트 (프론트엔드 스킬 번들)
- be-build/be-review 의 "명세→API contract→체크리스트→테스트 매핑" 강제는 명세 위반으로 인한 운영 장애 패턴에서 도출 — 스키마 optional/required 불일치가 핵심.
