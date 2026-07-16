# ADR-010: 플랫폼 수렴 대응 — 경계 재정의·컨텍스트 다이어트·2-모델 재캘리브레이션 (v0.5.0)

**Status**: Accepted (2026-07-16)
**Date**: 2026-07-16
**Reversibility**: Type 2 (deprecation은 shim 경유로 가역. 단 §7 재캘리브레이션 전 효과 주장 유지가 더 비가역적 신뢰 손상 — 정직성 게이트가 우선)
**Related ADR**: ADR-009 (Opus 4.8 + dynamic workflows — §7 재캘리브레이션 PENDING을 본 ADR이 승계), ADR-002 (rule lifecycle), ADR-006 (pass-gate 방법론)
**Affected**: `src/core/doctor.ts`, `src/core/usage-telemetry.ts`, `src/core/config-injector.ts`, `src/core/harness.ts`, `src/engine/ranking-pipeline.ts`, `src/engine/solution-quarantine.ts`, `src/checks/_shared/meta-guard-dispatch.ts`, `packages/forgen-eval/`, `docs/positioning-and-selling.md`
**설계 출처**: Fable 5 설계 패스 (2026-07-15, 오케스트레이터 실측 검증 완료) + 사용자 3대 결정

## Context

### 플랫폼 변화 (ADR-009 이후 ~6주)

1. **Sonnet 5** (2026-06-30) — Pro/Team/Enterprise **기본 모델**. 네이티브 1M 컨텍스트, adaptive thinking 기본 ON. forgen 효과 통계(δ>0)는 sonnet-4.6/codex 기준 — 새 기본 모델은 미측정.
2. **Claude Code native `/doctor`** — unused skill/MCP/plugin의 컨텍스트 비용 진단, CLAUDE.md dedup, 유도 가능한 규칙 트리밍 제안, slow hook 감지. `src/core/doctor.ts`와 정면 중복.
3. **`/usage`** — skill/subagent/plugin/MCP별 plan limit 분해. `usage-telemetry.ts`와 중복.
4. **Auto mode** — classifier 기반 권한 처리. forgen trust-policy/autonomy 축의 "권한 중재자" 역할과 중복.
5. 업계 수렴: Anthropic 2026 Agentic Coding Trends Report가 persistent memory·skills-as-procedural-memory·correction 개인화를 메인 트렌드로 명시. forgen의 방향이 맞았고, 동시에 moat가 좁아지는 중.

### 실측으로 확정한 사실 (2026-07-15~16)

- **F1. enforcement moat는 프론티어 모델이 흡수했다.** `docs/release/v0.4.11-calibration-pending.md` 실측: opus-4.8에서 TEST-1/2/3 **blocks=0** (easy N=10 / hard N=6, false-completion 압박 케이스 포함). δ(+0.083/+0.035)는 **100% injection 기여**. forgen의 가치는 이미 enforcement → injection 품질·메모리·개인화로 이동했다.
- **F2. "Tenetx"는 forgen의 레거시 정체성이며 활성 좀비였다.** `~/.claude/plugins/tenetx`가 별도 플러그인으로 활성 상태로 남아 `~/.claude/rules/`에 5D-vector 기반 rule 파일(~8.4KB)을 재생성, forgen v1 렌더와 3중 중복 + 21개 중복 스킬 리스팅. → **2026-07-16 환경 청소로 제거 완료** (backup: `~/.forgen/backups/tenetx-removal-2026-07-15/`). 남은 것은 이 청소의 프로덕트화(§3).
- **F3. behavioral 캡처가 Claude-voice 에코로 오염돼 있었다.** `~/.forgen/me/behavior/` 68개 중 58개가 assistant 발화 에코("이해했습니다...", "⚠️ Prompt injection detected...", 상태 나레이션). `config-injector.ts`의 C5 필터가 못 거름 + observedCount=1에서 즉시 렌더. → 데이터는 청소 완료, 코드 픽스 필요(§3.4).
- **F4. retro-real.jsonl은 두 경로에 존재했다** *(2026-07-16 리뷰 정정)*: `datasets/opus48-hard/.../retro-real.jsonl`은 1바이트 빈 사본(백업 처리됨), 정본 후보 `forgen-eval-data/correction-sequences/retro-real.jsonl`엔 **3엔트리 존재** — 단 retro-001이 폐지된 docker-e2e 룰을 expectedRule로 인코딩해 수정 필요. 신규 authoring 소스는 충분: me/rules 14개(explicit_correction) + violations 129 + implicit-feedback 2,954줄.
- **F5. `forgen doctor --repair`의 plugin cache 자동복구가 실패한다** (수동 `node scripts/postinstall.js`는 성공). 캐시 dir 버전(0.4.12)과 패키지(0.4.13) 불일치도 존재.
- **F6. 글로벌 rules 라우팅 결함**: `harness.ts` `injectClaudeRuleFiles`가 `forge-*` 파일명을 무조건 글로벌 `~/.claude/rules/`로 라우팅 → 프로젝트 맥락의 behavioral 패턴이 전 프로젝트에 주입된다.

### 사용자 결정 (2026-07-15)

1. **수렴 대응 = 물러나기(경계 재정의).** native가 이긴 영역(doctor 일반 조언/usage/권한 중재)에서 철수, moat 재집중.
2. **재캘리브레이션 = Sonnet 5 + Opus 4.8 전면 재측정.** 단 고비용 canonical run은 **사이클 맨 마지막**.
3. **스코프 = 정리 + 신기능 both.**

## Decision

### §1. 살아남는 moat 4개에 재집중

(a) correction→4축 profile 학습, (b) 실행-증거 게이팅 *as policy* (no-mock·freshness — 모델 업데이트가 공급할 수 없는 규율), (c) 세션·프로젝트 횡단 compound recall + acted-on 텔레메트리, (d) multi-host parity. **철수 대상**: naive false-completion blocking(F1), rate-limit 가시성(/usage), 일반 셋업 조언(/doctor), 권한 중재(Auto mode), 모델 라우팅 테이블.

### §2. 경계 재정의 (native와 싸우지 않기)

- **2a. `doctor.ts` 축소**: Harness Maturity + Quick Wins 섹션 제거(~100줄, native /doctor 영역). hook timing 표시는 `--verbose`로 강등(수집은 유지 — 자체 회귀 테스트용). Effort 섹션은 opus-4.x + forge-loop 활성 시에만. 첫 줄에 명시: *"환경 건강은 native `/doctor`. 이 명령은 forgen 자체 기계와 효과-측정 게이트를 검사한다."* ψ-long 게이트·codex parity·plugin cache 진단은 **유지·헤드라인화**. *(수정 2026-07-16: Docker e2e freshness 게이트는 사용자 교정(evidence a723507f)으로 폐지 — vitest+smoke 실행 증거로 대체, 실행 계획 W0-2 참조.)*
- **2b. `usage-telemetry.ts` deprecate**: statusline/`forgen me` 표시 중단 + "native /usage로 이동" 1회 공지. `recordToolCall()`은 no-op shim (v0.6.0 삭제).
- **2c. static prose 주입 제거**: `generateSecurityRules()`/`generateAntiPatternRules()`(`config-injector.ts`)를 2줄 포인터로 축약 — 강제는 훅(secret-filter, db-guard)이 하고 있고 prose는 순수 토큰 비용.
- **2d. 권한 중재 철수** *(2026-07-16 리뷰 정정: probe-contingent)*: 렌더 규칙에서 `Trust: …` 정책 문장을 Auto mode 감지 시 생략 — 단 classifier 기반 Auto mode를 렌더 시점에 읽을 공식 신호가 **미확인(없을 개연성 높음)**이므로 v0.5.0에선 probe 아이템. probe 실패 시 폴백 = 현행 유지(항상 렌더). facet 유래 "When To Ask" 규칙(학습된 *선호*)은 무조건 유지. `trust-layer-intent.ts`는 무관, 유지.
- **비대상 (Fable 검증으로 브리핑 교정)**: `observability-store.ts`는 /usage와 **다른 질문**(forgen 자신의 효과)을 측정 — 유지·투자(§5 F2의 기반).

### §3. 컨텍스트 다이어트 프로덕트화

목표 상태(2026-07-16 수동 청소로 이미 도달): 글로벌 `~/.claude/rules/` = **0개**, 프로젝트에만 budgeted v1 render + project-context.

- **3a. `forgen migrate tenetx`** (+ `doctor --reclaim` 연결): provenance 마커(`<!-- forge-tuned -->`, Tenetx 헤더) + content-hash manifest(`~/.forgen/state/rendered-rules-manifest.json` 신설) 매칭 → 백업 후 삭제. header-only 매치는 항상 프롬프트(사용자 편집 파일 오삭제 방지). settings.json 변경은 기본 안내-only, `--apply-settings`로 명시 동의 시 실행. **오늘 수동으로 한 절차의 명령화** — 다른 사용자 환경에도 같은 좀비가 있을 수 있다.
- **3b. 글로벌 라우팅 결함 수정 (F6)**: behavioral 규칙을 `forge-behavioral.md` 글로벌 사이드채널 대신 v1 render 파이프라인의 `behavior_inference` 소스로 편입 (`rule-renderer.ts` `SOURCE_RANK`에 슬롯 이미 존재) → budget/dedupe/노이즈 게이트를 통과하게.
- **3c. 에코 하드닝 (F3)**: `generateBehavioralRules()`에 `observedCount >= 2` 게이트 + 관찰된 누수 형태(assistant 1인칭, 상태 나레이션, "이해했습니다"류)를 `SELF_REFERENTIAL_PATTERNS`에 추가. behavior 캡처 단계에서도 동일 필터 적용(오염 데이터 재축적 방지).
- **3d. `--repair` 버그 수정 (F5)**: plugin cache 자동복구가 실제로 postinstall을 실행·검증하도록. 캐시 버전-패키지 버전 동기화.

### §4. 재캘리브레이션 (ADR-009 §7 승계, 2-모델)

정직한 현재 주장: *"메커니즘 확인(δ는 injection에서, blocks는 opus-4.8에서 무발화); 크기 미증명; Sonnet 5 미측정."* 재측정 전 README 효과 수치 갱신 금지.

- **4a. 데이터셋**: retro-real.jsonl을 실데이터로 채움(me/rules + violations + implicit-feedback 소스, ≥N=15, synthetic.jsonl 스키마, file-independent 유지). `PLACEHOLDER_BOOTSTRAP` 커밋 핀 교체.
- **4b. 하네스**: sonnet-5 드라이버 트랙(`CLAUDE_CLI_DRIVER_MODEL`) + adaptive-thinking 트랜스크립트에 대한 claim-detector sanitize 재검(기존 negation-context 오탐 이력). δ_block/δ_inject 분리를 리포트 1급 칼럼으로.
- **4c. 캠페인**: R1 smoke(sonnet-5, hard N=6, κ pilot — κ_γ<0.5면 rubric 수정 우선) → R2 canonical(**Sonnet 5 전수 + Opus 4.8은 hard-set refresh** — 비용 결정, 전체 2-모델 canonical ~$1,080 대비) → R3 ψ-long sonnet-5 → R4 `docs/release/v0.5.0-recalibration.md` 발행(릴리스 블로커).
- **4d. 시점**: 사용자 결정에 따라 **모든 코드 작업 완료 후 맨 마지막**. 단 R2 결과는 §5 F3(per-model 가드 프로필)의 shipped defaults를 게이트.

### §5. 신기능 (moat 강화 4개; native 중복 후보는 기각)

| # | 기능 | moat 정합 | effort |
|---|---|---|---|
| F1 | Rule Reclaimer (§3a) | native /doctor의 flag를 *실행*으로 잇는 provenance 소유자 | S-M |
| F2 | Injection ROI 루프 — `queryHitRate()` 기반 90d `surfaced ≫ acted_on` 솔루션을 `ranking-pipeline` 강등→`solution-quarantine` 격리, dashboard "surfaced-but-ignored" 패널 | δ가 사는 곳(injection 품질) 직격; native 메모리엔 acted-on 피드백 루프 없음 | M |
| F3 | Per-model 가드 프로필 — `meta-guard-dispatch`가 model→{block\|advise\|off} 테이블 참조. frontier=advisory, codex/haiku=block. defaults는 R2 데이터로 | F1(blocks=0)을 사장이 아닌 캘리브레이션으로 전환; multi-host 차별화 강화 | S (R2 후) |
| F4 | `forgen calibrate --model` — R1 smoke 축소판(N=6, 로컬 judge)을 사용자 명령화, 결과를 dashboard에 | "쓸수록 낫다"의 증명을 self-serve로; ~5주마다 모델이 바뀌는 시대의 재-베이스라인 | M-L (시간 부족 시 첫 컷) |

**기각**: usage/limit 대시보드(native /usage), 권한 자동화(Auto mode), 컨텍스트 트리밍 *감지*(native /doctor — forgen은 provenance 기반 *실행*만), 모델 라우팅 테이블, 신규 effort 툴링.

### §6. 순서

```
M1 환경 청소                     ✅ 완료 (2026-07-16, 수동 — §3a가 프로덕트화)
M2 다이어트 코드 (§3a-d)          F1 reclaimer + 에코 하드닝 + 라우팅 픽스 + --repair 픽스
M3 경계 코드 (§2a-d)             doctor 축소, usage shim, prose 제거, trust 문장 강등
M4 moat 기능                     F2 ROI 루프 (독립, M3와 병행 가능)
M5 재캘리브레이션                 4a 데이터셋 → R1 → R2 → R3  [맨 마지막, 사용자 결정]
M6 데이터-게이트 기능 + 릴리스     F3 (R2 필요), F4 (여유 시), R4 문서, positioning 갱신
```

의존성 스파인: M5(R2) → F3 → 릴리스 수치. M2/M3/M4는 상호 독립. R2 슬립 시 diet+boundary+F2로 출시하되 효과 주장 **0** (Honest Fail Path).

## Consequences

**긍정**: (a) 컨텍스트 이중 오염 해소가 즉시 전 세션에 적용(M1 완료); (b) native와의 경쟁 소모전 회피, moat 4개에 리소스 집중; (c) blocks=0 발견이 per-model 프로필로 제품화; (d) "우리만 학습하고 증명한다" 포지셔닝이 측정으로 뒷받침.

**부정/리스크**: (a) Sonnet 5에서 δ_inject≈0이면 moat가 evidence-policy+multi-host+telemetry로 더 좁아짐 — Honest Fail Path로 공표, 제품 대응은 v0.6 결정; (b) reclaimer 오삭제 리스크 — content-hash 필수 + header-only는 프롬프트 + 전량 백업; (c) 재캘리브레이션 지연 시 릴리스가 효과 주장 없이 나감(수용됨); (d) usage-telemetry 사용자가 있다면 표시 중단이 회귀로 보일 수 있음 — 1회 공지로 완화.

## Open Questions

1. SubagentStop이 신형 5-level nested/background-default 서브에이전트에도 발화하며 depth>1에서 `agent_id`가 유지되는가? — ADR-009 probe가 구식일 수 있음. v0.5.0 검증 커버리지 주장 전 `forgen probe-workflow` 재실행 필요.
2. Sonnet 5 adaptive thinking이 트랜스크립트 파싱(claim-detector)과 SubagentStop transcript 폴백에 미치는 영향 — R1 smoke에서 함께 확인.
3. 캐시 dir 버전 불일치(0.4.12 vs 0.4.13)의 근본 원인 — postinstall의 버전 소스 확인 (§3d에서 함께).
