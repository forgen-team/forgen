# ADR-002: Rule Lifecycle Engine (T1~T5 + Meta 자기참조적 재분류)

**Status**: Accepted (2026-04-22, amended same day)
**Date**: 2026-04-22
**Reversibility**: Type 1 (rule 파일의 lifecycle 상태가 on-disk로 지속됨)
**Related Interview**: Deep Interview v0.4.0 Trust Restoration (Round 9~10)
**Depends on**: ADR-001 (`enforce_via` 필드가 Meta 재분류의 대상)
**Implementation evidence**: `src/engine/lifecycle/` (orchestrator + triggers T1~T5 + Meta 양방향) + runtime 통합 (T1: evidence-store.appendEvidence, T3: post-tool-use bypass-detector, T4: state-gc.runDailyT4Decay, T5: rule-store.appendRule, Meta: drift.jsonl → meta-reclassifier). 단위 + 통합 테스트 74건, 전체 회귀 1926/1926 pass.

**Amendments**:
- 2026-04-22: `MetaPromotion.reason` union 에 `'stuck_loop_force_approve'` 추가. stop-guard 의 stuck-loop 가드가 count>3 에서 force approve 를 수행하고 Mech 강등을 유발하는 경우의 공식 분류. `trigger_stats` 의 `adherence_rate` / `violation_count` 를 optional 로 완화 — reason 에 따라 하나만 의미 있음.

## Context

### 결정해야 할 것
"rule은 영구 규범이 아니라 현재 유효한 가설"이라는 인터뷰 본질 재정의를 구체화하는 lifecycle 엔진의 데이터 모델·상태 전이·기존 자산 확장 경로.

5가지 트리거 + Meta:
- **T1**: 사용자 명시 교정 → rule 즉시 수정/폐기
- **T2**: 반복 Mech 위반 N회 → rule 재검토 flag
- **T3**: 사용자 반복 우회 → 선호 변경 감지
- **T4**: 시간 경과 → retire 자동화
- **T5**: 규칙 충돌 → merge/우선순위 정책
- **Meta**: 연속 N회 준수되는 Mech-B → Mech-A 승급 / 반복 위반되는 Mech-A → Mech-B 강등

### 관찰된 기존 자산
| 트리거 | 재활용 가능 자산 | 확장 필요성 |
|--------|-----------------|-------------|
| T1 | `evidence-store.ts` (`explicit_correction` 타입 이미 존재) | T1은 evidence → rule 수정/retire 자동 연결 추가 |
| T2 | `solution-outcomes.ts` (`Outcome=accept\|correct\|error`, JSONL, lock) | rule 단위 집계 + 임계 검출 로직 추가 |
| T3 | 없음 — 사용자가 rule과 반대 행동 감지 로직 부재 | 신규 engine (post-tool-use 훅의 command pattern diff) |
| T4 | `solution-quarantine.ts` (현재 frontmatter 에러만 격리) | time-based retire candidate 확장 |
| T5 | 없음 | 신규 engine (rule 간 trigger/policy 충돌 검출) |
| Meta | `solution-fitness.ts` + `rule-promoter.ts` (기존 champion 승급 메커니즘) | rule 단위 적용, enforce_via.mech 변경 기능 추가 |

### 제약
- β1: 자동 분석 로직은 `$0` — 별도 LLM judge 호출 금지. 정규식/임계/카운트 기반.
- v0.4.0 통짜 릴리즈(L-full) — 일부만 구현하고 나중에 추가는 금지.
- 기존 `solution-*.ts` 의 file-lock, atomic-write 일관 패턴 유지.

## Alternatives Considered

### Option A: 최소형 — 단일 파일·단일 엔진
- `src/engine/rule-lifecycle.ts` 단일 파일에 T1~T5+Meta 통합.
- 상태는 기존 rule JSON 에 인라인(`lifecycle_state` 필드).
- 장점: 단순, 전체 흐름을 한눈에 파악.
- 단점: 단일 파일 >500줄 위험, 트리거별 테스트 격리 어려움, 사용자 anti-pattern 규칙("50줄 초과 시 분리") 위반.

### Option B: 이상형 — 트리거별 모듈화 + 오케스트레이터
- 구조:
  ```
  src/engine/lifecycle/
    ├─ orchestrator.ts          (이벤트 버스 + 상태 전이 규칙)
    ├─ trigger-t1-correction.ts (T1)
    ├─ trigger-t2-violation.ts  (T2)
    ├─ trigger-t3-bypass.ts     (T3)
    ├─ trigger-t4-decay.ts      (T4)
    ├─ trigger-t5-conflict.ts   (T5)
    ├─ meta-reclassifier.ts     (Meta)
    └─ types.ts
  ```
- 각 트리거는 `detect(RuleState) → LifecycleEvent[]` 순수 함수.
- orchestrator는 이벤트를 수신해 rule에 상태 전이 적용.
- 장점: 트리거 단위 단위테스트 용이, 신규 트리거 추가 무충돌.
- 단점: 7개 파일 + 결합 계약 — 초기 러닝 커브.

### Option C: 최소형의 변형 — 기존 파일 인라인 확장
- `solution-outcomes.ts`에 T2 로직, `solution-quarantine.ts`에 T4 로직 직접 추가. 신규 파일 최소화.
- 장점: 기존 코드 근접성, 새 import path 없음.
- 단점: 결합 증가, 파일 단위 책임 흐려짐, Meta 같은 크로스커팅 관심사는 배치 위치 자체가 모호.

## Trade-off Matrix

| 기준 | 가중치 | Option A | Option B | Option C |
|------|--------|----------|----------|----------|
| 단일책임(SOLID) | 20% | ★★ (2) | ★★★★★ (5) | ★★ (2) |
| 테스트 용이성 | 20% | ★★★ (3) | ★★★★★ (5) | ★★★ (3) |
| 구현 비용 | 15% | ★★★★ (4) | ★★★ (3) | ★★★★★ (5) |
| 신규 트리거 확장 | 15% | ★★ (2) | ★★★★★ (5) | ★★ (2) |
| 가독성(전체 흐름) | 15% | ★★★★ (4) | ★★★ (3) | ★★ (2) |
| anti-pattern 부합(50줄/4-depth) | 15% | ★★ (2) | ★★★★★ (5) | ★★★ (3) |
| **가중 합계** | **100%** | **2.80** | **4.40** | **2.80** |

산술 검증:
- A: 0.20×2 + 0.20×3 + 0.15×4 + 0.15×2 + 0.15×4 + 0.15×2 = 0.40+0.60+0.60+0.30+0.60+0.30 = **2.80**
- B: 0.20×5 + 0.20×5 + 0.15×3 + 0.15×5 + 0.15×3 + 0.15×5 = 1.00+1.00+0.45+0.75+0.45+0.75 = **4.40**
- C: 0.20×2 + 0.20×3 + 0.15×5 + 0.15×2 + 0.15×2 + 0.15×3 = 0.40+0.60+0.75+0.30+0.30+0.45 = **2.80**

최종 점수: A=2.80, **B=4.40**, C=2.80

## Decision

**Option B를 선택합니다.**

근거:
1. 사용자 anti-pattern 규칙("함수 50줄 초과 시 분리")과 SOLID 선호(user profile `judgment: 구조적접근형`, `abstraction_bias: 0.85`)와 정합.
2. 트리거는 탐지 로직(정규식/임계)과 상태 전이(rule 파일 쓰기)가 개념적으로 직교 — `detect / apply` 분리가 본질.
3. v0.4.1+ 에 신규 트리거 추가 시(예: T6 = 팀 공유 동기화) 기존 코드 수정 없이 한 파일만 추가.

**수용한 Trade-off:**
- 초기 7개 파일 학습 비용 → `orchestrator.ts` 상단 주석에 전체 데이터 플로우 도식 포함으로 완화.
- 파일 수 증가 → 각 `trigger-*.ts` 는 단일 `detect()` export만 유지해 복잡도 제한.

**Reversal condition:**
- 3개월 내 트리거 로직이 거의 같은 데이터 소스만 참조한다면(파편화의 득이 없다면) → C로 통합 리팩터링.

## 데이터 모델

### Rule 확장 (ADR-001 위에 추가)

```typescript
// src/store/types.ts 추가

export type LifecyclePhase =
  | 'active'         // 정상
  | 'flagged'        // T2 반복 위반 감지 → 재검토 대기
  | 'suppressed'     // T3 사용자 우회 반복 → 일시 비활성
  | 'retired'        // T4 시간 경과 | T1 폐기
  | 'merged'         // T5 다른 rule에 흡수됨 (merged_into: rule_id)
  | 'superseded';    // T1 수정으로 새 rule에 의해 교체됨

export interface LifecycleState {
  phase: LifecyclePhase;
  first_active_at: string;        // ISO
  last_inject_at?: string;
  last_violation_at?: string;
  inject_count: number;
  accept_count: number;
  violation_count: number;
  bypass_count: number;           // T3: 사용자가 rule과 반대로 행동한 횟수
  conflict_refs: string[];        // T5: 충돌하는 rule_id 목록
  merged_into?: string;           // T5: 흡수된 rule_id
  superseded_by?: string;         // T1: 교체 rule_id
  meta_promotions: MetaPromotion[]; // Meta: mech 변경 이력
}

export interface MetaPromotion {
  at: string;
  from_mech: 'A' | 'B' | 'C';
  to_mech: 'A' | 'B' | 'C';
  // v0.4.0 amendment (2026-04-22): 'stuck_loop_force_approve' 추가 — stop-guard stuck-loop
  // 가드가 count>3 에서 force approve 하고 Mech 강등을 trigger 하는 경우.
  reason:
    | 'consistent_adherence'
    | 'repeated_violation'
    | 'user_override'
    | 'stuck_loop_force_approve';
  trigger_stats: { window_n: number; adherence_rate?: number; violation_count?: number };
}

// Rule 에 추가
export interface Rule {
  // ... 기존 + enforce_via (ADR-001) ...
  lifecycle?: LifecycleState;   // optional: 기존 rule은 auto-initialize
}
```

### 이벤트 모델

```typescript
// src/engine/lifecycle/types.ts

export type LifecycleEventKind =
  | 't1_explicit_correction'
  | 't2_repeated_violation'
  | 't3_user_bypass'
  | 't4_time_decay'
  | 't5_conflict_detected'
  | 'meta_promote_to_a'
  | 'meta_demote_to_b';

export interface LifecycleEvent {
  kind: LifecycleEventKind;
  rule_id: string;
  session_id?: string;
  evidence?: {
    source: string;           // 'evidence-store' | 'outcomes' | 'quarantine' | ...
    refs: string[];           // evidence_id[] | outcome_event[] | ...
    metrics?: Record<string, number>;
  };
  suggested_action: 'flag' | 'suppress' | 'retire' | 'merge' | 'supersede' | 'promote_mech' | 'demote_mech';
  ts: number;
}
```

## 상태 전이 다이어그램

```
                             ┌──────────────┐
                             │    active    │ ← 신규 rule 기본
                             └──────┬───────┘
             T2 위반 임계         │               T4 (N일 미주입)
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
  ┌──────────┐        (Meta 재분류은 active 내부)      ┌──────────┐
  │ flagged  │        ┌─────────────────────────┐     │ retired  │
  └────┬─────┘        │  enforce_via[].mech 변경 │     └──────────┘
       │              │  (A↔B, 파일 재기록)      │           ▲
 T1 사용자 교정        └─────────────────────────┘           │
       │                                                     │
   ┌───┴───┐  T3 bypass 임계                                 │
   ▼       ▼                                                 │
┌──────────┐┌────────────┐                  T1 폐기           │
│supersededd││ suppressed │  ─────────────────────────────────┘
└──────────┘└────────────┘
   ▲                ▲
   │                │
  T1 수정        T3 계속 누적
```

상태 전이 규칙:
- `active → flagged`: T2 발동 (violation_count / max(inject_count,1) > 0.3 AND violation_count ≥ 3)
- `active → suppressed`: T3 발동 (bypass_count ≥ 5 within 7d)
- `active → retired`: T4 (inject_count=0 in 90d) OR T1 폐기
- `active → superseded`: T1 수정
- `active → merged`: T5 충돌 해소 (더 높은 confidence 또는 더 최근 evidence 우선)
- `flagged → active`: 재검토 후 사용자 승인 시
- `flagged → retired`: 재검토 미수용 시
- `suppressed → active`: 7d 경과 + bypass_count 미증가 시
- Meta: `enforce_via[].mech` 변경은 phase 유지하면서 별도 이력(`meta_promotions[]`)으로 기록

### 트리거별 탐지 로직

| Trigger | 탐지 위치 | 임계 | 출력 |
|---------|-----------|------|------|
| T1 | evidence-store.appendEvidence() hook | `type=explicit_correction` + `axis_refs`에 해당 rule의 category 매칭 | LifecycleEvent(t1) |
| T2 | solution-outcomes.flushAccept() 직후 | rule 단위 `violation_count ≥ 3` AND `violation_rate > 0.3` in rolling 30-day window | LifecycleEvent(t2) |
| T3 | post-tool-use hook (Bash/Write 후) | rule.policy 와 정반대 패턴이 command/file diff에 감지됨, bypass_count ≥ 5 in 7d | LifecycleEvent(t3) |
| T4 | daily scheduler (state-gc.ts 확장) | `last_inject_at < now - 90d` | LifecycleEvent(t4) |
| T5 | rule 생성/수정 시 | 같은 `category` + 상반되는 `policy` 자연어 매칭(간단 heuristic) | LifecycleEvent(t5) |
| Meta | drift.jsonl / signals | rolling 20 injects 중 violation 0 → A 승급 후보 / stuck_loop_force_approve 3회+ → B 강등 후보 (구현: meta-reclassifier.scanDriftForDemotion, scanSignalsForPromotion) | LifecycleEvent(meta) |

### Orchestrator 동작

```
매 이벤트 발생 시:
1. LifecycleEvent를 ~/.forgen/state/lifecycle/{date}.jsonl 에 append
2. rule_id 해당 Rule 로드
3. 상태 전이 규칙 적용 → new LifecycleState
4. atomicWriteJSON으로 rule 파일 업데이트
5. 상태 전이 알림(옵션): dashboard 노티 + session-state-store 반영
```

## 기존 자산 확장 경로 (하위 호환 우선)

| 기존 | 확장 |
|------|------|
| `evidence-store.ts::appendEvidence()` | 내부에서 lifecycle orchestrator.onEvidence() 호출. import 하나만 추가. |
| `solution-outcomes.ts::flushAccept()` | 기존 outcome 기록 유지 + rule 별 violation 카운트 증가 시 orchestrator.onOutcome() 호출. |
| `solution-quarantine.ts` | 기존 frontmatter-error 격리 + T4 retire candidate 격리 기능 추가. 격리 디렉토리 분리(`quarantine/frontmatter/`, `quarantine/retired/`). |
| `solution-fitness.ts::evaluateFitness()` | 기존 champion 판정 + Meta promotion 후보 반환 추가. |
| `rule-promoter.ts` | 기존 session→permanent 승급 + enforce_via.mech 변경(승급/강등) 기능 추가. |
| `state-gc.ts` | 기존 세션 GC + daily T4 decay 스캐너 추가. |

모든 확장은 **기존 signature 보존**, **새 export만 추가**, **기본값 미사용** 원칙.

## Consequences

### Positive
- Rule 이 "살아있는 가설"로 동작 — stale rule 자동 은퇴.
- Meta 재분류로 Mech-B가 실증되면 Mech-A로 강화됨 — 시스템이 스스로 신뢰도 상승.
- 트리거 단위 테스트 격리로 회귀 최소화.

### Negative
- rule JSON 쓰기 빈도 증가 (매 inject/outcome 시 lifecycle state 갱신) → file lock 경합 가능성. 완화: 배치 flush (N초 단위 or N이벤트 단위).
- 트리거 간 순서 의존(예: T1이 T2보다 먼저 처리돼야 flagged → retired 전이 의미가 있음). orchestrator에 명시 우선순위.

### Risks + 완화
| Risk | 확률 | 영향 | 완화 |
|------|------|------|------|
| 자동 retire 오작동으로 유효 rule 제거 | 저 | 중 | retire는 `retired` phase로만 이동, 실제 파일 삭제는 N개월 후 별도 GC. 복구 가능. |
| T5 충돌 오탐 (자연어 heuristic 한계) | 중 | 저 | `merge` 는 자동 실행 안 함, `conflict_refs` 플래그만 설정 → 사용자 리뷰 후 수동 처리. |
| Meta 잦은 재분류로 불안정 | 중 | 중 | promotion 쿨다운(30일 내 재변경 금지). |
| bypass 탐지(T3) false positive (사용자의 정당한 rule 이탈) | 중 | 저 | `suppressed` 는 7일 임시, active로 자동 복귀. |

### Follow-up
- ADR-003 self-gate 가 lifecycle event stream 을 소비 (CI 내 rule health check).

## Related
- **Depends on**: ADR-001 (enforce_via 스키마)
- **Consumed by**: ADR-003 (self-gate)
- **Interview**: Deep Interview v0.4.0 Trust Restoration (Round 9)
- **Review date**: 2026-06-22 (초기 운영 2개월 후 임계값·쿨다운 튜닝)
