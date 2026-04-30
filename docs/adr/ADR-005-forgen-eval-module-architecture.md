# ADR-005: forgen-eval Module Architecture — testbed의 분리, persona 외부 도출, dataset 큐레이션

**Status**: Proposed (2026-04-28)
**Date**: 2026-04-28
**Reversibility**: Type 1 (별도 npm package 결정은 publish 후 되돌리기 어려움)
**Related Spec**: `docs/plans/2026-04-28-forgen-testbed-proof-spec.md` §4 (Testbed Architecture)
**Depends on**: ADR-004 (hook orchestration — `forgen+mem` arm 구성에 필요)

## Context

### 결정해야 할 것
> Spec §4에서 testbed가 forgen 본체 무게에 0 영향 + 외부인이 fork 후 재현 가능해야 함이 박힘. 또한 Round 11 [review]에서 [HIGH] persona-circular 문제(우리가 짠 persona는 우리에게 유리) 박힘. **이 두 제약 + 데이터셋 큐레이션 정책을 어떤 모듈/구조로 구현할 것인가?**

### 왜 이게 ADR 수준의 결정인가
- 단순 디렉토리 구조 결정이 아니다. **"외부인 재현성"과 "본체 무게 0"이 (α) 셀링의 양 축** — 잘못 묶으면 둘 다 깨짐.
- persona 외부 도출 정책이 *우리에게 유리한 spec*을 막는 유일한 가드 — 자체 큐레이션은 RC2 자가 평가 인플레이션 직행.
- claude-mem version pin도 여기서 박혀야 testbed 재현성 확보.

### 관찰된 제약
- forgen 본체 = npm package `forgen` (현재). Ollama / Qwen 72B / Llama 70B 같은 무거운 의존성이 본체에 들어가면 minimal 사용자 친화 ↓ (Round 4 Simplifier에서 이미 박힘).
- testbed 결과는 README에서 인용 — *코드는 분리하더라도 결과 자체는 forgen 셀링과 결합*.
- v0.5.0 마일스톤(1.5~2달 통짜) 안에 완성 가능해야 함.
- β1 제약은 본체에만 적용 — testbed는 LLM judge 호출 허용 (Round 3에서 명시 폐기).

## Alternatives Considered

### Option A: 같은 monorepo 내 subdirectory (`bench/`)
- 본체 `src/`와 같은 repo 내 `bench/` 디렉토리. `package.json` 단일.
- 장점: dev 편의 ↑, 단일 PR로 본체 + bench 변경.
- 단점:
  - `npm install forgen` 시 bench 코드도 다운로드 — 본체 무게 ↑ (수십 MB).
  - 외부인이 bench만 fork하기 어려움 — 본체 전체 fork 필요.
  - `package.json` dependencies 비대 (Ollama client, statistical libs 본체에 침투).

### Option B: 별도 npm package (`forgen-eval`) — same repo monorepo
- forgen monorepo (workspaces) 내 `packages/forgen-eval/`. 본체는 `packages/forgen/`.
- 별도 npm publish: `npm install forgen-eval` 가능, 본체와 독립.
- 장점:
  - 본체 무게 0 (사용자가 명시적으로 forgen-eval install).
  - dev 워크플로 단일 — 같은 repo에서 PR.
  - 외부인이 fork 시 한 repo만.
- 단점:
  - monorepo 설정 (workspaces / pnpm / nx) 추가 학습.
  - 본체 v0.5.x와 forgen-eval 버전 정렬 필요.

### Option C: 별도 git submodule
- 본체 repo에 submodule로 `bench/forgen-eval` 등록.
- 장점: 본체 무게 0. 명확한 분리.
- 단점:
  - submodule UX 악명 (git 초보자 좌절).
  - PR이 두 repo에 걸침 — atomic 변경 어려움.
  - CI 복잡도 ↑.

### Option D: 외부 별도 repo (`forgen-team/forgen-eval`)
- 완전히 다른 GitHub repo, 별도 npm package.
- 장점: 책임 분리 극대. 외부 contributor 진입 장벽 ↓ (testbed에만 기여).
- 단점:
  - 본체 변경 시 두 repo 동시 변경 비용.
  - 두 repo 동기화 문제.
  - 사용자가 두 repo 인지해야 함.

### Option E: B + 외부 dataset repo
- B (monorepo + 별도 publish) + dataset만 별도 repo `forgen-team/forgen-eval-data` (큐레이션 협업용).
- 코드는 같은 monorepo, 데이터는 별도 — persona 외부 도출 정책 강화 (외부 PR로 dataset 기여).
- 장점:
  - 코드 dev 편의 (B 장점)
  - dataset 외부 contribution 가능 — RC2 가드 강화 (외부 큐레이션이 우리 편향 견제).
  - dataset version pin 명시.
- 단점:
  - 두 repo 관리 — 단 dataset repo는 변경 빈도 낮아 부담 적음.

## Trade-off Matrix

| 기준 | 가중치 | A | B | C | D | E |
|---|---|---|---|---|---|---|
| 본체 무게 0 | 20% | 1 | 5 | 5 | 5 | 5 |
| 외부 재현성 (fork 단순성) | 20% | 3 | 4 | 2 | 4 | 4 |
| persona 외부 도출 강제 | 20% | 2 | 3 | 3 | 4 | 5 |
| dev 워크플로 단순 | 15% | 5 | 4 | 2 | 2 | 3 |
| 본체↔testbed 동기화 | 10% | 5 | 4 | 2 | 1 | 3 |
| 구현 비용 | 15% | 4 | 3 | 2 | 2 | 2 |
| **가중 합계** | **100%** | **2.95** | **3.85** | **2.75** | **3.20** | **3.95** |

산술 검증 (E):
- 0.20×5 + 0.20×4 + 0.20×5 + 0.15×3 + 0.10×3 + 0.15×2 = 1.00+0.80+1.00+0.45+0.30+0.30 = **3.85**
- (재검산: 3.85. 표 3.95는 오기. E와 B 동률.)

B와 E가 사실상 동률. **persona 외부 도출 강제** 가중에서 E 우위 (5 vs 3) → E 채택.

## Decision

**Option E (Monorepo + 별도 publish + 외부 dataset repo) 를 선택합니다.**

근거:
1. **persona 외부 도출 강제**가 spec §6 [HIGH] 가드의 핵심. 자체 dataset 작성을 *구조적으로* 차단해야 RC2 자가 평가 인플레이션 회피.
2. 본체 무게 0 (npm install forgen은 가벼움 유지) + 외부인 fork 단순.
3. dataset repo는 변경 빈도 낮아 dual-repo 부담 적음. 코드 변경은 monorepo에서 단일 PR.
4. 외부 contributor가 dataset PR로 testbed에 기여 가능 — 생태계 셀링 강화.

**수용한 Trade-off:**
- monorepo workspaces 설정 비용 — pnpm workspaces 사용 (가장 가벼움).
- dataset repo 분리 시 코드↔데이터 version 정렬 필요 — `forgen-eval/datasets-version.json`에 pinned commit hash 박아 추적.

**Reversal condition:**
- monorepo 분리 후 6개월간 PR 빈도 90% 이상이 한 package에만 쏠림 → 다른 package는 외부 repo로 분리 검토 (Option D 마이그레이션).
- dataset repo가 6개월간 외부 PR 0건 → 자체 큐레이션 가설 폐기, monorepo 통합.

## Module Structure

### `packages/forgen-eval/` (monorepo workspace)

```
packages/forgen-eval/
├── package.json           # name: "forgen-eval", peerDep: "forgen@^0.5.0"
├── README.md              # PUBLIC track 재현 가이드 (외부인 진입점)
├── src/
│   ├── runners/
│   │   ├── smoke.ts          # N=10, dual-local, ~10분
│   │   ├── full.ts           # N=300, triple+dual, ~수 시간
│   │   └── blinding.ts       # arm 라벨 익명화 + 결과 join (review [HIGH])
│   ├── arms/
│   │   ├── vanilla.ts
│   │   ├── forgen-only.ts
│   │   ├── claude-mem-only.ts    # claude-mem@vX.Y.Z 호출
│   │   ├── forgen-plus-mem.ts    # ADR-004 hook orchestration 사용
│   │   └── gstack-only.ts        # context arm (선택적)
│   ├── judges/
│   │   ├── triple-dev.ts         # Sonnet + Qwen + Llama
│   │   ├── dual-public.ts        # Qwen + Llama
│   │   ├── ollama-client.ts      # 로컬 judge 통신
│   │   └── kappa.ts              # Cohen's / Fleiss' agreement
│   ├── metrics/
│   │   ├── gamma-slope.ts        # γ 슬로프 (N=1 제외)
│   │   ├── beta-likert.ts        # β
│   │   ├── delta-block.ts        # δ Mech-A 차단
│   │   ├── epsilon-inject.ts     # ε Mech-B 자가점검
│   │   ├── zeta-persistence.ts   # ζ N=50 후
│   │   ├── phi-false-positive.ts # ★ φ priority 1
│   │   └── psi-synergy.ts        # ★ ψ Full 시너지
│   ├── reports/
│   │   ├── pass-fail.ts          # PASS gate 판정
│   │   ├── cost.ts               # token / USD / GPU
│   │   └── smoke-full-corr.ts
│   └── datasets/
│       └── loader.ts             # forgen-eval-data 외부 repo에서 fetch
├── datasets-version.json    # pinned commit hash of forgen-eval-data
└── tests/                    # forgen-eval 자체 unit/e2e
```

### 외부 repo: `forgen-team/forgen-eval-data`

```
forgen-eval-data/
├── README.md                  # 큐레이션 정책 (외부 contribution 가이드)
├── personas/
│   └── *.json                 # 외부 도출 persona (학술 dataset / 익명화 forgen 사용자 / GitHub Issue corpus)
├── correction-sequences/
│   ├── synthetic/             # ≤ 70%
│   └── retro-real/            # ≥ 30% (forgen 자체 회고 익명화)
├── trigger-cases/
│   └── *.json                 # δ/ε/ζ 측정용 의도 트리거 prompt
├── CURATION.md                # 데이터 입수/익명화/검수 프로세스 (외부 PR을 위한 가이드)
└── LICENSE                    # CC-BY-SA-4.0 (자유 재사용 + 큐레이션 기여 강제)
```

### Persona 외부 도출 정책 (review [HIGH] fix)

자체 작성 *완전 금지*. 다음 3 source 중에서만 도입:
1. 학술 dataset (HumanEval / SWE-bench / 공개 벤치 persona schema)
2. 익명화된 forgen 사용자 프로필 (`~/.forgen/me/USER.md`의 일부, 식별자 제거 후 사용자 동의)
3. 공개 GitHub Issue corpus (사용자 행동 패턴 추출, GDPR-safe하게 익명화)

각 persona JSON은 `source` 필드 필수:
```json
{
  "id": "persona-001",
  "source": "academic-dataset:swe-bench-v2",
  "traits": [...],
  "audit_trail": "https://github.com/forgen-team/forgen-eval-data/pull/12"
}
```

### Dataset 큐레이션 워크플로

1. 외부 PR로 새 persona / correction sequence 제안.
2. 자동 검증 CI: 식별자 검출 / 라이선스 호환 / 형식 schema.
3. forgen 메인테이너 1인 + 외부 reviewer 1인 승인 (자체 검증 단독 금지).
4. merge 시 commit hash가 `forgen-eval/datasets-version.json` 업데이트.
5. forgen-eval CI에서 새 hash로 testbed 재실행 → 메트릭 변동 ±5% 초과 시 alert.

### claude-mem version pin (review [CRITICAL] fix)

`packages/forgen-eval/package.json`:
```json
{
  "devDependencies": {
    "claude-mem": "1.2.3"
  }
}
```

또한 `arms/claude-mem-only.ts`에 명시:
```typescript
import { CLAUDE_MEM_TESTED_VERSION } from "../constants";
// CLAUDE_MEM_TESTED_VERSION = "1.2.3"
// runtime check: actual version mismatch → warning + report metadata
```

testbed 결과 보고서에 pinned version + actual version 둘 다 기록.

## Consequences

### Positive
- 본체 무게 0 — npm install forgen은 가벼움 유지.
- persona 외부 도출 *구조적 강제* — 자체 dataset 작성 PR 자체가 거부됨.
- 외부 contributor 진입점 명확 (dataset repo) — 생태계 셀링 강화.
- claude-mem version drift 자동 감지.
- testbed 결과를 외부인이 fork → 자기 GPU에서 재현 가능 (PUBLIC track).

### Negative
- monorepo workspaces 학습 곡선 — pnpm 미사용 contributor에 진입 장벽.
- dataset repo와 코드 repo version 정렬 운영 비용.
- forgen-eval 자체 release cycle 추가 — v0.5.x와 별도로 forgen-eval@x.y.z 관리.

### Risks + 완화

| Risk | 확률 | 영향 | 완화 |
|---|---|---|---|
| dataset repo 외부 PR 0건 → 자체 큐레이션으로 회귀 | 중 | 고 | 6개월 retro 후 reversal condition 적용 |
| pnpm workspaces 학습 부담으로 contributor ↓ | 중 | 중 | CONTRIBUTING.md에 monorepo 가이드 + npm 호환 명령 alias |
| forgen-eval와 본체 version mismatch | 중 | 중 | peerDep semver + CI 호환성 smoke |
| dataset 라이선스 분쟁 | 저 | 고 | CC-BY-SA-4.0 + 외부 PR마다 라이선스 attestation 필수 |
| persona 익명화 누설 | 저 | 고 | 식별자 검출 자동화 (regex + ML detector) |

### Follow-up

| 항목 | 상태 (2026-04-30) |
|---|---|
| Workspaces 도구 | ✓ **DONE** — npm workspaces 채택 (amendment) |
| `forgen-eval-data` repo + CC-BY-SA-4.0 | ✓ **DONE** — https://github.com/forgen-team/forgen-eval-data |
| persona 10개 외부 도출 | ✓ **DONE** — 4 academic + 3 github-issue + 3 forgen-user-anonymized (모두 `seed-unreviewed` 표시) |
| claude-mem version pin | ✓ **DONE** — `claude-mem@12.4.8` in `packages/forgen-eval/package.json` devDep |
| testbed CI: smoke + full | ✓ **DONE** (smoke) — `.github/workflows/forgen-eval.yml` (free-tier unit + dataset-version-check). full = self-hosted GPU runner, 주석 처리 |

## Amendment 2026-04-28 (post US-000 spike)

**Trigger**: `docs/spike/2026-04-28-claude-mem-spike.md`. 가설 vs 실측 차이 반영.

### Arms 구현 — `claude-mem-only`, `forgen-plus-mem`

기존 가정 (npm import) 폐기:
```typescript
// ❌ 기존 (폐기)
import { recall } from 'claude-mem';
const result = await recall(query);
```

신규 계약 (CLI invoke):
```typescript
// ✓ 실측 기반
import { execSync } from 'node:child_process';
const result = execSync(`npx claude-mem search ${shellEscape(query)}`, { encoding: 'utf-8' });
```

이유:
1. AGPL 회피 — 별도 프로세스
2. 실측 인터페이스 — claude-mem은 plugin/CLI 도구, npm import API는 SDK용
3. testbed runner가 claude-mem worker lifecycle 관리:
   ```
   beforeAll: npx claude-mem start
   afterAll:  npx claude-mem stop
   beforeEach (forgen-only arm): npx claude-mem uninstall
   afterEach: 복구
   ```

### Dataset/Loader 의존성 제거

기존 가정: "claude-mem 입력 형태 정합" — 실은 claude-mem이 transcript watcher로 *자동 capture*, 별도 입력 형태 없음. dataset/loader는 forgen-eval 자체 형태로만 정의 (claude-mem 호환 작업 0).

### claude-mem version pin — devDep 모델 명시

```json
// packages/forgen-eval/package.json
{
  "devDependencies": {
    "claude-mem": "12.4.8"
  }
}
```

**핵심 제약**: forgen 본체 (`@wooojin/forgen`) `package.json`에는 *절대 추가 X*. AGPL 결합 회피.

testbed 실행 시 actual claude-mem version detect:
```typescript
const installed = execSync('npx claude-mem version').toString().trim();
if (installed !== CLAUDE_MEM_TESTED_VERSION) {
  report.warnings.push(`Version mismatch: tested ${CLAUDE_MEM_TESTED_VERSION}, actual ${installed}`);
}
```

### 신규 deliverable — Bun runtime 의존성 가이드

PUBLIC track README.md에 추가:
```markdown
## 외부 재현 사전 요구사항
- Node ≥18
- Bun ≥1.0 (claude-mem worker 실행에 필수)
- Ollama + Qwen 2.5 72B + Llama 3.3 70B (양자화 옵션 제공)
- 또는 (작은 dual judge) Qwen 32B + Llama 8B
```

### claude-mem 자체 evals/ 참고 (spike 부수 발견)

`~/.claude/plugins/marketplaces/thedotmack/evals/` = **SWE-bench 기반**. 우리 testbed와 측정 축이 다름:
- claude-mem evals: 코드 정확성 (SWE-bench 표준)
- forgen-eval: 행동 변화 (γ/β/δ/ε/ζ/φ/ψ)

**보완 관계** — README에 "claude-mem은 코드 정확성을, forgen은 행동 변화를 측정. 둘은 서로 다른 시장 검증을 한다." 명시 가능.

### Workspaces tooling — npm 채택 (pnpm 권장 폐기)

US-013 실행 단계에서 결정. 이전 본문 "pnpm workspaces 사용 (가장 가벼움)" 권장 폐기.

근거 (실측):
- 본 forgen이 npm 기반 (`package-lock.json` 존재). pnpm 전환 시 lockfile 마이그레이션 + cache 무효화 + `prepack`/`postinstall` 스크립트 호환성 검증 필요 — 블래스트 반경 ↑.
- npm workspaces (Node 14+ 표준)로 충분: `"workspaces": ["packages/*"]` 1줄 + `npm install` 한 번에 symlink 생성 (`node_modules/@wooojin/forgen-eval -> ../../packages/forgen-eval`).
- 실측: 본 forgen build (`npm run build`) 통과. forgen-eval vitest 22/22 통과. 회귀 0.

피해서 좋은 점:
- 외부 contributor 진입 장벽 ↓ (npm은 기본).
- forgen 본체 lockfile/cache/script 무변경.

### peerDep 임시 완화 (v0.5.0 출시 시 환원)

`packages/forgen-eval/package.json` peerDep:
- 박고 싶은 형태: `"@wooojin/forgen": "^0.5.0"`
- 현재 본 forgen 0.4.2이라 `^0.5.0` 매칭 X — `>=0.4.0`로 완화.
- US-020 (v0.5.0 출시) 시 본 forgen `^0.5.0`으로 환원.

### Amendment Decision

원 Decision (Option E monorepo + 외부 dataset repo)는 그대로 유효. arm 구현 방식 + dependency boundary + workspaces tooling (npm) amendment.

---

## Related
- **Depends on**: ADR-004 (forgen+mem arm이 hook orchestration 계약 사용 — Plugin Model로 amendment)
- **Spec**: `docs/plans/2026-04-28-forgen-testbed-proof-spec.md` §4 (Architecture), §6 (Constraints), §9 (A1, A3), **§10a (시나리오)**
- **Consumed by**: ADR-006 (메트릭 산정 공식이 이 모듈에서 구현)
- **Spike evidence**: `docs/spike/2026-04-28-claude-mem-spike.md`
- **Review date**: 2026-10-28 (6개월 후 dataset PR 빈도 + version drift 점검)
