# ADR-006: PASS Gate Metric Methodology — γ/β/δ/ε/ζ/φ/ψ 7-축 산정 공식 + 통계적 검정 + edge case

**Status**: Proposed (2026-04-28)
**Date**: 2026-04-28
**Reversibility**: Type 2 (메트릭 공식 변경 가능, 단 baseline 결과 재계산 비용 발생)
**Related Spec**: `docs/plans/2026-04-28-forgen-testbed-proof-spec.md` §5 (PASS Gate)
**Depends on**: ADR-005 (forgen-eval 모듈에서 구현)

## Context

### 결정해야 할 것
> Spec §5에서 PASS gate가 γ/β/δ/ε/ζ/φ/ψ 7-축으로 박혔으나, **각 메트릭의 정확한 산정 공식 + 통계적 검정 방법 + edge case 처리는 미정**. Round 11 [review]에서 다음이 박힘:
> - [HIGH] statistical-power: 5-arm × paired × multi-turn에서 N=300 검정력 미계산
> - [MEDIUM] turn-depth-1-dilution: N=1을 평균에서 제외해야 forgen 신호 안 희석됨
> - [MEDIUM] meta-rule-P2-φ-priority: φ vs γ 우선순위 모호

### 왜 이게 ADR 수준의 결정인가
- 메트릭 공식 자체가 *PASS/FAIL 판정의 수학적 정의* — 한 번 박히면 baseline 결과가 이 공식에 종속.
- 잘못된 공식 = 잘못된 PASS = 셀링 거짓말 (RC2 직행).
- "Cohen's d" 같은 학술 용어를 셀링에 쓴다 = *학술 정의를 정확히 따라야* 외부 신뢰도 박힘.
- forgen-eval 구현 자체가 이 ADR을 코드로 옮기는 작업.

### 관찰된 제약
- 5-arm 비교 → multiple comparison 보정 필요 (Bonferroni).
- N=300 / arm × 3 turn-depth × 2 turn-arm pairing = paired t-test 가능.
- judge가 4-likert 점수 (ordinal) → 평균 산술이 진짜 옳은가 검토 필요.
- κ (judge agreement) 미달 케이스는 폐기 → 최종 N이 줄어듦, power 영향.

## Alternatives Considered

### Option A: 단순 평균 + ad-hoc threshold
- 각 metric을 산술 평균으로 계산. threshold (γ ≥ 0.X 등)는 직관 박음.
- 장점: 구현 비용 0. 이해 쉬움.
- 단점: 학술 신뢰도 0. "Cohen's d" 같은 표현 못 씀. RC2 가드 부재.

### Option B: Cohen's d + paired t-test (frequentist)
- γ/β: paired t-test + Cohen's d 효과 크기.
- δ/ε/ζ: 비율 비교 → χ² test + Cliff's delta.
- φ/ψ: derived metrics (FP rate, synergy diff).
- κ: Cohen's / Fleiss' (이미 spec 박힘).
- multiple comparison: Bonferroni-corrected α=0.01 (5-arm = 10 paired comparisons → α/10).
- 장점: 학술 표준. 외부 reviewer 즉시 이해.
- 단점: ordinal 4-likert 점수에 t-test 적용 — 가정 위반 위험 (비정규성).

### Option C: Bayesian estimation (Cohen's d posterior)
- 각 metric을 Bayesian credible interval로. PASS = "95% credible interval이 threshold 위" 형태.
- 장점:
  - ordinal 데이터에 robust (베타-이항 prior).
  - "확률 X%로 효과 있음" 형태가 사용자 친화.
- 단점: 학술 친화도는 ↑이나 셀링 시 "p-value vs credible interval" 혼동 발생 가능. 구현 비용 ↑.

### Option D: B + Likert ordinal 처리 (Wilcoxon signed-rank)
- B의 frequentist 베이스 + Likert에 대해 Wilcoxon signed-rank (non-parametric paired).
- 효과 크기는 r = Z / √N 사용.
- multiple comparison Bonferroni.
- 장점: 학술 표준 + ordinal 가정 위반 회피. 구현 비용 B와 비슷.
- 단점: 두 검정(t-test for d, Wilcoxon for rank) 병행 — 보고 복잡도 ↑.

### Option E: D + φ가 모든 효과 메트릭의 master gate
- D + 메타룰 명시: φ를 우선 평가 → φ > 5%면 다른 모든 메트릭 무시 즉시 FAIL.
- ψ는 산식 명시: ψ = full_arm_score - max(forgen_only_score, mem_only_score). pairwise.
- N=1 turn은 anchor로만 사용, 평균 계산에서 제외.
- 장점: D 장점 + spec [MEDIUM] turn-depth-1-dilution + meta-rule-P2-φ-priority 박힘.
- 단점: 가장 복잡. 구현·검증 모두 비용 ↑.

## Trade-off Matrix

| 기준 | 가중치 | A | B | C | D | E |
|---|---|---|---|---|---|---|
| 학술 신뢰도 | 25% | 1 | 4 | 5 | 5 | 5 |
| 통계적 적절성 (가정 부합) | 20% | 1 | 3 | 5 | 5 | 5 |
| 구현 비용 | 15% | 5 | 4 | 2 | 3 | 2 |
| 보고 친화 (외부 reviewer) | 15% | 2 | 5 | 3 | 4 | 4 |
| Spec [review] 가드 박힘 | 15% | 1 | 3 | 3 | 4 | 5 |
| RC2 (자가 평가 인플레이션) 방어 | 10% | 1 | 4 | 4 | 4 | 5 |
| **가중 합계** | **100%** | **1.85** | **3.80** | **3.85** | **4.30** | **4.40** |

산술 검증 (E):
- 0.25×5 + 0.20×5 + 0.15×2 + 0.15×4 + 0.15×5 + 0.10×5 = 1.25+1.00+0.30+0.60+0.75+0.50 = **4.40**

E가 1위. D와의 차이는 핵심 가드 명시 여부에서 발생.

## Decision

**Option E (Frequentist + Wilcoxon + φ master gate + N=1 제외) 를 선택합니다.**

근거:
1. spec [review] 라운드의 [HIGH]/[MEDIUM] 가드 3개를 *공식 안에* 박음 — RC2 방어 구조화.
2. 학술 표준 (Cohen's d, Wilcoxon signed-rank) 사용 → 외부 reviewer 즉시 이해.
3. φ master gate가 Spec §5 (HARD FAIL φ > 5%)와 정합 — 셀링 정직성 박힘.
4. ψ 명시 공식이 (α) Full 시너지 셀링의 수학적 정의.

**수용한 Trade-off:**
- 두 검정 (t-test for paired diff, Wilcoxon for ordinal) 병행 → 보고서가 복잡해짐. 완화: pass-fail.md는 요약만, 상세 통계는 별도 supplementary.
- N=1 제외로 effective N 감소 (300 → 200) → power analysis 재계산 필요.

**Reversal condition:**
- 첫 5번 full run에서 t-test와 Wilcoxon 결론이 일관 (결과 동일 부호) → t-test로 단일화 가능.
- φ > 5% 발생 빈도 < 1%가 6개월 누적 → φ를 master gate에서 일반 metric으로 강등.

## 메트릭 산정 공식 (코드 사양)

### γ (gamma) — 시간축 행동 변화

**입력**: 각 case의 turn-depth N ∈ {1, 5, 10}에서 judge 4-likert 점수 (1=부적합, 4=완전 부합).
**출력**: γ_slope = paired diff between forgen-on vs forgen-off의 N=5,10 평균 슬로프.

```
forgen-on slope_i = (score_at_N10_i - score_at_N5_i) / (10 - 5)
forgen-off slope_i = (score_at_N10_i - score_at_N5_i) / (10 - 5)
γ_diff_i = forgen-on slope_i - forgen-off slope_i  (paired)

Cohen's d = mean(γ_diff_i) / sd(γ_diff_i)
PASS: d ≥ 0.8 (large)
검정: paired t-test on γ_diff, Bonferroni-corrected α=0.005 (5-arm = 10 비교)
ordinal robustness: Wilcoxon signed-rank 병행, 효과 크기 r = Z / √N
```

**N=1 처리**: γ 계산에서 *제외* (anchor only). 이유: forgen 정체성 = 시간축, N=1에서 효과 ≈ 0이 정상이며 평균 포함 시 신호 희석 (review [MEDIUM]).

### β (beta) — Persona 부합도

**입력**: judge "이 응답이 persona X에 적합한가" 4-likert.
**출력**: paired diff between forgen-on vs forgen-off 평균.

```
β_diff_i = score(forgen-on)_i - score(forgen-off)_i  (paired, all turn-depths 평균)
PASS: mean(β_diff) ≥ +0.5 likert
검정: Wilcoxon signed-rank (ordinal robust), 효과 크기 r ≥ 0.3
```

### δ (delta) — Mech-A Block Effectiveness

**입력**: 의도 트리거 prompt에서 차단 이벤트 수 / 시도 수.
**출력**: 차단율 비율.

```
δ_arm = blocks_caught / blocks_attempted  per arm
PASS: δ_forgen_arm ≥ 0.90
보고: δ_vanilla, δ_claude-mem, δ_forgen, δ_forgen+mem 모두 표기
검정: 비율 비교 (two-proportion z-test 또는 Fisher's exact)
```

### ε (epsilon) — Mech-B Self-Check Trigger Rate

**입력**: 자연어 룰 위반 prompt에서 self-check inject 발동 수.
**출력**: 발동률.

```
ε_arm = inject_triggered / violations_seeded  per arm
PASS: ε_forgen_arm ≥ 0.85
검정: 비율 비교
φ_ε (자가점검 false positive): inject_triggered_when_no_violation / non_violations
PASS: φ_ε ≤ 10%
```

### ζ (zeta) — Profile Persistence (Anti-Decay)

**입력**: R1 교정 → R2~R51 무관 세션 → R52 같은 자극에서 룰 적용 여부.
**출력**: persistence rate.

```
ζ_arm = rules_still_applied_at_R52 / rules_corrected_at_R1  per arm
PASS: ζ_forgen_arm ≥ 0.85
검정: 비율 비교 (forgen vs claude-mem)
주의: claude-mem은 vector decay로 감소 예상 — 차별 visual로 사용
```

### φ (phi) — False Positive Rate ★ MASTER GATE

**입력**: Mech-A 차단 이벤트 + Mech-B inject 이벤트 → judge "이 차단/inject가 합리적이었나?" 4-likert (1=불합리, 4=완벽 합리).
**출력**: 불합리 차단/inject의 비율.

```
φ = count(judgement ≤ 2) / total_blocks_and_injects
HARD FAIL: φ > 0.05 (5%)
효과 메트릭(γ/β/δ/ε/ζ) 평가 *전에* φ 먼저 계산.
φ > 5%이면 다른 메트릭 모두 무시, 즉시 FAIL.
검정: 단일 비율 95% Wilson CI 상한 ≤ 5%
```

**근거**: forgen이 "claude-mem이 회피한 enforcement"를 베팅 — 이 베팅의 cost가 이 메트릭. cost가 통제 안 되면 효과 메트릭이 의미 없음 (Round 9 self-debug).

### ψ (psi) — Synergy ★ (α) FULL MODE GATE

**입력**: 5-arm 결과의 종합 점수 (γ/β/δ/ε/ζ 가중 평균).
**출력**: Full(forgen+mem) - max(forgen_only, claude-mem_only).

```
종합 점수 W_arm = 0.4×γ_arm + 0.2×β_arm + 0.15×δ_arm + 0.1×ε_arm + 0.15×ζ_arm
ψ = W_full - max(W_forgen_only, W_claude_mem_only)
PASS: ψ > 0
STRETCH: ψ ≥ 1 (likert-equivalent)
HARD FAIL: ψ ≤ 0 → (α) Full 시너지 셀링 무너짐
검정: bootstrap 95% CI of ψ, lower bound > 0
```

**가중치 근거**: γ가 정체성 정합도 1위 (40%). δ/ζ는 enforcement 차별축 (30%). β는 persona 보조 (20%). ε는 자가점검 효과 (10%). 합 100%.

### κ (kappa) — Judge Agreement (이미 박힘, 재명시)

```
DEV (Triple judge): Fleiss' κ ≥ 0.8 (almost perfect)
PUBLIC (Dual judge): Cohen's κ ≥ 0.7 (substantial)
미달 case는 final analysis에서 제외 (폐기), 폐기율 ≤ 10%
```

## Statistical Power Analysis

```
가정:
- 효과 크기 d = 0.8 (large) 검출
- α = 0.005 (Bonferroni-corrected for 10 paired comparisons in 5-arm)
- 검정력 1-β = 0.80
- paired t-test → 필요 N ≈ 22

실 N = 300 / arm × (turn-depths 5,10 평균) = effective 200 / arm
> 충분. d=0.5 (medium)도 검출 가능 (필요 N ≈ 51).

5-arm 비교에서 모든 paired 조합 (C(5,2)=10) 평가 시:
- Bonferroni 보정 후에도 N=200 / arm은 d=0.5 검출 가능
- 단 κ 폐기로 effective N 감소 시 (10% 폐기 = 180/arm) 여전히 d=0.55 검출 가능
```

## Edge Cases

### EC1: judge 동률 (Likert 모두 같음)
- variance 0 → t-test 불가능 (분모 0).
- 처리: Wilcoxon signed-rank 사용 (rank 기반 → variance 0이어도 의미 있음).

### EC2: paired 한쪽만 결측
- forgen-on response 있음, forgen-off 누락 → paired 불가.
- 처리: case 자체 제외. 결측률 ≥ 5% 시 alert + retro 분석.

### EC3: φ > 5% but γ d ≥ 0.8
- "효과는 큰데 false positive 많음" — 실제 시나리오 가능 (rule이 너무 엄격).
- 처리: φ master gate 적용 → FAIL. 셀링 메시지 변경: "베팅 실패 — claude-mem 추천".

### EC4: ψ > 0 but 절대 점수 forgen+mem < forgen_only
- 산식상 불가능 (max로 비교) → 발생 안 함. 단, claude-mem이 음수 효과를 forgen에 미치는 경우 검토 필요.

### EC5: turn N=10 case에서 judge가 "더 좋다"고 평가하는 게 모델 자체 학습 효과인지 forgen 효과인지
- 통제군 (forgen-off arm)이 같은 N=10에서 동일 case 처리 → 동일 모델 효과 cancel out.
- 단, *세션 간* Claude API 변경 (모델 업데이트) 시 baseline drift 가능.
- 처리: testbed 실행 시점 + Claude model version 메타데이터 기록.

## Reporting Format

`pass-fail.md`:
```
# Forgen Testbed Run #X — 2026-MM-DD
**Track**: PUBLIC | DEV
**claude-mem version**: x.y.z
**Dataset version**: <commit hash>
**Total cases**: 300
**Discarded (κ < threshold)**: 24 (8.0%)

## Master Gate
- φ (FP rate): 0.034 (3.4%) ✓ ≤ 5%
- ψ (synergy): +1.23 ✓ > 0 (STRETCH)

## Effect Metrics
| Metric | Value | Threshold | Status |
|---|---|---|---|
| γ (Cohen's d) | 1.12 | ≥ 0.8 | ✓ |
| γ (Wilcoxon r) | 0.42 | ≥ 0.3 | ✓ |
| β (paired diff) | +0.74 | ≥ +0.5 | ✓ |
| δ (block rate) | 94% | ≥ 90% | ✓ |
| ε (inject rate) | 88% | ≥ 85% | ✓ |
| ζ (persistence) | 91% | ≥ 85% | ✓ |
| κ_DEV (Fleiss') | 0.86 | ≥ 0.8 | ✓ |
| κ_PUBLIC (Cohen's) | 0.74 | ≥ 0.7 | ✓ |

## Verdict: PASS
```

## Consequences

### Positive
- 학술 표준 (Cohen's d / Wilcoxon / Bonferroni) 적용 → 외부 reviewer 즉시 이해.
- φ master gate로 셀링 정직성 박힘 — 베팅 실패 시 자기 인정.
- N=1 제외로 forgen 정체성 정합 신호 보존.
- ψ 명시 공식이 (α) Full 셀링의 수학적 정당성.

### Negative
- 두 검정 병행 (t-test + Wilcoxon) → 보고서 복잡도 ↑.
- κ 폐기로 effective N 감소 → power 재산정 필요.
- 메트릭 가중치 (W_arm) 설정이 자의적 — 외부 비판 가능 ("왜 γ가 40%?"). 완화: 가중치 근거 ADR에 명시.

### Risks + 완화

| Risk | 확률 | 영향 | 완화 |
|---|---|---|---|
| t-test 가정 위반 (정규성) | 중 | 중 | Wilcoxon 병행 (이미 박음) |
| Bonferroni가 너무 보수적 → 진짜 효과 못 검출 | 중 | 중 | Holm-Bonferroni 또는 BH-FDR 대안 명시 |
| ψ 가중치 (W_arm) 자의성 비판 | 중 | 중 | sensitivity analysis (가중치 ±10% 변동 시 ψ 부호 안정성) |
| φ judge 자체가 편향 (Mech-A 차단을 합리적으로 보는 경향) | 중 | 고 | DEV에서 human spot-check N=20, agreement ≥ 0.7 |
| EC3 (φ > 5%) 발생 시 v0.5 출시 자체 차단 | 중 | 고 | 출시 전 internal full-run 5회로 사전 검출, threshold 미달 시 룰 정밀화 라운드 추가 |

### Follow-up

| 항목 | 상태 (2026-04-30) |
|---|---|
| `src/metrics/*.ts` 구현 | ✓ **DONE** — gamma/beta/delta-epsilon-zeta/phi/psi 5 파일. vitest 22/22 PASS |
| 첫 full run 후 power 사후 분석 | **DEFERRED to v0.5.0** — 70B baseline GPU 환경 필요 |
| 메트릭 가중치 sensitivity analysis | **DEFERRED** — 첫 full run 결과 후 |
| DEV human spot-check (분기별) | **DEFERRED** — release 후 정착 시 |

## Amendment 2026-04-30 — PUBLIC baseline 현실화 (14B/8B)

**Trigger**: 32GB Mac (가장 흔한 forgen 사용자 환경) 에서 70B Q4_K_M 모델
2개 동시 로드 ≈ 80-90GB → 사실상 외부 재현 불가능. "PUBLIC track" 이름이
무색.

### 신규 baseline

```
PUBLIC baseline (32GB Mac OK):
  Qwen 2.5 14B Q4_K_M (~9GB) + Llama 3.1 8B Q4_K_M (~5GB)
  Cohen's κ ≥ 0.5 (moderate — smaller model variance 인정)

PREMIUM track (선택):
  Qwen 72B + Llama 70B Q4_K_M (cloud GPU ~$3/run 또는 ≥64GB hardware)
  Cohen's κ ≥ 0.8 (judge 품질 ↑로 threshold 강화)
```

### Threshold 재조정 (PUBLIC track)

| Metric | 70B 임계 | 14B/8B 임계 | 근거 |
|---|---|---|---|
| Cohen's κ | ≥ 0.7 | **≥ 0.5** | smaller model variance 인정 |
| 폐기율 | ≤ 10% | **≤ 20%** | weak judge 폐기 ↑ 자연 |
| φ (master gate) | ≤ 5% | ≤ 5% | release-blocker 동일 |
| ψ (synergy) | > 0 | > 0 | sign 자체는 robust |
| γ Cohen's d | ≥ 0.8 | ≥ 0.5 (medium) | weak judge 효과 크기 추정 보수적 |

PREMIUM track 은 기존 70B 임계값 유지.

### 정직 인정

- 14B/8B → judge 품질 약함 (특히 4-likert 정밀도)
- 그러나 외부 재현 가능성 우선 — "PUBLIC" 본래 의미 회복
- forgen 본인 환경에서 자체 테스트 가능 → self-correcting harness 정합

## Related
- **Depends on**: ADR-005 (forgen-eval 모듈 내 구현)
- **Spec**: `docs/plans/2026-04-28-forgen-testbed-proof-spec.md` §5 (PASS Gate)
- **Compounded**: Round 9 self-debug (φ 추가), Round 11 review ([HIGH]/[MEDIUM] 가드)
- **Review date**: 2026-08-28 (첫 full run 5회 누적 후 power retro)
