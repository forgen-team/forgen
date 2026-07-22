# W3-2 설계 — 교정 클러스터링 → 룰 승급 (구현 전 논의)

> 2026-07-22. Wave 3 후보 중 사용자 선택. **실 데이터 검증 완료 + 기존 파이프라인 실측
> 대조.** 핵심: 로드맵이 상상한 범위의 대부분(모순감지·provenance·승급·중복제거)이 이미
> 있고, **진짜 신규 델타는 2개**(의미 클러스터링 + 반복→강도 신호)뿐이다.

## 0. 데이터 검증 (이 기능이 필요한가 — W2-3 규율 적용)

`~/.forgen/me/behavior/` 87 evidence 실측:
- behavior_observation 64 · **explicit_correction 13** · session_summary 10
- axis 분포: communication_style 48, judgment_philosophy 24, quality_safety 5, autonomy 2

**13 교정 중 의미 클러스터 3개 실재** (문구·target 다르나 같은 원칙):

| 클러스터 (원칙) | axis | 반복 | 현재 저장 상태 |
|---|---|---|---|
| "존재 ≠ 완성 — 실제 검증 후 완료 선언" | quality_safety | ~3 | **3개 별도 룰**로 흩어짐 (라우트존재/프로덕션확인/청크비판리뷰) |
| "로컬·저가 기본모델 금지, Claude/Codex만" | judgment | ~3 | 개별 교정 (일부만 룰화) |
| "최소구현 말고 깊게 / '이미 있다' 치부 금지" | judgment | ~2 | 2개 별도 룰 |

→ W2-3와 달리 **가치가 소규모에서도 발현**한다: 중복 룰이 *지금* 존재하고, "사용자가 3번
교정했다"는 반복 신호가 *지금* 소실(전부 `default` 강도로 저장)되고 있다. 필요성 확인됨.

## 1. 기존 파이프라인 실측 (재구현 방지 — Wave 2 교훈)

| 로드맵 상상 범위 | 실제 상태 (파일:심볼) |
|---|---|
| 교정 → 룰 승급 | ✅ `evidence-store.ts promoteSessionCandidates` (교정당 1룰, render_key 중복만 skip) |
| 모순 감지 → 수동 해소 | ✅ `lifecycle/trigger-t5-conflict.ts` (negation + 공통토큰≥2 → conflict_refs 플래그, auto-merge 안 함) |
| provenance | ✅ `Rule.evidence_refs: [evidence_id]` |
| 정확 중복 제거 | ✅ `render_key = ${axis}.${target-slug-30}` |
| CLAUDE.md 렌더 | ✅ v1-rules.md 자동생성 |
| 교정 kind→강도 | ✅ `avoid-this→strong`, else `default` (evidence-store.ts:211) |

**실증**: Docker-e2e "필수"(hard) vs "불필요"(default) 모순쌍은 **T5가 이미 해소** — 옛 룰
`removed`/`superseded`, 새 룰 `active`. 모순 감지는 신규 아님.

## 2. 진짜 신규 델타 (2개만)

### D1. 의미 클러스터링 (문구 다른 동일 원칙 묶기)
현재 `render_key` 는 `axis.target-prefix` 정확 일치만 dedup → "라우트 존재", "프로덕션 확인",
"청크 비판리뷰"는 target 이 달라 **3개 별도 룰**. 델타: 같은 axis 내 교정들을 의미 유사도로
묶어 **1개 명명 룰 통합**을 제안.
- **유사도**: 기존 `relevance-scorer.calculateRelevance`(TF-IDF/BM25/bigram) 재사용 —
  heavy embedding 불요, $0-로컬 유지. 교정 summary 를 tag 화해 pairwise 유사도.
- **임계치 τ = 0.3 (새 상수 아님 — forgen 자기 캘리 상속)**: `solution-injector.ts:65`
  `MIN_INJECT_RELEVANCE = 0.3` 은 *동일한 relevance-scorer 표현*에 2026-04-21 gate sweep
  (100% precision/60% recall)으로 실측 튜닝된 게이트. 외부 논문 상수 대신 같은 표현에 이미
  스윕된 0.3 을 상속. 클러스터 = 유사도 그래프의 connected component, 크기 ≥ 2.

### D2. 반복 → 강도 신호
같은 원칙 N회 교정이 지금은 N개 `default` 룰. "N번 교정"은 강한 개인화 신호인데 소실.
델타: 클러스터 크기(반복 횟수)를 강도로 승격.
- **confidence 공식 — Laplace 계승 법칙(rule of succession, 1814) 기반** (임의 상수 아님):
  N회 일관 교정 + 모순 0 → 지속 선호일 사후확률 = Beta-Bernoulli 사후평균 `(N+1)/(N+2)`.
  - N=1 → 0.67, N=2 → 0.75, N=3 → 0.80, N=5 → 0.86, N→∞ → 1.0
  - (모순이 있으면 실패 카운트 f 반영: `(s+1)/(s+f+2)` — T5 conflict 를 f 로 입력)
- **강도 tier 매핑** (confidence → statusConfidence 밴드 0.3/0.55/**0.75**/0.9):
  - N=1 (conf 0.67) → `default` (통합 없음, 단일)
  - **N≥2 (conf ≥0.75 = verified 수준) → `strong` 제안/승급** — 통합 + 강도↑
  - **`hard` 는 confidence 로 자동 도달 금지** — hard 는 L1 안전룰(rm -rf/secret/mock) 전용,
    결정적 가드 발화. 반복만으로 hard 되면 오탐 시 세션 차단 위험. hard 는 명시적 사용자 지시만.
  - (tier 컷오프 N≥2→strong 은 정책 선택이나, confidence 곡선 자체는 Laplace 원리 기반.)

## 3. 트리거 + 알림 UX (자동 통합 + 되돌림)

**결정 (2026-07-22, 사용자 논의 후): 자동 실행 + 알림 + 되돌림** — 수동 제안 철회.
근거: 기반 승급(`promoteSessionCandidates`)이 이미 `auto-compound-runner.ts:671`에서 **세션종료마다
human-confirm 없이 자동** 실행 중(stderr "promoted N correction(s)"). 클러스터링만 수동으로 빼면
철학 불일치. 통합·`strong` 승급은 되돌릴 수 있고 strong 은 차단 아닌 우선순위 신호라 자동 OK.
- **트리거 시점**: 세션종료 시 auto-compound-runner:671 `promoteSessionCandidates` **직후 같은 패스**에
  `clusterCorrectionRules()` 실행 → 통합 자동 수행 + stderr/다음세션 알림.
- **`hard` 만 예외**: confidence 로 자동 hard 도달 금지(§D2). hard 는 명시적 사용자 지시만.
- **알림 표면**: 조용히 통합하지 않고, 다음 세션 시작·statusline 에 다음을 보여준다:
  ```
  🔗 교정 클러스터 감지 (quality_safety, 3회 반복):
     · "기능이 라우트에 존재한다고 완성 판단 말 것"
     · "실제 프로덕션 환경 먼저 확인"
     · "청크 완료 시 비판 리뷰"
     → 자동 통합됨: 1개 명명 룰 "완료 선언 전 실제 검증" [strength: default→strong, conf 0.80]
     되돌리기: forgen rule unmerge-cluster <id>
  ```
- **되돌림/복구 경로** (flow-reviewer W2-3 리뷰 기준 재적용, 자동실행이라 필수): 통합은 원본 교정
  evidence 를 삭제하지 않고 원본 룰을 `superseded` + `clustered_into: <ruleId>` 로 링크만.
  `unmerge-cluster` 시 원본 룰 `active` 복원 + 통합 룰 제거. 원본 evidence 는 항상 보존.
- **provenance**: 통합 룰 `evidence_refs = [모든 클러스터 원본 evidence_id]` (기존 단일→다중 확장).

## 4. 기존 시스템과의 경계 (중복 방지)

- **T5-conflict 와 직교**: T5 = *상반* 교정(negation) 감지 → 수동 해소. D1 클러스터링 =
  *일치* 교정(동일 원칙) 묶기 → 통합 제안. 반대 축이라 충돌 없음. (클러스터 내부에 T5 모순이
  있으면 통합 대신 conflict 우선 — T5 결과를 입력으로 존중.)
- **render_key dedup 와 계층**: render_key = 정확 중복(1차), 클러스터링 = 의미 근접(2차).
  render_key 로 이미 합쳐진 건 클러스터 후보에서 제외.
- **promoteSessionCandidates 확장**: 신규 함수 `clusterCorrectionRules()` 는 promote *직후*
  (auto-compound-runner:671 옆) 삽입 — 승급된 me-scope 룰들을 axis별 유사도 클러스터 →
  크기≥2 클러스터 자동 통합(원본 superseded+링크, strong 승급). unmerge 로 복원 가능.

## 5. 정직성 가드

- **자동 통합하되 조용하지 않게** — 통합 시 stderr + 다음세션 알림, unmerge 경로 항상 노출.
- **강도 hard 자동 도달 금지** (안전룰 오염 방지) — confidence≥0.75 라도 상한 strong.
- 클러스터 오판(엉뚱한 묶음) 대비: unmerge 시 해당 조합 억제 목록 → 재통합 안 함.
- **모순 우선**: 클러스터 내부에 T5 conflict 가 있으면 통합 스킵, conflict 해소 먼저.
- 소규모 정직 고지: 클러스터 후보 0건이면 조용히 no-op, 억지 통합 안 함.

## 6. 테스트 계획

- 유사도 클러스터링 순수함수: 동일원칙 3교정 → 1클러스터, 무관 교정 → 별도, τ=0.3 경계.
- Laplace confidence: N=1/2/3/5 → 0.67/0.75/0.80/0.86, 모순 f 반영 `(s+1)/(s+f+2)`.
- 강도 매핑: N≥2 → strong, hard 자동 금지 단언(상한 strong).
- 통합/복원: 통합 후 evidence_refs 다중 링크 + 원본 superseded, unmerge 후 원본 active 복원.
- 경계: T5 모순 클러스터는 통합 스킵, render_key 기합류 제외.
- 회귀: 클러스터 후보 없을 때 기존 promoteSessionCandidates 동작 불변.

## 7. 난이도 / 범위

**S~M.** 신규: `correction-clustering.ts`(유사도 클러스터링 + Laplace confidence, 순수) +
`rule unmerge-cluster` CLI + 억제목록 상태파일 + auto-compound-runner:671 옆 1줄 훅.
기존 relevance-scorer/evidence-store/rule-store 재사용. heavy 의존 없음. 예상 ~250~350 LOC + 테스트.

## 8. 열린 질문 — **전부 해소 (2026-07-22 사용자 논의)**

1. **트리거 → 자동 (수동 철회).** 기반 승급이 이미 auto-compound-runner:671 에서 세션종료마다
   자동인데 클러스터링만 수동은 불일치. 세션종료 같은 패스 자동 실행 + 알림 + unmerge 복원.
2. **τ → 0.3 (자기 캘리 상속).** 새 상수 아님 — `MIN_INJECT_RELEVANCE=0.3`(동일 relevance-scorer
   표현, 2026-04-21 gate sweep 실측)을 상속. 외부 임의 상수 회피.
3. **강도 → Laplace 계승 법칙.** confidence=`(N+1)/(N+2)`(Beta-Bernoulli 사후평균). N≥2(conf≥0.75)
   → strong, hard 자동 금지(상한 strong). 임의 상수 아닌 원리 기반. tier 컷오프만 정책 선택(정직 표기).

→ 3개 전부 해소. §2 델타대로 구현 착수 가능. 나머지는 기존 자산 재사용.
