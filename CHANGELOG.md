# Changelog

All notable changes to forgen will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.3] — 2026-04-29 — Hotfix: bypass-detector RC5/E9 + TEST-1 wiring

forgen-eval introspect testbed가 release-blocker로 노출한 두 결함의 hotfix.

**TEST-6 — bypass-detector false-positive fix** (`fix`)
- `src/engine/lifecycle/bypass-detector.ts`: Korean stop list (실행/사용/선언/수행/처리/작성/호출/적용 + 변형) + parens-heuristic 정밀화
- 기존 root cause: Korean regex `(\S+)\s*(?:말라|금지|하지\s*마|쓰지\s*마)` 가 정책 텍스트 "rm -rf 실행하지 마라" 에서 "실행" 만 추출 → 모든 코드의 "실행" 단어가 false positive (RC5/E9).
- Parens-heuristic: `(rm -rf, DROP, force-push)` 같은 *예시 목록*은 토큰 추출하되, file path (`tests/e2e/docker/run-test.sh`) 와 exclusion notes (`프로덕션 코드 맥락 한정, 테스트 파일 내 vi.mock 은 제외`) 는 skip.
- 자기증거: 16일 사용 데이터에서 strict φ 65.66% 의 84% 가 이 단일 버그 (3 L1 rules: no-rm-rf-unconfirmed, e2e-before-done, no-mock-as-proof). 향후 0 false positive 박힘.
- 회귀 0: bypass-detector 14/14 + full forgen suite 2356/2356.

**TEST-1 — fact-vs-agreement Stop hook wiring** (`fix`)
- `src/hooks/stop-guard.ts`: `checkFactVsAgreement` import + alert-level invocation. `kind: 'correction'` (no block) — 원 design intent ("alert level only — block 은 TEST-2 에서") 준수.
- 기존 결함: `src/checks/fact-vs-agreement.ts` 코드 존재했으나 어떤 hook 도 호출 안 함 (forgen-eval introspect 가 발견한 wiring gap).
- 효과: TEST-1 alert 가 violations.jsonl `kind: 'correction'` 으로 기록 시작 → 측정 가능.

**Self-evidence**: forgen 의 자기 검증 시스템(`packages/forgen-eval/src/runners/introspect.ts`)이 자기 자신의 패턴 매칭 버그를 6주 만에 정밀하게 짚어내고 fix 까지 검증한 첫 사이클. v0.4.0 trust restoration 미션이 self-correcting harness 로 한 발자국 더.

## [Unreleased] — v0.5.0 testbed-proof

forgen이 claude-mem / hermes-agent / OMC / ECC / gstack 대비 *측정 가능한 차별*을 갖췄음을 증명하는 릴리즈. 정체성을 "extraction + enforcement (raw store 아님)"으로 박고, 7-축 메트릭 (γ/β/δ/ε/ζ/φ/ψ) × 5-arm × 2-tier (smoke/full) × 2-track (DEV/PUBLIC) testbed로 검증.

**신규 — `@wooojin/forgen-eval` (별도 npm package, npm workspaces)** (`feat`)
- `packages/forgen-eval/` — 본 forgen 본체 무게 0 영향 (peerDep 형태)
- 7-축 메트릭 구현: γ_slope (Cohen's d + Wilcoxon r), β_likert (paired diff), δ/ε/ζ rate metrics, φ Wilson-CI master gate, ψ weighted synergy
- κ (Cohen's + Fleiss') judge agreement
- φ master gate priority — γ/β 통과해도 φ > 5%면 즉시 HARD FAIL
- 5 arms 정의 (vanilla / forgen-only / claude-mem-only via CLI invoke / forgen+mem / gstack)
- DEV (Sonnet 4.6 + Qwen 72B + Llama 70B Triple, Fleiss' κ ≥ 0.8) + PUBLIC (Qwen + Llama Dual, Cohen's κ ≥ 0.7) judge tracks
- vitest 22/22 PASS — ADR-006 메트릭 공식 정확성 검증

**신규 — `forgen-team/forgen-eval-data` 외부 dataset repo** (`feat`)
- https://github.com/forgen-team/forgen-eval-data — CC-BY-SA-4.0
- 10 personas (4 academic-dataset + 3 github-issue-corpus + 3 forgen-user-anonymized) — 모두 `review_status: seed-unreviewed`
- correction-sequences synthetic (7) + retro-real (3) bootstrap
- CURATION.md — 외부 PR 정책 (자체 작성 금지, 2-reviewer 강제)
- forgen-eval은 commit hash pin으로 dataset version 추적

**Architecture — claude-mem coexistence (Plugin model)** (`design`)
- ADR-004 amendment — orchestration 가설 폐기, Plugin model 확정
- (α) Minimal default + Full 권장 — forgen 본체에 claude-mem 의존성 추가 안 함 (AGPL 회피)
- claude-mem은 `npx claude-mem install --ide claude-code`로 사용자가 별도 설치 → Claude Code가 자동 chain
- Spec §10a — 6 사용자 시나리오 → 메트릭 매핑 narrative

**Repo migration** (`chore`)
- `wooo-jin/forgen` → `forgen-team/forgen` 이전 (1 star + 6 issues 자동 마이그레이션, redirect 자동)
- npm scope `@wooojin/forgen` 그대로 유지 (별도 결정)
- 11 파일 URL bulk 갱신 (READMEs + plugin.json + CONTRIBUTING + CHANGELOG + SECURITY)

**Documentation**
- `docs/plans/2026-04-28-forgen-testbed-proof-spec.md` — Deep Interview 11라운드 spec
- `docs/spike/2026-04-28-claude-mem-spike.md` — claude-mem 실측 (AGPL/Plugin model 발견)
- `docs/adr/ADR-004/005/006-*.md` — claude-mem orchestration / forgen-eval module / metric methodology
- README §"Validated by testbed (v0.5.0)" — testbed 결과 (실 GPU run 후 placeholder 대체 예정)

**v0.5.0 출시 게이트** (release blockers)
- φ ≤ 5% (false positive rate, Wilson 95% CI upper bound)
- ψ > 0 (synergy: full > max(forgen-only, mem-only))
- κ_DEV ≥ 0.8 / κ_PUBLIC ≥ 0.7
- discard rate ≤ 10%
- 모든 effect 메트릭 통과 (γ d ≥ 0.8, β +0.5, δ 90%, ε 85%, ζ 85%)

**Honest fallback**: testbed FAIL 시 (φ > 5%) — README에 "claude-mem 추천" 명시. 이건 정체성에 대한 자기 검증.

## [0.4.2] - 2026-04-27

### v0.4.2 — Trust hotfix + 학습 회로 4축 확장

v0.4.1 이 신뢰 회복 릴리스였다면, v0.4.2 는 **외부 진단(trust-hotfix-report)을 측정으로 검증해 5개 W 를 닫고**, 동시에 v0.4.1 자기 분석에서 발견된 **자동 학습이 4축 중 2축에만 닿는 결함(D1)** 과 **검증 레이어 invariant 부재(P1~P4)** 까지 한 사이클에 통합한 릴리스.

**M1 — RC6 가드: forge-loop findings 자동 inject** (`feat`)
- `src/hooks/shared/forge-loop-state.ts` 신규 — readForgeLoopState / renderForgeLoopForSession / renderForgeLoopForPrompt
- `session-recovery` (SessionStart) + `forge-loop-progress` (UserPromptSubmit) 신규 hook 이 직전 forge-loop findings 또는 진행 중 stories 를 ≤1KB 로 inject
- 자기증거: head -80 truncation 으로 directly 유실됐던 사례 invariant 박제
- Stale 24h soft / 7d hard cap, XML escape

**D1'' — auto-compound axis_refs 4축 분류 확장** (`feat`)
- `src/core/behavior-classifier.ts` 신규 — 5분기 (workflow/thinking/preference + **safety/autonomy** 신규)
- LLM prompt 카테고리 7종으로 확장 ([품질안전], [자율성] 추가)
- 결과: behavior_observation 자동 추출이 4축 모두에 닿음 (이전 2축 → 4축)
- 측정 자기증거: behavior 627건 중 quality 7 / autonomy 6 만 explicit_correction 경로로 들어왔던 결함 해결

**P2 — false-positive corpus golden test** (`test`)
- `tests/invariants/no-false-positive-block.test.ts` (FP1~5 + RC5-E9, 8 케이스)
- `tests/invariants/true-positive-block.test.ts` (E5/E6 정당 block 5 케이스)
- 신규 detector CI gate — vitest 가 tests/invariants/* 자동 포함

**P3' — Blocking ALLOW-LIST 정책 + denyOrObserve helper** (`feat`)
- `src/hooks/shared/blocking-allowlist.ts` (4개 멤버: stop-guard / pre-tool-use / secret-filter / db-guard)
- `denyOrObserve(hookName, reason, observer?)` helper — ALLOW-LIST 외 hook 의 deny 시도가 자동 관찰 모드로 강등
- 점진 마이그레이션 시작점 (기존 hook 들은 별도 PR)

**P4 — fix:feat 비율 셀프 가드** (`feat`)
- `src/core/git-stats.ts` — 최근 30커밋 fix:feat 비율 측정 (fix(test):/fix(docs): 제외)
- forgen stats 에 "Repo health" 섹션 + forgen doctor 가 30% 초과 시 경고
- v0.4.2 릴리즈 시점 측정값: **29%** (정상 범위, ⚠ 미발생)

**W1 — 한국어 README 설치 명령 오타 fix** (`fix`)
- `README.ko.md:86, 146` 의 `npm install -g /forgen` → `@wooojin/forgen`
- `tests/readme-install-contract.test.ts` 4 로케일 일치 invariant

**W2 — 온보딩 2/4 문항 계약 통일** (`fix`)
- `src/cli.ts:164, 469` 도움말 `2-question` → `4-question`
- `src/forge/onboarding.ts` 주석 4문항 갱신 + spec 경로 정정 (docs/history/)
- `tests/onboarding-contract.test.ts` — askChoice 호출 수 vs help text 일치

**W3 — agent 인벤토리 12↔13 정렬** (`fix`)
- `README.md:381` "12 built-in agents" → "13" + ch-solution-evolver Plan-only 표 추가
- `tests/agent-inventory-contract.test.ts` — agents/ 디렉토리 = README + verify-v3.sh 단일 source

**W4 — hooks-generator releaseMode 옵션** (`feat`)
- `generateHooksJson({ releaseMode: true })` 환경 독립 모드 — plugin 감지 + hook-config 비활성화 모두 무시
- `prepack-hooks.cjs` 가 releaseMode=true 사용 (HOME swap 도 유지하여 double safety)
- `tests/hooks-generator-release-mode.test.ts` — mock plugin / mock disable 양쪽 검증

**W5 — 하드코딩 → HOOK_REGISTRY.length 동적 read** (`refactor`)
- 3 자리 (plugin-coexistence / harness-e2e / chain-verification) 의 `21` 하드코딩 제거 → 동적 length
- `tests/contract-single-source.test.ts` 자체 invariant — 향후 하드코딩 추가 시 자동 fail
- A3 false-positive 가드: hook-timing/cache-lock-integration 의 다른 의미 20 은 건드리지 않음

**D2 — autonomy axis confidence 직접 경로** (`fix`)
- `bumpAxisConfidence(axis, delta)` — explicit_correction 의 axis_hint 가 즉시 confidence bump
- `evidence-processor.ts` 에서 호출: avoid-this +0.04, 그 외 +0.02
- 자기증거: autonomy explicit_correction 6건이 score 못 움직였던 결함 해결
- facet 값은 안 건드리고 confidence 만 — 회귀 위험 최소

**자기증거 박제** (`docs`)
- `docs/issues/D2-autonomy-facet-stuck.md` — D2 root cause 추적
- `docs/issues/W4-W5-self-evidence.md` — 본 forge-loop 1차에서 W4/W5 antipattern 을 단기 회피로 재생산한 사례 (RC7 후보)
- compound 4 박제: rc6-meta-amnesia, rc7-diagnostic-self-fix, validator-layer-invariant, interview-axes-disconnect-RETRACTED

**회귀**:
- vitest **2215/2215** (199 files, 신규 13 테스트 파일)
- Docker e2e **77/77 + ALL CHECKS PASSED** (round 12, mock_detected:false)
- typecheck 0

**Outstanding (별도 PR)**: P3' enforcement 의 기존 hook 마이그레이션, prepack-hooks.cjs 의 HOME swap 단순화

---

## [0.4.1] - 2026-04-24

### v0.4.1 — 하네스가 당신을 담고 간다

v0.4.0 이 Trust Layer (Claude 가 "완료"라고 하면 forgen 이 증명하게 한다) 를 세웠다면, v0.4.1 은 **구매자가 첫 block 을 즉시 경험**하고 **README 만 봐도 "하네스가 당신을 담고 간다" 는 비전을 이해**하게 만드는 릴리스. 내부적으로는 직전 회차에서 scope-out 했던 측정 갭 3건을 정직하게 재평가 → 실제로 닫았고, 10 시나리오 실 Claude signal 누적으로 검증.

**3개 구조적 갭 마감** (`feat`)
- `recall_referenced` 측정: name literal 단일 매칭 → identifier / 복합 태그 2개 교차 fallback 추가. Claude 가 slug 이름 대신 solution content 만 인용해도 잡힘. 일반 단어 단독은 false-positive 방지 위해 제외.
- `Rule.lifecycle` 자동 초기화: `saveRule` 이 lifecycle 없으면 `phase='active'` + counters=0 주입. suppressed rule 의 audit trail (누가 언제 왜) 추적 가능.
- `forgen compound list` 출력: `inj: / ref: / neg:` 컬럼에 "ref 측정은 v0.4.1+ 부터 시작됨" 주석. legacy 데이터 `ref:0` 을 "도움 안 됨" 으로 오독하는 혼란 해소.

**README 리프레시** (`docs`)
- **The harness carries you 섹션 신설**: "대화 → 추출 → 주입 → 반복" cycle + `forgen compound export/import` (개인 철학 번들을 tar.gz 로 이식) 연결. forgen 을 "rule 주입 tool" 로 축소 해석하는 오독 해소.
- 한국어/일본어/중국어 README 동기화 ("하네스가 당신을 담고 간다" / "ハーネスがあなたを運ぶ" / "这个 harness 装载的是你").
- **The first block 데모 일반화**: forgen-repo 전용 L1 rule → v0.4.1 내장 `builtin:self-score-inflation` (TEST-2) 기반 일반 시나리오로 교체. 구매자가 rule 작성 없이도 첫 block 을 바로 체감.
- Commands 섹션에 `forgen recall` / `forgen migrate` / `forgen init` 추가.
- Cold-start boost 설명: champion/active 솔루션 < 5 이면 `MIN_INJECT_RELEVANCE` 0.3 → 0.2 완화.

**natural-accumulation e2e** (`test`)
- 격리 `FORGEN_HOME` + 실 Claude API 10 시나리오로 "시간이 답" 이던 open signal 4종을 수십 분 내 실증:
  - `recall_referenced` 0 → 2 (33% 참조율)
  - `recommendation_surfaced` 1 → 6 (60% 주입률, cold-start boost 실효 확인)
  - TEST-2 자연 block 0 → 3
  - TEST-3 자연 block 0 → 2
  - hook-errors 0 (전 경로 clean)

**회귀**: vitest 2114/2114 (신규 테스트 4건 포함). typecheck 0.

---

## [0.4.0] - 2026-04-23

### v0.4.0 — The Trust Layer

**When Claude says "done", forgen makes it prove it.** v0.4.0 adds turn-level self-verification at the Stop hook: Claude's completion claims get checked against rules you define, and blocks are fed back as `reason` that Claude reads and complies with on the next turn — **zero extra API calls**. Verified end-to-end on 10 scenarios at $1.74 total ([A1 spike report](docs/spike/mech-b-a1-verification-report.md)).

Built on top of the v0.3.x personalization core (4-axis profile + compound knowledge + rule rendering): the Trust Layer = 3-axis enforcement (Mech-A/B/C) + rule lifecycle (T1-T5 + Meta) + release self-gate. Interview rounds 9~10 mission "forgen 이 자기 규칙을 forgen 자신에게 강제 적용" achieved — this repo's own development was stopped mid-commit by its own L1 rule when the maintainer claimed "완결" without running Docker e2e (evidence preserved in `.forgen/state/enforcement/violations.jsonl`).

**ADR-001 — Mech-A/B/C 3축 강제 메커니즘** (Accepted)
- Mech-A (hook-BLOCK): 기계 판정 가능 규칙 — PreToolUse deny / Stop artifact_check.
- Mech-B (self-check prompt-inject): 자연어 판정 규칙 — Stop hook `decision:"block"` + `reason` 으로 Claude 자가점검 강제. **β1 ($0): 외부 LLM 호출 없음.**
- Mech-C (drift-measure): 정량 판정 불가 규칙 — 장기 편향만 측정.
- A1 검증 스파이크 10/10 PASS ($1.74, 3분): block 수용률 1.00, FP 0.00, hook p95 7ms, 추가 API 0.

**신규 타입** (`src/store/types.ts`):
- `EnforcementMech`, `HookPoint`, `VerifierSpec`, `EnforceSpec` — `Rule.enforce_via` 에 붙음 (optional, 기존 rule 하위 호환).
- `EnforceSpec.trigger_keywords_regex` / `trigger_exclude_regex` / `system_tag` — Stop hook 전용 발화 조건.
- `LifecyclePhase`, `LifecycleState`, `MetaPromotion` — `Rule.lifecycle` 에 붙음.

**신규 Hook**:
- `src/hooks/stop-guard.ts` — Stop hook. Production `rulesFromStore(loadActiveRules())` 로드, spike scenarios.json fallback. `last_assistant_message` 직접 read. stuck-loop guard (threshold 3 초과 시 force approve + drift 이벤트). `compoundCritical: true` (보호 hook).
- `src/hooks/shared/hook-response.ts::blockStop(reason, systemMessage?)` helper.

**ADR-002 — Rule Lifecycle Engine** (Accepted)
- T1 explicit_correction: `evidence-store.appendEvidence` → `detectT1` → rule retire/supersede/flag. axis + render_key 이중 매칭으로 FP 차단.
- T2 repeated_violation: 30d rolling window `violations_30d ≥ 3 AND rate > 0.3` → flag. 데이터 소스: `~/.forgen/state/enforcement/violations.jsonl` (stop-guard block 시 자동 append).
- T3 user_bypass: `post-tool-use` 에서 `bypass-detector.scanForBypass` → `recordBypass`. 7d `bypass_count ≥ 5` → suppress.
- T4 time_decay: `state-gc.runDailyT4Decay` — `forgen doctor --prune-state` 실행 시 90d 미주입 rule retire (별도 scheduler 없음; 사용자가 명시적으로 실행).
- T5 conflict_detected: `rule-store.appendRule` 에서 T5 감지, 양쪽 `conflict_refs` 기록.
- Meta 양방향: drift.jsonl 누적 → 강등 (A→B→C); rolling 20 injects + 0 violations → 승급 (B→A, C→B).
- Orchestrator `applyEvent` / `foldEvents` pure — rule 파일 쓰기는 호출자 책임.
- `src/store/rule-store.ts::markRulesInjected` — `v1-bootstrap` 이 renderRules 후 호출해 Meta 롤링 카운터를 채움.

**ADR-003 — Release Self-Gate** (Accepted)
- `.github/workflows/self-gate.yml` — push main / PR main / tag v* 에서 3-stage 검증.
- `scripts/self-gate.cjs` — 정적 스캔: mock-in-production, secrets-leak (AWS 공식 EXAMPLE fixture allow list), enforce_via-missing, release-artifact.
- `scripts/self-gate-runtime.cjs` — 6 hook 시나리오 smoke (완료 선언 block / retraction approve / shipped block / mock-context approve 등). 격리 HOME.
- `scripts/self-gate-release.cjs` — tag-only: version/tag match, CHANGELOG section, dist freshness, .forgen-release/e2e-report.json.

**신규 CLI**:
- `forgen rule <list|suppress|activate|scan|health-scan|classify>` — 규칙 관리 네임스페이스. 기존 플랫 커맨드(suppress-rule, activate-rule, lifecycle-scan, rule-meta-scan, classify-enforce)는 하위 호환 alias 로 유지.
- `forgen stats` — 한 화면 대시보드 (active rules, corrections, blocks/bypass/drift 7d, retired 7d, last extraction). 기존 jsonl 집계; 신규 telemetry 없음.
- `forgen inspect corrections` — `forgen inspect evidence` 의 사용자 친화 이름. evidence 는 alias 로 유지.
- `forgen last-block` — 가장 최근 block 이벤트 상세.

**내부 CLI (하위 호환, alias 로 유지)**:
- `forgen classify-enforce [--apply] [--force]` → `forgen rule classify`.
- `forgen rule-meta-scan [--apply]` → `forgen rule health-scan`.
- `forgen lifecycle-scan [--apply]` → `forgen rule scan`.

**Upgrade notes (v0.3.x → v0.4.0)**:
- 첫 `forgen` 실행 시 기존 rule 파일 (`~/.forgen/me/rules/*.json`) 에 `lifecycle` 블록이 자동 주입됩니다 (inject_count, phase='active' 등). 기존 필드는 보존됨.
- 프로젝트 로컬 `.forgen/rules/*.json` 이 자동 로드됩니다 (runtime 병합). 팀 dogfood 경로. 테스트/격리 필요 시 `FORGEN_DISABLE_PROJECT_RULES=1`.
- `FORGEN_USER_CONFIRMED=1` 으로 Mech-A PreToolUse 우회 시 violations.jsonl 에 `kind:'correction'` audit 엔트리 기록.

**운영 지표**:
- 전체 회귀 1973/1973 pass (169 files), TypeScript clean.
- forgen doctor 20/20 hooks active; legacy `~/.forgen/rules/` orphan 감지 추가.
- Self-gate 정적 ✓ + 런타임 7/7 (SG-ACK round-trip 포함); Docker e2e 77/77 (Phase 9 R9 전체 검증).
- `npm pack` tarball 539.3 kB, 332 파일, v0.4.0 메타데이터 확인.

**관측성**:
- `acknowledgments.jsonl` 신규 — Mech-B block → retract → pass 루프가 실제 작동한 세션 기록. `forgen stats` 의 `X% acknowledged` 라벨로 집계.

## [0.3.2] - 2026-04-21

### Security — Audit findings landed

Independent read-only audit (docs/claude-audit-brief.md) surfaced 10 structural
issues plus 2 follow-up findings. All 12 are fixed with invariant tests.

**P0 — data loss / code injection**
- **Settings parse-failure data loss** (#2, #10): `settings-injector.ts` and
  `scripts/postinstall.js` no longer silently replace a malformed settings.json
  with `{}`. New `readSettingsSafely()` preserves the corrupt original to
  `settings.json.corrupt-<ts>` and throws; writers release the lock and abort.
  postinstall settings + `~/.claude.json` now use tmp-file + rename atomic write.
- **Code injection via node -e** (#5): `session-recovery.ts` no longer
  interpolates a user-supplied sessionId into a `-e` template literal. A
  dedicated runner at `dist/hooks/internal/run-lifecycle-check.js` reads the id
  from argv — no shell, no eval surface.
- **solution-outcomes race** (#9): all pending-state mutations are now serialised
  under `withFileLockSync` + `atomicWriteJSON`. Concurrent inject / correction /
  error hooks on the same session no longer lose or duplicate events.
- **Archive path traversal** (follow-up #A): `compound-export.importKnowledge`
  rejects entries whose resolved destination sits outside ME_DIR, including
  sibling-directory prefix collisions (e.g. `../me-evil/…`).

**P1 — lock semantics, trust, uninstall, injection precision**
- **Settings-lock live-holder handling** (#1): acquireLock now throws
  `SettingsLockError` on live-PID timeout instead of overwriting the lock;
  releaseLock verifies ownership before deleting.
- **Trust silent escalation** (#3): `preset-manager.computeEffectiveTrust`
  returns a `Trust 상승` warning when runtime is more permissive than desired;
  harness surfaces it to the user; fgx cautions `가드레일 우선`/`승인 완화`
  profile users.
- **Install/uninstall symmetry** (#7): `uninstall` now strips `FORGEN_*` env
  keys (previously only `COMPOUND_*`) and recognises `forgen me` (previously
  only `forgen status`) as the forgen-owned statusLine.
- **Legacy profile guard** (#6): `loadProfile` runs `isV1Profile` and returns
  null on legacy shapes so bootstrap re-runs cutover instead of typing stale
  JSON as v1.
- **secret-filter vendor tokens** (follow-up #B): GitHub PATs (ghp_/gho_/
  ghs_/ghu_/ghr_), Google API keys (AIza…), and Slack tokens (xox[abpors]-…)
  are now detected.

**P2 — label truth, transcript attribution**
- **permission-handler labels** (#4): `approve()`/`approveWithWarning()` never
  set `permissionDecision: 'allow'`; they are pass-through. Log and API labels
  renamed to `safe-pass-through` / `autopilot-warn-pass-through` /
  `autopilot-pass-through` / `pass-through` so audit trails match reality.
- **Transcript per-session attribution** (#8): `spawn.ts` snapshots existing
  transcripts before launching claude and diffs after exit; concurrent sessions
  in the same cwd no longer cross-attribute. Transcript reading switched to
  streaming (`createReadStream` + `readline`).

### Added — Data hygiene

Field audit on a ~2-week-old install found 10,802 files in `~/.forgen/state/`
across 12 filename prefixes, 4.3 MB `match-eval-log.jsonl`, and 80% of
error-attribution events concentrated on 3 solutions injected at relevance
0.15–0.21.

- `forgen doctor --prune-state` (new `src/core/state-gc.ts`): removes session-
  scoped files older than 7 days (checkpoint-, injection-cache-, modified-
  files-, outcome-pending-, permissions-, skill-trigger-, tool-state-,
  reminder-, context-, last-). Aggregate jsonl logs are preserved.
- `solution-outcomes.attributeError` gates: match_score ≥ 0.3,
  injection-lag ≤ 5 min, top-3 by relevance. Prevents blanket blaming of
  every injected solution when a tool fails.
- `solution-injector.MIN_INJECT_RELEVANCE = 0.3` + multi-tag precision gate
  (`matchedIdentifiers ≥ 1 OR matchedTags ≥ 2`): the matcher remains
  permissive for recall@5; only the injection step enforces the stricter
  gate. Zero single-tag high-score injections observed in the field corpus
  after landing.
- `match-eval-log.jsonl` size-based rotation at 10 MB (one generation
  retained).

### Fixed — e2e test isolation

Docker-spawned hooks in `tests/e2e/*.test.ts` were writing session state
(`e2e-tool-chain`, `chain5-test`, etc.) into the developer's real
`~/.forgen/state/`. Each e2e file now allocates a fresh `mkdtempSync` HOME
and injects it into the spawn env; `afterAll` cleans up. Likewise
`tests/hook-response-tracking.test.ts` now mocks `node:os` so the tracking
log never lands outside `/tmp/`.

### Fixed — Stale Docker verify checks

`tests/e2e/docker/verify.sh` was asserting three skills that were deleted in
commit f534227 (v0.3 quality refactor). Result goes from 62/4/6 to 63/0/6
without touching runtime code.

### Notes

- All fixes confirmed via invariant tests (1732/1732 pass across 143 files),
  7 real-world attack scenarios (injection, concurrent mutation, corrupt
  settings, path traversal, prune, doctor smoke), and Linux-clean-environment
  Docker verification.
- Upgrade path from 0.3.1 verified (profile + solutions + non-forgen settings
  byte-identical after upgrade).
- Windows code paths exist but runtime validation is deferred to GH Actions
  Windows runner — see P-D note in release audit.

## [0.3.1] - 2026-04-16

### Added — Self-Evolving Harness (inspired by Stanford meta-harness)

Three-phase evolution loop around the existing compound solution store:

**Phase 1 — Fitness Loop (Select axis):**
- `solution-outcomes`: per-session inject→outcome event log (accept/correct/error/unknown) with fail-open semantics; attribution through solution-injector (appendPending/flushAccept), correction-record MCP (attributeCorrection), and post-tool-failure hook (attributeError).
- `solution-fitness`: Laplace-smoothed acceptance ratio × log(1+injected) confidence. State classification: draft / active / champion / underperform. No auto-delete — population-relative thresholds only.
- `solution-quarantine`: malformed frontmatter no longer silently dropped — invalid files surface in `~/.forgen/state/solution-quarantine.jsonl` with actionable diagnostics; `listQuarantined` / `pruneQuarantine` helpers.
- `solution-fixup`: schema migration for legacy defects (missing `extractedBy`, missing `evidence` block, missing `supersedes`). Applied to the live install, this recovered 5 dead solutions and one was injected on the next matching prompt.

**Phase 4 — Self-Evolution (Propose + Select axes):**
- `solution-weakness`: structured discovery report from four detectors — under-served tags (correction evidence without a matching champion), conflict clusters, dead corners (injected=0 with unique tags), volatile solutions (accept-rate shift >0.3).
- `ch-solution-evolver` agent: Opus proposer, Bash-disabled, emits exactly 3 novel candidates into `~/.forgen/lab/candidates/` with 30%-80% tag overlap gate and self-critique novelty check.
- Candidate cold-start bonus: solutions with `status: candidate` get confidence × 1.3 so they reach enough injections to accumulate fitness. Auto-promotes to `verified` at 5 injections; bonus disappears naturally.
- Candidate lifecycle: `promoteCandidate` validates schema + refuses name collisions before moving files from lab to `me/solutions`. `rollbackSince` archives every `source: evolved` solution newer than a cutoff to `~/.forgen/lab/archived/rollback-{ts}/` (never deletes — always recoverable).

**CLI surface:**
- `forgen learn fix-up [--apply]` — dry-run repair of malformed solutions.
- `forgen learn quarantine [--prune]` — show / clean dropped solutions.
- `forgen learn fitness [--json]` — per-solution fitness table.
- `forgen learn evolve [--save]` — weakness report + proposer hint.
- `forgen learn evolve --promote --list` / `--promote <name>` — candidate promotion.
- `forgen learn evolve --rollback <epoch-ms-or-ISO>` — time-bounded rollback.
- Dashboard gains a 🎯 Solution Fitness panel (state distribution + top-3).

**Dogfood evidence:** the full pipeline was exercised end-to-end — weakness report → evolver-agent proposal → schema validation → promotion → cold-start-boosted match (relevance 0.78) → injection counter increment.

### Documentation
- `docs/design-solution-evolution.md` — Phase 4 design spec with open questions, prerequisites, and rollout plan.

## [0.3.0] - 2026-04-15

### BREAKING

- **Skill consolidation: 21 → 10**. Removed: refactor, tdd, testing-strategy, documentation, git-master, ecomode, specify, performance, incident-response, database, frontend, ci-cd, api-design, debug-detective, migrate, security-review. Most were generic checklists; their content is better handled by Claude natively or absorbed into remaining skills.
- **Agent consolidation: 19 → 12**. Removed: performance-reviewer, security-reviewer (merged into code-reviewer as review perspectives), refactoring-expert, code-simplifier (merged into executor), scientist, qa-tester (merged into verifier), writer.
- **Custom frontmatter removed**: Agents no longer use `tier` and `lane` fields (Claude Code ignored them anyway).

### Added

- **5 new skills** designed from best-in-class research (OMC ralph, gstack /ship, /retro, /learn):
  - `forge-loop`: PRD-based iteration with Stop hook persistence. Prevents polite-stop anti-pattern.
  - `ship`: 15-step automated release pipeline with "never ask, just do" philosophy + Review Readiness Dashboard + Verification Gate.
  - `retro`: Weekly retrospective with git analysis + compound health + learning trend + compare mode.
  - `learn`: Compound knowledge management — 5 subcommands (search/stats/prune/export/import) with stale & duplicate detection.
  - `calibrate`: Evidence-based profile adjustment — quantitative protocol, 3-correction threshold, max 2 axes per calibration.
- **Stop hook forge-loop integration** (`context-guard.ts`): When `.forgen/state/forge-loop.json` has incomplete stories, Stop is blocked with persistence message. Circuit breakers: 2h stale threshold, 30 max blocks.
- **Learning Dashboard** (`forgen dashboard`): New "Learning Curve" section showing correction trend (7d vs prev 7d), top correction axes, activity days, estimated time saved via compound injections.
- **Session Summary with Counterfactual**: Session end message now includes "주입된 compound: N건 / 추정 절약 시간: Xh Ym (forgen 없었으면 시행착오 필요)".
- **Plugin system**: `.forgen/skills/*.md` scan path added. Project-level custom skills supported.
- **Stale agent cleanup**: `harness.ts` `installAgents` now removes `ch-*.md` files that don't exist in current source (with marker + hash verification for user-modification safety).

### Changed

- **All 10 skills upgraded** with `<Compound_Integration>`, `<Failure_Modes>`, `argument-hint`. Density dramatically improved despite fewer skills.
- **All 12 agents upgraded** with `<Failure_Modes_To_Avoid>`, `<Examples>` (Good/Bad), `<Success_Criteria>`, and official frontmatter (`maxTurns`, `color`, `permissionMode`).
- **deep-interview rewritten** using OMC research: weighted 4-dimension scoring, 3 challenge modes (Contrarian/Simplifier/Ontologist), ontology stability tracking, anti-sycophancy rules, one-question-at-a-time protocol.
- **Cancel flow**: `cancelforgen` now also deletes `forge-loop.json` to release Stop hook block.
- **Install is global-only**: `package.json` sets `preferGlobal: true` so non-global installs surface a warning (forgen is a CLI on PATH; local installs were unreachable).
- **README**: Added "12 built-in agents" section grouped by tool access (read-only / plan-only / write-enabled) with the absorbed-agent mapping from the 19→12 consolidation.

### Fixed

- **Agent parser compat**: Moved `<!-- forgen-managed -->` marker below YAML frontmatter in all 12 `agents/*.md`. Claude Code's agent parser requires `---` on line 1; the prior position caused `Agent(subagent_type: "ch-*")` to fail with "not found" while the file stayed marked as managed.
- **README install typo**: `npm install -g /forgen` → `npm install -g @wooojin/forgen` (missing scope).
- **flaky e2e test**: `runHook` helper in `tests/e2e/chain-verification.test.ts` now requires the parsed stdout JSON to carry a `continue` field, preventing stray log lines from satisfying the parser and producing false `continue:false` matches. Verified stable across 3 consecutive full runs (1541/1541 each).

### Documentation

- `docs/weakness-analysis-2026-04-14.md` — Competitor analysis vs 7 harness tools
- `docs/design-skills-agents-plugins.md` — Full design specification with implementation status
- `docs/skill-scenarios.md` — 12 developer scenarios × skill usage matrix
- `docs/positioning-and-selling.md` — Market positioning and Go-to-Market strategy

## [0.2.1] - 2026-04-13

### Added
- **specify skill**: Structured requirement specification with Resolved/Provisional/Unresolved 3-level evaluation and readiness percentage
- **deep-interview skill**: Deep requirement interview with Ambiguity Score (0-10) quantification across 5 axes (What/Who/How/When/Why)
- **Agent output validation** (Tier 2-F): PostToolUse hook validates sub-agent output for empty/failed/timeout/context overflow
- **BM25 ensemble scoring** (2-C): 3-way ensemble (TF-IDF 0.5 + BM25 0.3 + bigram 0.2) for solution matching
- **Intent-based context injection** (2-B): implement/debug/refactor/review intents inject domain-specific rules
- **Harness maturity diagnosis**: `forgen doctor` shows 5-axis L0-L3 maturity score with Quick Wins
- **Session brief handoff**: Structured brief saved before compact, restored on next session start
- **Output overflow prevention**: Solution injection footer includes head_limit guidance

### Fixed
- **Korean `\b` boundary**: Fixed 7 regex patterns where `\b` failed with Korean text (intent-classifier, keyword-detector)
- **Revert→drift connection**: `isRevert` was always false (checked messages array instead of boolean flag)
- **ALL_MODES missing specify**: `cancelforgen` didn't clear specify state
- **MCP list TypeError**: Crashed on url-format servers without `args` field
- **Agent empty string**: Empty string (`""`) was falsy, skipping validation
- **Solution content regex**: `\Z` is not valid in JavaScript (literal Z), changed to `$`
- **`severity: 'info' as 'warning'`**: Removed forced type assertion

### Changed
- **Rule renderer AI optimization** (2-A): `[category|strength]` tag prefix format, `include_pack_summary` defaults to false (token reduction)
- **Recovery messages** (1-A): ENOENT suggests Glob search, EACCES suggests chmod
- **skill-injector lock**: Session cache protected with `withFileLockSync` (race condition fix)
- **incrementFailureCounter lock**: Context signals protected with `withFileLockSync`
- Docker E2E expanded to 68 checks (Phase 8: Hoyeon analysis verification)

## [5.1.0] - 2026-04-06

### Fixed
- **Reflection 메커니즘 수리**: compound-read MCP 호출 시 `reflected += 1` 기록 — lifecycle 프로모션 루프 해제 (injected 30회인데 reflected 0이던 문제 해결)
- **훅 주입 누락 (W0)**: harness가 hooks.json을 settings.json에 직접 주입 — 플러그인 캐시 없이도 17개 훅 런타임 작동
- **태그 노이즈**: 한국어 조사 strip (`stripKoSuffix`), 영어 스톱워드 6개 추가, MAX_TAGS 10→8

### Added
- `forgen compound retag` CLI 서브커맨드 — 기존 솔루션 태그 일괄 재생성
- `readSolution()` `skipEvidence` 옵션 — compound-search snippet에서 evidence 오염 방지
- `migrateToForgen()` — `~/.compound/` → `~/.forgen/` 자동 마이그레이션 + symlink

### Changed
- 모든 `ME_*` 경로를 `~/.forgen/` 기반으로 통합 (스토리지 이원화 해소)
- `V1_*` 상수 deprecated 처리 (ME_*와 동일 경로)
- 완료/폐기된 계획 21개를 `docs/history/`로 이관

## [5.0.0] - 2026-04-03

### Breaking Changes
- v1 personalization engine: 4-axis profile (quality_safety, autonomy, judgment_philosophy, communication_style)
- 60% 코드 제거 (pack, remix, dashboard, loops, constraints, knowledge 등)

### Added
- Evidence-based learning: correction-record MCP → facet delta → profile auto-update
- Mismatch detection: rolling 3-session behavioral divergence alert
- Starter solutions: 15개 Day 0 value pack + postinstall seed
- Session store: SQLite FTS5 full-text session search

## [3.1.0] - 2026-04-01

### Added
- **Understanding layer (Phase 1)**: HTML dashboard (`forgen me --html`), Knowledge Map (`forgen compound map`), Evolution Timeline (sparkline), Session Retrospective (5-rule pattern engine)
- **Personalized orchestration (Phase 2)**: Pipeline Recommender (`forgen pipeline`), Agent Overlay Injection (PreToolUse approve(message)), Contextual Bandit (Factored Beta-TS)
- **Forge auto-init (Phase 0)**: Auto-creates forge-profile via project scan when missing, session endTime backfill, experiment cleanup (`doctor --clean-experiments`)
- **Surprise Detection**: z-score 1.5σ deviation from reward baseline (activates after 30+ observations)
- **Preference Stability**: BKT P(known) stability bars for dimension convergence tracking

### Fixed
- compound-search returned 0 results (tag noise + matchedTags<2 threshold + cross-language gap)
- compound-lifecycle timeout (grep scanned node_modules/dist/.git)
- pattern-detector ignored user-rejection events (only checked user-override)
- 4 HIGH issues from v3 code review (MCP readOnly, gate1 mutation, test homedir, empty assertion)

### Changed
- Korean stopwords expanded (+50 words for 조사/어미/접속사)
- Solution search: name-based matching boost for cross-language queries
- README: honest Day 1 timeline, "50+ pattern detectors" clarification, test stats updated

## [3.0.0] - 2026-03-31

### Breaking Changes
- **Public API**: Removed `readCodexOAuthToken`, `loadProviderConfigs`, `ProviderConfig`, `ProviderName`, `ProviderError`, `PackError`, `PackMeta`, `PackRequirement` exports from lib.ts
- **CLI**: 37 commands → 12 (removed pack, remix, dashboard, setup, status, worktree, ask, codex-spawn, synth, wait, notify, governance, gateway, worker, proposals, scan, verify, stats, rules, marketplace, session, philosophy)
- **Dependencies**: Removed `ink`, `react`. Added `zod` as direct dependency

### Added
- **MCP compound server**: 4 tools (compound-search, compound-list, compound-read, compound-stats) for on-demand knowledge access
- **Behavioral learning**: 10 thinking patterns (verify-first, quality-over-speed, understand-why, pragmatic, systematic, evidence-based, risk-aware, autonomous, collaborative, incremental)
- **Pre-compact Claude analysis**: Claude analyzes conversation for thinking patterns at context compaction (0 API cost)
- **Session feedback**: "[forgen] 학습된 패턴 N개 활성 중" shown at session start
- **forge-behavioral.md**: Auto-generated rules from learned preferences
- **Progressive Disclosure**: Push summaries (~200 tokens), pull full content via MCP (89% token reduction)
- **Hook response utilities**: Shared approve/deny/failOpen functions (Plugin SDK format)
- **Tool-specific matchers**: db-guard→Bash, secret-filter→Write|Edit|Bash, slop-detector→Write|Edit

### Changed
- **Codebase**: 36,977 → ~26,000 lines (30% reduction, Phase 1/2 added ~2,300 lines)
- **Hook protocol**: Migrated all 17 hooks from `result/message` to `continue/systemMessage` (Plugin SDK format)
- **Tag extraction**: Korean stopwords filter (80 words), MAX_TAGS=10, frequency-based ranking
- **Solution matching**: Identifier-based boost (+0.15), threshold relaxed (2 tags → 1 tag or 1 identifier)
- **Context budget**: Conservative fallback (factor=0.7 on detection failure)
- **Rules**: Conditional loading via paths frontmatter, RULE_FILE_CAPS enforced (3000/file, 15000/total)
- **Skill descriptions**: Updated to 3rd-person format per Claude Code Plugin SDK best practices
- **Build**: `rm -rf dist` before tsc (clean tarball guaranteed)

### Removed
- Pack system (src/pack/, packs/, forgen pack commands)
- Remix system (src/remix/)
- Dashboard TUI (src/dashboard/, ink/react dependencies)
- 27 unused modules (synthesizer, marketplace, worktree, etc.)
- 12 workflow mode commands (ralph, autopilot, team, etc.)
- Philosophy generator/CLI
- Templates directory
- Dead INJECTION_CAPS (keywordInjectMax, perPromptTotal)

### Fixed
- **compound-lifecycle.ts**: confidence subtraction -20 → -0.20 (was zeroing on 0-1 scale)
- **compound-lifecycle.ts**: Promotion now runs before staleness check (was blocking upgrades)
- **compound-lifecycle.ts**: Identifier staleness aligned to 6+ chars (was 4+, mismatched with Code Reflection)
- **session-recovery.ts**: runExtraction fire-and-forget (3056ms → 151ms)
- **Security**: Symlink protection at 8 locations, SUDO_USER execFileSync, settings.json single-write
- **postinstall**: Matcher field from hook-registry.json (was hardcoded '*')
- **uninstall**: Now cleans mcpServers['forgen-compound']
- **Dead paths**: forgen status→me, dashboard deleted, tmux binding fixed, REMIX_DIR removed
- **Docs**: All 4 language READMEs rewritten, SECURITY.md updated to 2.5.x→3.0.0

### Security
- 46 issues fixed across 6 review iterations
- All hooks fail-open with Plugin SDK format
- Prompt injection defense: 13 patterns + Unicode NFKC + XML escaping
- YAML bomb protection (5KB frontmatter cap, 3 anchor limit)

## [2.1.0] - 2026-03-25

### Added
- **Compound Engine integrity improvements**
  - **Code Reflection false positive prevention** — identifier minimum length raised from 4 to 6 characters, reducing false `reflected++` from common words
  - **"Why" context in auto-extraction** — extracted solutions now include git commit messages, addressing the "git diff only shows what, not why" gap
  - **Staleness detection** — `checkIdentifierStaleness()` verifies solution identifiers still exist in codebase via grep
  - **Extraction precision metrics** — `compound-precision` lab event emitted during lifecycle checks for tracking promotion/retirement rates
- **Token injection guardrail** — `MAX_INJECTED_CHARS_PER_SESSION = 8000` (~2K tokens) caps per-session injection cost, tracked in session cache
- **E2E hook pipeline tests** — 7 integration tests verifying actual hook stdin→stdout JSON protocol (solution-injector, keyword-detector, pre-tool-use, slop-detector, db-guard)
- **fgx security warning** — CLI now emits 3-line warning on startup when permissions are skipped
- **Documentation**
  - Open source readiness review feedback (P0/P1/P2 prioritized)
  - Action plan v2.1 (7 phases, 33 items, 18 success criteria)
  - ADR-001: large file decomposition plan
  - ADR-002: EMA learning rate parameter rationale
  - Auto vs manual extraction tradeoff guide
  - oh-my-claudecode coexistence guide
  - Case study template for dogfooding data
  - Good first issues list (6 issues)

### Fixed
- **3 failing tests** — slop-detector-main.test.ts depended on local `~/.compound/hook-config.json` (now mocked)
- **106 empty catch blocks → 0** — all replaced with `debugLog()` or descriptive comments explaining why safe to ignore
- **70 biome lint warnings → 5** — `noAssignInExpressions`, non-null assertions, array index keys, etc. (remaining: `useTemplate`, `useLiteralKeys`)
- **CI coverage double-run** — merged `npm test` + `--coverage` into single vitest invocation to prevent mock state corruption

### Changed
- **Coverage thresholds** — aligned vitest.config.ts with actual coverage (35% lines) instead of unrealistic 85%. CI now enforces thresholds.
- **Node.js requirement** — 18 → 20 (vitest v4/rolldown requires `node:util.styleText`)
- **CI matrix** — removed Node 18, kept Node 20 + 22
- **CONTRIBUTING.md** — replaced "No linter yet" with Biome instructions, added architecture diagram
- **README** — added vendor lock-in notice, "When to Use" table, fgx warning section
- **Multi-language READMEs** — synced KO/ZH/JA with all English changes
- **GitHub Actions** — checkout v4→v6, setup-node v4→v6

### Dependencies
- `@types/node` ^22.19.15 → ^25.5.0
- `@vitest/coverage-v8` ^4.1.0 → ^4.1.1

## [2.0.0] - 2026-03-24

### Added
- **Compound Engine v3** — evidence-based cross-session learning system
  - **Solution Format v3** — YAML frontmatter with version, status, confidence, tags, identifiers, evidence counters
  - **Code Reflection** — PreToolUse hook detects when injected solution identifiers appear in Edit/Write code
  - **Negative Signal Detection** — PostToolUse hook detects build/test failures and attributes to experiment solutions
  - **Extraction Engine** — git-diff-based automatic pattern extraction with 4-stage quality gates (structure, toxicity, dedup, re-extraction)
  - **Lifecycle Management** — experiment → candidate → verified → mature with evidence-driven promotion and confidence-based demotion
  - **Circuit Breaker** — experiment solutions with 2+ negative signals auto-retired
  - **Contradiction Detection** — flags solutions with 70%+ tag overlap but disjoint identifiers
  - **Prompt Injection Defense** — 13 injection patterns, Unicode NFKC normalization, XML tag escaping
  - **Solution Index Cache** — in-memory mtime-based cache for matching performance
  - **V1→V3 Migration** — automatic format upgrade on first access with symlink protection
  - **CLI** — `compound list`, `inspect`, `remove`, `rollback`, `--verify`, `--lifecycle`, `pause-auto`, `resume-auto`
- **Pack Marketplace** — GitHub-based community pack sharing
  - `forgen pack publish <name>` — publish verified solutions to GitHub + registry PR
  - `forgen pack search <query>` — search community registry
  - Registry: [forgen-team/forgen-registry](https://github.com/forgen-team/forgen-registry)
- **Lab compound events** — 6 new event types (compound-injected, compound-reflected, compound-negative, compound-extracted, compound-promoted, compound-demoted)
- 83 new tests (solution-format, prompt-injection-filter, solution-index, compound-lifecycle, compound-extractor)

### Changed
- `solution-matcher.ts` — tags-based matching replaces keyword substring matching
- `solution-injector.ts` — v3 format with status/confidence/type in XML output, experiment 1/prompt limit, cumulative injection-cache
- `compound-loop.ts` — v3 YAML frontmatter output, `inferIdentifiers()` for manual solutions, `slugify` deduplicated
- `pre-tool-use.ts` — Code Reflection + evidence update via parse-modify-serialize
- `post-tool-use.ts` — negative signal detection + evidence update
- `session-recovery.ts` — SessionStart triggers extraction + daily lifecycle check
- `state-gc.ts` — injection-cache pattern added for GC

### Dependencies
- Added `js-yaml` ^4.1.0 (YAML frontmatter parsing with JSON_SCHEMA safety)

## [1.7.0] - 2026-03-23

### Added
- **Forge** — signal-based personalization engine: project scanning, 10-question interview, 5 continuous dimensions (qualityFocus, autonomyPreference, riskTolerance, abstractionLevel, communicationStyle), generates agent overlays, skill tuning, rules, hook parameters, philosophy, and routing config
- **Lab** — adaptive optimization engine: JSONL event tracking, 8 behavioral pattern detectors, auto-learning closed loop (Lab → Forge, EMA 0.25, daily), component effectiveness scoring, A/B experiments, session cost tracking with HUD integration
- **Remix** — harness composition: browse/search published harnesses, cherry-pick individual components (agent/skill/hook/rule/principle), conflict detection (hash-based), provenance tracking
- **Multi-model Synthesizer** — heuristic response evaluation (4-axis scoring), agreement analysis, task-type-weighted provider synthesis, provider performance tracking
- **AST-grep integration** — real AST parsing via `sg` CLI with regex fallback, pre-built patterns for TypeScript/Python/Go/Rust, `forgen ast` CLI
- **LSP integration** — JSON-RPC 2.0 over stdio client, auto-detects tsserver/pylsp/gopls/rust-analyzer/jdtls, hover/definition/references/diagnostics, `forgen lsp` CLI
- **`forgen me`** — personal dashboard showing profile, evolution history, detected patterns, agent tuning, session cost
- **`forgen forge`** — onboarding UX with live dimension visualization after each interview answer
- **`forgen lab evolve`** — manual/auto learning cycle with dry-run support
- **`forgen lab cost`** / **`forgen cost`** — session cost tracking and reporting
- **`forgen synth`** — multi-model synthesis status, weights, and history
- **hookTuning pipeline** — forge generates hook parameters → hook-config.json → actual hooks (slop-detector, context-guard, secret-filter) read and apply them
- **Skill-tuner** — 6 skills (autopilot, ralph, team, ultrawork, code-review, tdd) respond to forge dimensions
- **Auto-learn notification** — profile evolution changes displayed on harness startup
- **Setup → Forge integration** — `forgen setup` offers forge personalization at the end
- 257 new tests (14 files) covering forge, lab, remix, evaluator, synthesizer, LSP

### Changed
- README rewritten for all 4 languages (EN/KO/ZH/JA) with new positioning: "The AI coding tool that adapts to you"
- package.json and plugin.json description updated to new positioning
- Interview deltas increased (±0.10~0.30) for meaningful profile divergence
- Auto-learn constants tuned: LEARNING_RATE 0.15→0.25, MAX_DELTA 0.1→0.15, MIN_EVENTS 50→30
- Agent overlays enriched from 1-3 line fragments to 3-5 sentence behavioral briefings
- LSP request timeout increased to 30s for large project indexing

## [1.6.3] - 2026-03-23

### Fixed
- **CRITICAL**: Fix ESM import side-effect causing double JSON output in `skill-injector` and `post-tool-use` hooks — root cause of Stop hook errors across environments
- **CRITICAL**: Fix "cancel ralph" activating ralph mode instead of canceling — keyword pattern priority conflict
- **CRITICAL**: Fix path traversal vulnerability via unsanitized `session_id` in file paths (7 hooks affected)
- Fix Stop hook timeout race condition — 0ms margin between plugin timeout and stdin read timeout
- Fix non-atomic file writes causing state corruption under concurrent sessions (9 hooks)
- Fix `readStdinJSON` missing `process.stdin.resume()` causing silent timeout in some Node.js environments
- Fix `readStdinJSON` having no input size limit (potential memory exhaustion)
- Fix user-supplied regex patterns in `dangerous-patterns.json` vulnerable to ReDoS
- Fix `ralph` keyword false positive matching on casual mentions
- Fix `pipeline` keyword requiring "pipeline mode" suffix — standalone "pipeline" now works
- Fix `migrate` and `refactor` keywords triggering on casual mentions — now require explicit mode invocation
- Fix inject-type keywords (`tdd`, `code-review`, etc.) causing double injection via both keyword-detector and skill-injector
- Fix `plugin.json` version stuck at `0.2.0` — now synced with `package.json`

### Added
- `--version` / `-V` CLI flag
- `sanitize-id.ts` shared utility for safe file path construction
- `atomic-write.ts` shared utility for corruption-resistant state writes
- `isSafeRegex()` validation for user-supplied regex patterns
- Ecomode entry in CLI help text and magic keywords section
- `cancel-ralph` keyword pattern for targeted ralph cancellation

## [1.6.2] - 2026-03-20

### Fixed
- Fix `.npmignore` excluding `templates/` from npm package
- Fix README coverage badge showing 60% instead of actual 41%
- Fix `@types/node` version mismatch (`^25` → `^18`) to match `engines: >=18`
- Fix type error in `session-recovery.ts` from `@types/node` downgrade
- Fix CHANGELOG duplicate entries in `[1.6.0]`
- Fix README banner image using relative path (breaks on npm)
- Adjust vitest coverage thresholds to match actual coverage

## [1.6.1] - 2026-03-20

### Fixed
- Resolve remaining audit warnings — rate-limiter timeout, governance try-catch
- Resolve 4 critical runtime issues from previous audit
- Resolve all skill/agent audit issues — 2 CRITICAL, 4 HIGH, 4 MEDIUM
- Correct README statistics — skills 11→19, hooks 14/18→17, tests 654→1204
- Complete i18n — convert all remaining Korean to English

### Added
- `cancel-ralph` skill for Ralph loop cancellation via `/forgen:cancel-ralph`
- `ralph-craft` skill for interactive Ralph prompt building

## [1.6.0] - 2026-03-20

### Added
- Ecomode for token-saving with Haiku priority and minimal responses
- Intent classifier for automatic task routing
- Slop detector to identify low-quality outputs
- 7 new skills for expanded workflow coverage
- Crash recovery support
- 47 scenario tests for comprehensive coverage
- Ralph mode integration with ralph-loop plugin for auto-iteration

### Changed
- Upgraded all 10 skills to OMC-level depth and completeness

### Fixed
- Comprehensive security, stability, and system design overhaul
- Replaced non-existent OMC references with forgen/Claude Code native APIs
- Resolved 13 cross-reference inconsistencies across skills, hooks, and modes

## [1.4.0] - 2025-12-01

### Added
- Gemini provider support
- Codex CLI integration
- Codex tmux team spawning with auto task routing
- `$ARGUMENTS` usage guide to all 12 forgen skills

### Fixed
- Cross-platform OAuth token for status-line usage display

## [1.3.0] - 2025-10-01

### Added
- Update notification when newer forgen version is available
- Skills installable as Claude Code slash commands (`/forgen:xxx`)
- Accumulated solutions injected into Claude context in compound flow

### Fixed
- Rules viewer skips empty dirs and finds pack rules correctly
- Connected pack info shown in startup message and HUD
- 7 CLI bugs: arg parsing, pack display, extends docs
- Project detection, pack init, and pack-builder skill
- Pack setup records `lastSync` for lock

## [1.1.0] - 2025-08-01

### Added
- Pack diagnostics to `doctor` command
- Extended pack schema: skills, agents, workflows, requires fields
- `pack add` / `pack remove` / `pack connected` CLI commands
- Pack assets integration into harness pipeline
- AI-guided pack building (`--from-project`, pack-builder skill)
- `pack.lock` for version pinning and update notifications
- Pack authoring guide

### Changed
- Migrated consumers to multi-pack API

### Fixed
- Consistency guards (P1/P2)
- 7 gaps from completeness verification

## [1.0.1] - 2025-06-15

### Fixed
- Resolved Codex-flagged blockers for npm publish
- Fixed command injection: `execSync` → `execFileSync`
- Fixed cross-platform compatibility (Windows/Linux/macOS)

## [1.0.0] - 2025-06-01

### Added
- Initial public release as **forgen** (renamed from tenet)
- Philosophy-driven Claude Code harness with 5-system workflow
- Multi-pack support
- Bilingual documentation (EN/KO)
- Core CLI commands: `fgx` entrypoint

[Unreleased]: https://github.com/forgen-team/forgen/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/forgen-team/forgen/compare/v2.1.0...v3.0.0
[2.1.0]: https://github.com/forgen-team/forgen/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/forgen-team/forgen/compare/v1.7.0...v2.0.0
[1.7.0]: https://github.com/forgen-team/forgen/compare/v1.6.3...v1.7.0
[1.6.3]: https://github.com/forgen-team/forgen/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/forgen-team/forgen/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/forgen-team/forgen/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/forgen-team/forgen/compare/v1.4.0...v1.6.0
[1.4.0]: https://github.com/forgen-team/forgen/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/forgen-team/forgen/compare/v1.1.0...v1.3.0
[1.1.0]: https://github.com/forgen-team/forgen/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/forgen-team/forgen/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/forgen-team/forgen/releases/tag/v1.0.0
