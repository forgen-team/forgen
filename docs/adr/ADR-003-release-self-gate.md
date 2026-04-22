# ADR-003: 릴리즈 Self-Gate — forgen이 자기 자신의 L1 규칙을 위반하지 않음을 CI에서 자동 검증

**Status**: Accepted (2026-04-22)
**Date**: 2026-04-22
**Reversibility**: Type 2 (CI 단계는 비교적 가역 — 스크립트 교체만으로 되돌릴 수 있음)
**Related Interview**: Deep Interview v0.4.0 Trust Restoration (Round 10 — "신뢰도 회복 미션")
**Depends on**: ADR-001 (enforce_via), ADR-002 (lifecycle state 소비)
**Implementation evidence**: `scripts/self-gate.cjs` (static) + `scripts/self-gate-runtime.cjs` (6 hook scenarios) + `scripts/self-gate-release.cjs` (tag-only) + `.github/workflows/self-gate.yml`. 로컬 3단 체인 그린.

## Context

### 결정해야 할 것
> "됐다는데 안됨" 자기모순을 0으로 만들려면 forgen 자신이 자신의 L1 규칙(`Docker e2e 없이 완료선언 금지`, `mock 검증 완료선언 금지`, `.env/credentials 커밋 금지`, `rm -rf 무확인 금지`)을 릴리즈 전에 위반하지 않았음을 자동 증명해야 한다.

### 왜 이게 ADR 수준의 결정인가
- 이건 단순 CI 체크가 아니다. **forgen의 핵심 약속(=미션)을 forgen 자신에게 강제 적용**하는 것이므로 철학적 결정이자 구현 결정.
- 실패 시 릴리즈는 차단된다 — 즉 forgen의 자기 일관성이 깨지면 v0.4.x 릴리즈 자체가 불가능하다는 정책 수립.

### 관찰된 제약
- GitHub Actions 기반 CI 이미 있음(`.github/workflows/` 디렉토리 확인 필요).
- Docker e2e 51 체크가 이미 존재 (session-2026-04-13-improvements.md 참조).
- `scripts/prepack-hooks.cjs` 및 `scripts/postinstall.js` 이미 존재.
- β1 제약: CI 에서 외부 LLM 호출 금지. 모든 판정은 정규식/파일 존재/메타데이터로.

## Alternatives Considered

### Option A: 최소형 — 정적 스캔 스크립트
- `scripts/self-gate.cjs` 신규: 커밋/PR 대상 diff + 배포 후보 빌드 산출물을 정적 스캔.
  - 규칙 1: `package.json` version 변경(릴리즈 커밋)인데 `dist/` 내 e2e 결과 아티팩트(`.forgen-release/e2e-report.json`) 부재 → FAIL.
  - 규칙 2: 릴리즈 PR 본문에 "완료/ready/ship" 선언 + `e2e passed: true` 라인 부재 → FAIL.
  - 규칙 3: production 코드(`src/**/*.ts` 단 `src/**/*.test.ts` 제외)에 `vi.mock\|jest.mock\|sinon.stub` 리터럴 포함 → FAIL.
  - 규칙 4: PR diff 에 `.env` 또는 `credentials` 파일 추가 → FAIL.
- GitHub Actions 워크플로 `self-gate.yml` — push to main + release tag 시 실행.
- 장점: 가볍고, 명시적이고, β1 준수.
- 단점: "정적 패턴"만 검출 — 실제 런타임 hook 동작 여부는 확인 못 함.

### Option B: 이상형 — 본격 Dogfood
- CI 컨테이너에 forgen 자체를 설치 + 실제 hook system 활성화.
- CI 내에서 Claude Code 대신 시뮬레이션 시나리오를 돌려 hook 작동 검증:
  - 시나리오 S1: "완료 선언" 문자열이 담긴 가짜 tool response → Stop hook이 `decision: "block"` 반환해야 FAIL-if-passed.
  - 시나리오 S2: 실제 Docker e2e 통과 후 완료 선언 → PASS 기대.
- 장점: runtime 거동까지 증명 — 진정한 자기 약속 준수.
- 단점:
  - Circular dependency: forgen 개발 중 버전(WIP)으로 자신을 검증 → 버그 있으면 false pass 위험.
  - CI 시간 대폭 증가 (+3~5분).
  - Claude Code CLI가 CI에서 구동 가능한지 명확치 않음 (인증 필요).

### Option C: 하이브리드 — Option A + 런타임 smoke test
- Option A의 정적 스캔 + 경량 smoke test: `scripts/self-gate-runtime.cjs` 가 hook 파일들을 직접 import 해서 fake input 으로 단위 호출. Claude Code CLI 구동 없이.
  - S1-smoke: `stop-guard.ts` 에 "완료" 문자열 stdin → stdout에 `decision: "block"` 포함되는가
  - S2-smoke: `pre-tool-use.ts` 에 `rm -rf /` 시나리오 → deny 되는가
- 장점: 런타임 부분 검증 + CI 비용 낮음 + Claude Code 의존성 없음.
- 단점: 시뮬레이션이지 실제 Claude 통합은 아님 → A1 검증은 별도 필요(ADR-001 spike에서 이미 처리).

### Option D: 현상 유지
- 수동 릴리즈 체크리스트 + 사람 리뷰.
- 인터뷰 미션("자기모순 0")과 정면 충돌.

## Trade-off Matrix

| 기준 | 가중치 | Option A | Option B | Option C | Option D |
|------|--------|----------|----------|----------|----------|
| 미션 적합성(자기모순 0 증명력) | 25% | ★★★ (3) | ★★★★★ (5) | ★★★★ (4) | ★ (1) |
| 구현 비용 | 15% | ★★★★ (4) | ★ (1) | ★★★ (3) | ★★★★★ (5) |
| CI 시간·리소스 | 15% | ★★★★★ (5) | ★★ (2) | ★★★★ (4) | ★★★★★ (5) |
| Circular dependency 리스크 | 15% | ★★★★★ (5) | ★★ (2) | ★★★★ (4) | ★★★★★ (5) |
| 유지보수성 | 15% | ★★★★ (4) | ★★ (2) | ★★★ (3) | ★★★★★ (5) |
| β1($0) 준수 | 15% | ★★★★★ (5) | ★★★ (3) | ★★★★★ (5) | ★★★★★ (5) |
| **가중 합계** | **100%** | **4.20** | **2.75** | **3.85** | **4.00** |

산술 검증:
- A: 0.25×3 + 0.15×4 + 0.15×5 + 0.15×5 + 0.15×4 + 0.15×5 = 0.75+0.60+0.75+0.75+0.60+0.75 = **4.20**
- B: 0.25×5 + 0.15×1 + 0.15×2 + 0.15×2 + 0.15×2 + 0.15×3 = 1.25+0.15+0.30+0.30+0.30+0.45 = **2.75**
- C: 0.25×4 + 0.15×3 + 0.15×4 + 0.15×4 + 0.15×3 + 0.15×5 = 1.00+0.45+0.60+0.60+0.45+0.75 = **3.85**
- D: 0.25×1 + 0.15×5 + 0.15×5 + 0.15×5 + 0.15×5 + 0.15×5 = 0.25+0.75+0.75+0.75+0.75+0.75 = **4.00**

최종 점수: **A=4.20**, B=2.75, C=3.85, D=4.00. 점수상 A가 1위이나 미션 적합성(가중 25%)에서 C가 우위 — Decision §근거 참조.

## Decision

**Option C (하이브리드) 를 선택합니다.**

근거:
1. 점수 차이(A=4.20 vs C=3.85)는 미미하지만, **미션 적합성 기준**(가중 25%)에서 C가 A를 압도(4 vs 3). 정적 스캔만으로는 "forgen hook이 실제로 동작한다"를 입증 못 함 — 이것이 trust-restoration 미션의 핵심 증명 대상.
2. Option A의 점수 우위는 "구현 비용"과 "CI 리소스"에서 온 것 — 이는 사용자 입장("완성도 우선, 시간은 부차")과 반대 방향. 가중치 재검토 시 C가 실질 1위.
3. Option B는 circular dependency(WIP forgen으로 WIP forgen 검증)로 false pass 위험 치명적. 거부.
4. Option D는 미션 정면 충돌. 거부.

**수용한 Trade-off:**
- 실제 Claude 통합 검증은 CI에 포함되지 않음 → ADR-001 A1 spike 에서 1회성 수동 검증으로 커버.
- smoke test가 simulated input을 사용 → 실제 Claude 거동과의 갭 존재. 완화: 분기별 1회 수동 Claude Code 통합 테스트 체크리스트 유지.

**Reversal condition:**
- C의 smoke test가 3회 연속 flaky failure → Option A 로 다운그레이드하고 수동 체크리스트 강화.
- 반대로 Claude Code CI 인증 경로가 열리면 → Option B 로 승급 재검토.

## CI 파이프라인 설계

### `.github/workflows/self-gate.yml` (신규)

```yaml
# 실제 ".github/workflows/self-gate.yml" 구현. 아래는 설계 스케치가 아닌 live 워크플로우.
name: forgen-self-gate
on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]

jobs:
  self-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # tag describe 필요
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build
      - name: Static self-gate (mock-in-prod / secrets / enforce_via / release)
        run: node scripts/self-gate.cjs
      - name: Runtime smoke self-gate (hook consistency)
        run: node scripts/self-gate-runtime.cjs
      - name: Release artifact consistency (tag only)
        if: startsWith(github.ref, 'refs/tags/v')
        run: node scripts/self-gate-release.cjs
```

### `scripts/self-gate.cjs` (정적 스캔)

핵심 검사 항목:
1. **Mock in production 검사**
   - `rg -l "vi\.mock|jest\.mock|sinon\." src/ --glob '!**/*.test.ts' --glob '!**/*.spec.ts'`
   - 매칭 결과 비어있지 않으면 FAIL.
2. **완료 선언 vs 증거 일관성** (릴리즈 커밋만)
   - `git log -1 --pretty=%B` 이 `chore(release)|version` 포함 + `.forgen-release/e2e-report.json` 부재 → FAIL.
3. **Secrets leak 검사**
   - `rg "(AIza|sk-|AKIA|ghp_|xoxp-)" --glob '!.env.example' --glob '!docs/**'`
   - 매칭 시 FAIL.
4. **enforce_via 누락 검사** (v0.4.0 이후 신규)
   - `me/rules/*.json` 중 `strength in [strong, hard]` 인데 `enforce_via` 필드 부재 → FAIL. (L-full 정책 = 하드 규칙에 메커니즘 강제)

### `scripts/self-gate-runtime.cjs` (런타임 smoke)

`dist/hooks/*.js` 를 직접 import 하여 fake stdin JSON 으로 호출:

```javascript
// 의사 코드
const scenarios = [
  {
    hook: 'stop-guard',
    stdin: { response: '완료했습니다. 테스트 통과.', session_id: 'test' },
    precondition: { file: '.forgen/state/e2e-result.json', exists: false },
    expect: { contains: '"decision":"block"' },
    expect_fail_message: 'Stop hook must block completion claim without e2e evidence',
  },
  {
    hook: 'pre-tool-use',
    stdin: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
    expect: { contains: '"result":"deny"' },
  },
  // ... 총 8~10 시나리오 (L1 규칙 각각 매칭)
];

scenarios.forEach(sc => runSmoke(sc));
process.exit(failures.length > 0 ? 1 : 0);
```

### `scripts/self-gate-release.cjs` (릴리즈 아티팩트 일관성)

- `package.json`의 `version` == git tag 일치
- `CHANGELOG.md` 에 해당 버전 섹션 존재
- `dist/` 가 최신 `src/` 대비 stale 아닌지(mtime 비교)
- `.forgen-release/e2e-report.json`의 `passed: true` AND `mock_detected: false`

## Dogfood Signal (추가)

CI와 별개로 **개발 워크플로 내 자기 주입**을 단계적으로 도입:
- Phase 1 (v0.4.0 출시 직후): forgen 저장소 자체에 `.forgen/` 설정 커밋하여 개발자가 Claude Code 쓸 때 forgen의 L1 규칙이 실제 hook으로 동작. 사용자(본인)가 자기 규칙에 막히는 경험 = 미션 달성 일차 증거.
- Phase 2 (v0.4.1): CI에 Claude Code CLI headless 통합 실험 (Option B 로의 점진적 이행 탐색).

## Consequences

### Positive
- 릴리즈마다 "자기 규칙 준수" 자동 증명. 인터뷰에서 정의한 "자기모순 0"의 운영 가능한 기준.
- Option A의 정적 검사 + Option C의 smoke 결합으로 회귀 방어 확보.
- CI 로그가 `docs/adr/ADR-003` 을 참조 가능한 공개 증거물로 남음.

### Negative
- 초기에는 smoke test flaky 가능성 (fake stdin 형식 변경 등) → hook API 변경 시 self-gate 도 함께 업데이트 필요.
- PR 차단으로 인한 개발 흐름 지연 가능성 → `/bypass-self-gate` 라벨을 강력 제한적으로 허용(유지보수자만, reason 필수).

### Risks + 완화
| Risk | 확률 | 영향 | 완화 |
|------|------|------|------|
| smoke test 의 fake input 이 실제 Claude Code 와 달라 false pass | 중 | 중 | 분기별 수동 end-to-end 체크리스트 병행. hook API 변경 시 self-gate 함께 수정하는 CODEOWNERS 지정. |
| self-gate 자체 bug 로 정당한 릴리즈 차단 | 저 | 중 | 릴리즈 PR에 `self-gate-override` 라벨(메인테이너 2인 승인 필수) 예비. 남용 방지를 위해 감사 로그. |
| CI 비용 증가 | 저 | 저 | smoke는 수 초 수준. Docker e2e 기존 51 체크가 주요 비용 원천 — 이미 존재. |

### Follow-up
- CODEOWNERS 파일에 `scripts/self-gate*.cjs` 명시.
- v0.4.0 릴리즈 체크리스트에 "self-gate 통과 증빙" 항목 추가.

## Related
- **Depends on**: ADR-001 (enforce_via — 정적 스캔이 이 필드를 요구), ADR-002 (lifecycle state — 향후 phase 2 에서 소비)
- **Interview**: Deep Interview v0.4.0 Trust Restoration (Round 10)
- **Parallel to**: ADR-001 Spike Plan (A1 검증은 self-gate 범위 밖 — 1회성)
- **Review date**: 2026-05-22 (v0.4.0 첫 베타 4주 후, flaky 빈도 판정)
