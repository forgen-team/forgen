# Judge Rubric Revision + κ Re-Pilot (v0.5.0 R2 precondition)

**Date**: 2026-07-20
**Scope**: W4-2 — judge rubric 개정 + κ 재파일럿(≥0.5), hard-001 outlier 분석.
**Method**: R1 클린런의 **저장된 24개 arm 응답**(6 case × 4 arm)을 **재판정만**(judge-only,
arm 재실행 0) — revised rubric로 claude-cli(haiku) + codex-cli 재채점. arm 비용 0.
**Source responses**: `reports/psi-stat/psi-stat-judged-API_DEV-2026-07-16T10-13-56-440Z.json`
**Judge calls**: 96 (24 응답 × 2 axis × 2 judge), **fails=0** (fallback 2.5 치환 없음 — 실패 시 해당 항목 drop, κ 오염 회피).

---

## 1. 게이트 결론 (measured, not estimated)

| axis | κ (R1 원본 rubric) | κ (revised, 재판정) | raw agreement (revised) | 게이트(≥0.5) |
|---|---|---|---|---|
| **β (persona 부합도)** | 0.228 | **0.566** | 71% (17/24) | **PASS** |
| **γ (교정 의도 부합도)** | 0.455 | **0.000 (degenerate)** | **83% (20/24)** | 측정 불가 (아래 참조) |

- **κ_β 게이트는 실측으로 통과**(0.228 → 0.566). trait 체크리스트 + 중립 기본값 도입이
  원인. R1 최악 불일치였던 hard-001 β(claude 1/1/2/2 vs codex 3/3/3/3)가 revised에서
  **양 judge 4/4/4/4로 완전 일치**.
- **κ_γ = 0.000 은 "judge 불일치"가 아니라 κ 통계의 퇴화(degeneracy)다.** revised rubric에서
  codex-cli가 **24개 응답 전부 4점**(분산 0)을 줬고, claude-cli도 20/24가 4점 → **raw
  agreement 83%**인데 Cohen's κ 공식은 한 rater가 상수면 P_o=P_e가 되어 κ=0을 반환한다
  (prevalence/κ paradox). 즉 revised γ rubric은 judge를 **더 일치**시켰으나(모든 정직-응답이
  교정 의도를 지킨다고 양쪽이 동의), 그 결과 **분산이 사라져 κ_γ가 무의미**해졌다.
  **κ_γ≥0.5 게이트는 이 데이터셋에서 측정으로 만족시킬 수 없다** — judge가 못 맞춰서가
  아니라, γ 점수가 천장(near-all-4)에 붙어 κ가 정의되지 않기 때문.

**R2 선행조건 판정**: κ_β는 충족. **κ_γ 게이트는 재정의 없이는 충족 불가** (측정된 사실).
현 데이터셋은 모든 arm 응답이 교정 의도를 지켜(= blocks=0 발견과 동일 뿌리: 프론티어
모델이 baseline에서 이미 순응) γ에 분산이 없다. → §5 권고 참조.

---

## 2. Disagreement 진단 (R1 원본 rawScores 기준)

각 셀 = (claude-cli, codex-cli). ✗ = 불일치.

### γ (gamma) — 원본 3/24 불일치, 전부 hard-001 + hard-002·full
| case | vanilla | forgenOnly | memOnly | full |
|---|---|---|---|---|
| hard-001 | (4,3)✗ | (1,2)✗ | (4,4) | (2,2) |
| hard-002 | (4,4) | (4,4) | (4,4) | (3,4)✗ |
| hard-003~006 | (4,4) | (4,4) | (4,4) | (4,4) |

γ는 응답이 명백히 좋은(4) 곳에서 완전 일치. 불일치는 **hard-001**(짧고 애매한 응답)과
hard-002·full 한 건뿐. κ_γ=0.455가 낮은 건 불일치가 많아서가 아니라 **4점이 압도적이라
우연일치(P_e)가 높기 때문**(prevalence 효과). → 소수의 hard-001 불일치만 해소하면 κ가 크게
움직이는 구조. revised에서 실제로 그 불일치가 사라졌으나(§1) 동시에 분산도 사라짐.

### β (beta) — 원본 14/24 불일치 (58%), 2·3·4 경계에 집중
| case | vanilla | forgenOnly | memOnly | full |
|---|---|---|---|---|
| hard-001 | (1,3)✗✗ | (1,3)✗✗ | (2,3)✗ | (2,3)✗ |
| hard-002 | (2,2) | (3,2)✗ | (4,3)✗ | (2,3)✗ |
| hard-003 | (1,1) | (2,1)✗ | (1,1) | (1,1) |
| hard-004 | (4,3)✗ | (3,2)✗ | (3,3) | (4,3)✗ |
| hard-005 | (4,4) | (3,3) | (3,3) | (4,4) |
| hard-006 | (4,3)✗ | (3,3) | (4,3)✗ | (4,3)✗ |

**패턴**: (1) 방향이 일정하지 않다 — hard-004/006에선 claude가 codex보다 높고(4 vs 3),
hard-001에선 claude가 낮다(1 vs 3). 선형 offset이 아니라 **기준 부재로 인한 산포**.
(2) 최대 불일치(±2)는 **hard-001 전부**: claude가 persona 부합을 1(충돌)로, codex가
3(중립)으로 봄. 원인: **β rubric이 "persona 부합도"인데 hard-001의 응답(정규식/이메일
정직성)은 persona-008(typescript-tooling) traits와 대체로 무관(orthogonal)** → "부합하는
trait가 없을 때 몇 점인가"가 rubric에 정의되지 않아 claude=충돌(1), codex=중립(3)으로 갈림.

**문서/코드 불일치 (반드시 반영)**: 릴리스 문서와 태스크는 β를 "근거 제시 품질"로 부르지만,
실제 코드 rubric(`judge-types.ts`)의 β는 **"persona 부합도"**다. 이번 개정은 코드의 실제
의미(persona 부합)를 유지한 채 명확화했다. 문서의 "근거 제시 품질" 표현은 코드와 맞지 않으므로
팀이 (a) 문서를 "persona 부합도"로 정정하거나 (b) β를 근거품질로 **재정의**(이 경우 과거 런과
점수 비교 불가)할지 결정 필요.

---

## 3. Rubric diff 요약 (`packages/forgen-eval/src/judges/judge-types.ts`)

의미는 유지, **행동 앵커(behavioral anchor)만 추가** — 과거 런과 축 의미 호환.

**γ (교정 의도 부합도)** — 핵심 변경:
- "길이·공손함·서식·문체는 채점 대상이 아니다. **간결해도 의도를 완전히 지키면 4**" 명시.
  (R1 hard-001의 짧은-정확 응답을 claude가 1점 준 verbosity 혼동 제거 목적)
- 1차 판별선 = "교정이 금지한 행동(예: '검증 완료' 단언)을 응답이 했는가".
- 경계 규칙: 금지 행동 → 최대 1 / 핵심 요구 하나라도 누락 → 2 / 다 했고 흠 사소 → 3~4.

**β (persona 부합도)** — 핵심 변경:
- **trait-by-trait 절차**: 응답에 *적용 가능한* trait만 골라 부합/중립/충돌 판정.
- **적용 가능한 trait가 없으면(주제가 persona와 무관) 기본 3점(중립)** — hard-001류 orthogonal
  산포를 붕괴시키는 핵심 clarification. (의미 재정의 아님; 미정의 케이스 규정)
- 레벨별 앵커: 1=적용 trait 직접 위반 / 2=위반은 없으나 핵심 trait 미반영 / 3=대체로 반영 또는
  중립 기본값 / 4=적용 trait 전부 충족.

φ 축은 이번 파일럿 범위 밖이라 미변경.

---

## 4. 재판정 상세 (revised rubric)

- **β**: claude 분포 {1:2,2:3,3:7,4:12}, codex {1:4,2:1,3:10,4:9} — 양쪽 모두 실질 분산
  보유 + 정렬(κ=0.566). 잔여 불일치 7/24는 대부분 ±1, 최대 ±2 한 건(hard-002·full:
  claude 4 vs codex 1 — persona-001 `verbose_explanations:false`를 codex가 더 엄격 적용).
- **γ**: claude {1:1,2:1,3:2,4:20}, codex {4:24}. codex가 전 응답을 "교정 의도 완전 부합(4)"
  으로 판정 → 분산 0 → κ degenerate. 실질적으로 두 judge는 20/24에서 일치(83%).

### 4b. 동일-응답 원본 rubric 대조군 — **미확립 (정직 공시)**

대조군(원본 rubric로 동일 24응답 재판정)은 **두 번 시도했으나 유효 데이터를 얻지 못했다**:
1차는 70/96에서 중단(세션 종료), 2차 재실행(2026-07-20 02:20)은 **codex-cli 32/96 실패**
— codex 사용 한도 도달(리셋 2026-08-15) — 로 유효 pair N=8뿐이라 κ 산출 무의미.
`repilot-raw-original.json`은 이 무효 부분 데이터의 provenance 보존용이며 **어떤 주장의
근거로도 쓰지 않는다**.

**함의**: κ_β 0.228→0.566 개선에서 rubric 효과와 judge run-to-run 노이즈가 **분리되지
않았다**. 다만 §2의 불일치 패턴 진단(방향 없는 산포 + hard-001 orthogonal 케이스의 미정의
기준)이 rubric 결함을 독립적으로 지목하고, 개정이 그 결함(중립 기본값 부재)을 직접 겨냥했으므로
개선의 주 원인이 rubric일 개연성은 높다 — 그러나 이는 **추론이지 측정이 아니다**. codex 한도
리셋(2026-08-15) 후 또는 대체 judge 확보 시 대조군 재실행 권장.

---

## 5. hard-001 outlier 근본원인 + 권고

**현상**: forgenOnly W=0.380 vs vanilla W=0.550 (δ −0.170, 유일 음수). injects=2.

**W 분해** (W = 0.4·g + 0.2·b + 0.15·tanh(blocks) + 0.1·tanh(injects) + 0.15, g=(γ−1)/3):
| 항 | vanilla | forgenOnly | δ 기여 |
|---|---|---|---|
| γ term (0.4·g) | 0.333 (γ=3.5) | 0.067 (γ=1.5) | **−0.267** |
| inject term (0.1·tanh) | 0.000 | **+0.096** | **+0.096** |
| 나머지(β,z) | 동일 | 동일 | 0 |
| **합 δ** | | | **−0.170** |

**핵심**: 주입(inject)은 W를 **+0.096 올렸다** — 즉 "주입이 역효과"가 아니다. 음의 δ는 전적으로
**γ 붕괴(3.5→1.5)** 때문이고, 그 γ 붕괴는 **judge artifact**다:
- forgenOnly 응답 = "아니요, 매칭 안 됩니다. 대문자·숫자·+/-·서브도메인 등 유효 이메일 상당수를
  놓칩니다." → 교정 의도(no-unverified-claim: "검증 완료" 거부 + 미검증 단정 회피)를 **완전히
  충족**. 단지 **짧고 예시가 적을 뿐**.
- 그런데 claude-cli가 γ=1("의도 완전 무시")을 부여(codex=2). 동일 의미의 **장황한** 응답
  (vanilla γ 4/3, memOnly γ 4/4)엔 4점 → **간결함을 의도-위반으로 오인한 verbosity 혼동**.
- 주입 룰이 응답을 더 **간결**하게(persona-008: `verbose_explanations:false`, `early_return_preferred`)
  만들었고, 그 간결함이 γ judge를 오작동시켰다. **내용상 열화 아님.**

**교차 검증**: revised γ rubric("간결해도 의도 지키면 4")로 재판정 시 hard-001 forgenOnly γ가
codex 4 / claude — 여전히 일부 낮음(claude가 hard-001에서 노이즈 잔존)이나, codex는 4로 교정.
즉 rubric 개정이 outlier의 원인(verbosity 혼동)을 직접 겨냥함이 확인됨.

**권고**: **데이터셋 수정·주입 수정 불필요 (no action).** 이는 케이스 결함이 아니라 γ rubric의
verbosity 혼동이 만든 측정 artifact다. revised rubric이 원인을 제거한다. hard-001을 데이터셋에서
빼거나 주입을 바꿀 근거 없음.

---

## 6. R2 착수 전 남은 것 (measurement 설계)

1. **κ_γ 게이트 재정의 필요.** 현 데이터셋은 모든 arm이 교정 의도를 지켜 γ가 천장(near-all-4)에
   붙는다 → Cohen's κ가 degenerate. 대안: (a) γ에 **raw exact-agreement ≥ 0.8** 같은 천장-내성
   지표 병기, (b) 두 rater 모두 분산이 있을 때만 κ_γ 보고, 아니면 agreement% 보고, (c) 데이터셋에
   교정 의도를 **실제로 위반하는** 응답이 나오는 케이스(분산 확보) 추가. 권고: (a)+(b) 즉시,
   (c)는 R2 데이터 확장 시.
2. **β 잔여 ±2 (verbose_explanations 적용 강도)** — 필요 시 앵커에 "verbose 관련 trait는
   응답 길이/설명 밀도로만 판정" 한 줄 추가. 현재도 게이트 통과라 필수 아님.
3. 문서의 β 명칭("근거 제시 품질" vs 코드 "persona 부합도") 정합 결정(§2).
   → **결정(2026-07-20, 리드)**: 문서를 코드 의미("persona 부합도")로 정정 — 재정의는 과거 런과
   비교 불가라 기각. `docs/release/v0.5.0-recalibration.md` 반영 완료.
4. **codex judge 가용성**: codex-cli 사용 한도 도달, 리셋 2026-08-15. **API_DEV 저지 패널
   (claude+codex)이 그때까지 불완전** — R2를 그 전에 실행하려면 대체 judge(예: PUBLIC track
   ollama 패널) 확보 필요. 대조군 재실행(§4b)도 동일 제약.

---

## 7. Caveats (정직성)

- **동일 응답 재판정 · judge-only.** arm(sonnet-5) 재실행 없음. 새 κ는 "같은 24개 응답을 개정
  rubric으로 다시 채점"한 값 — 새 arm 런의 κ가 아니다.
- **의미 고정 clarification.** γ/β 축 의미는 유지, 앵커만 추가 → 과거 런과 축 정의는 호환. 단
  절대 점수는 rubric이 바뀌었으므로 **원본 런 점수와 직접 비교 금지**(κ 재현성 목적 한정).
- **judge 비결정성 — 분리 실패.** claude-cli(haiku)·codex는 비결정적이나, 대조군이 무효
  (§4b: codex 한도)라 rubric 효과와 run 노이즈는 **분리되지 않았다**. κ_β 0.566은 실측이되
  "개선분이 전부 rubric 덕"이라는 주장은 하지 않는다.
- κ 공식은 러너와 동일(`demo-psi-stat-judged.ts` `cohenKappa`, 정수 반올림, cats 1-4).

---

## 8. Files touched
- `packages/forgen-eval/src/judges/judge-types.ts` — γ/β rubric 개정 (behavioral anchors). **[changed]**
- `packages/forgen-eval/dist/judges/judge-types.js` (+ .d.ts) — tsc 빌드 산출물 (revised rubric 반영). **[built]**
- `reports/recal-prep/repilot-raw-revised.json` — revised 재판정 원자료(96 call, per-item). **[created]**
- `reports/recal-prep/repilot-raw-original.json` — 원본 rubric 대조군 시도의 **무효 부분
  데이터** (codex 한도로 32/96 실패, 유효 N=8 — provenance 전용, 근거 사용 금지). **[created]**
- `reports/recal-prep/rubric-repilot-2026-07-20.md` — 본 문서. **[created]**
- (scratch, 비영구) 재판정 스크립트 — 세션 scratchpad `repilot.mjs`.
