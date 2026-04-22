# ADR-001: Mech-A/B/C 3축 강제 메커니즘 아키텍처

**Status**: Proposed
**Date**: 2026-04-22
**Reversibility**: Type 1 (비가역 경향 — rule 파일의 on-disk 스키마 변경이 포함됨)
**Related Interview**: Deep Interview v0.4.0 Trust Restoration (Round 10, Ambiguity 0.13)
**Owner**: forgen v0.4.0 릴리즈

## Context

### 결정해야 할 것
forgen v0.4.0 미션("축적된 모든 rule이 런타임에 예외 없이 반드시 사용")을 실현하기 위한 3축 강제 메커니즘의 데이터 모델 + 훅 연결 구조.

- **Mech-A** (hook-BLOCK): 기계 판정 가능한 규칙 — 위반 시 차단
- **Mech-B** (self-check prompt-inject): 자연어 판정 규칙 — 현재 세션 Claude에게 자가점검 강제 (추가 API 호출 없음)
- **Mech-C** (drift-measure): 정량 판정 불가 규칙 — 장기 누적 편향 측정 후 rule 우선순위 보정

### 제약
- β1: 추가 LLM API 비용 **$0**. Claude Code hook 시스템(`PreToolUse` / `PostToolUse` / `Stop` / `UserPromptSubmit`)만 사용.
- v0.3.x 업그레이드 **무중단** — 기존 rule 23개 + memory 15개 auto-migration.
- 기존 자산 최대 활용: `src/store/rule-store.ts`, `src/engine/solution-outcomes.ts`, `src/hooks/solution-injector.ts`, `src/hooks/post-tool-use.ts`, `src/hooks/shared/hook-response.ts`.

### 관찰된 기존 자산
- `Rule.strength: 'soft'|'default'|'strong'|'hard'` — 이미 존재 (src/store/types.ts). 재활용/확장 결정 필요.
- `hook-response.ts`: `approve`, `approveWithContext`, `approveWithWarning`, `failOpenWithTracking` — Mech-A의 BLOCK 동작에 필요한 프리미티브 모두 확보.
- `solution-injector` (UserPromptSubmit): `appendContext`로 rule 주입 이미 수행. Mech-B의 자연 연결점.
- `post-tool-use`: `approveWithWarning` + drift score 평가 이미 존재. Mech-A의 자연 연결점.
- `Stop` hook: 현재 미사용 — "완료 선언" 차단의 핵심 연결점으로 신규 배치 필요.

### 핵심 기술 질문: self-check prompt-inject가 $0으로 가능한가?
Claude Code hook 명세 상 `Stop` hook은 `decision: "block"` + `reason` 으로 Claude에게 *계속 작업하라* 신호를 보낼 수 있음. 이것이 외부 API 호출 없이 현재 세션 내 재개를 유도하는 메커니즘. → **Assumption A1**의 구현 경로. ADR-001 §Spike Plan에서 검증.

## Alternatives Considered

### Option A: 최소형 — 기존 `strength` 필드 재활용
- 매핑: `hard/strong` → Mech-A 후보, `default` → Mech-B, `soft` → Mech-C.
- 스키마 변경 **없음**. 런타임 classifier 함수 하나로 mech 도출.
- 장점: 마이그레이션 비용 0, 기존 코드 최소 수정.
- 단점: (1) `strength`는 *중요도* 축이고 mech는 *검증 방식* 축 — 두 직교 개념을 한 필드로 혼합해 개념 오염. (2) **다중 mech 불가** — 하나의 rule이 Mech-A + Mech-B 동시 해당되는 경우(예: "Docker e2e 없이 완료선언 금지"는 완료 선언 키워드 감지로 A, 응답 내 mock 키워드 감지로 B 양쪽 해당) 표현 불가. (3) verifier 스펙을 어디에 둘지 모호.

### Option B: 이상형 — 신규 `enforce_via` 배열 필드
- `Rule`에 `enforce_via: EnforceSpec[]` 추가.
- `EnforceSpec = { mech: 'A'|'B'|'C', hook: HookPoint, verifier?: VerifierSpec }`
- 다중 mech 허용. 기존 `strength`는 *중요도*로 순수 의미 유지.
- 기존 23개 rule은 `null` 로 두고 런타임에 auto-classifier가 채움 (C3 자동화의 일부).
- 장점: 표현력 최대, v0.4.0 목표 100% 충족, 미래 확장(meta-rule 재분류) 자연.
- 단점: 스키마 변경, 마이그레이션 필요, classifier 구현 필요.

### Option C: 현상 유지
- rule-renderer만 사용 (CLAUDE.md inject). 런타임 강제 없음.
- v0.5+로 연기.
- 인터뷰가 확정한 미션과 정면 충돌 — 평가용 비교군으로만 유지.

## Trade-off Matrix

| 기준 | 가중치 | Option A (최소) | Option B (이상) | Option C (현상) |
|------|--------|-----|-----|-----|
| 구현 복잡도 (낮을수록 ★↑) | 15% | ★★★★ (4) | ★★ (2) | ★★★★★ (5) |
| 확장성 (다중 mech, meta-rule) | 20% | ★★ (2) | ★★★★★ (5) | ★ (1) |
| 명확성 (쓴 사람 의도 해독성) | 15% | ★★ (2) | ★★★★★ (5) | ★★ (2) |
| 마이그레이션 비용 | 15% | ★★★★★ (5) | ★★ (2) | ★★★★★ (5) |
| v0.4.0 목표 적합성 | 25% | ★★ (2) | ★★★★★ (5) | ★ (1) |
| v0.3.x 호환성 | 10% | ★★★★★ (5) | ★★★★ (4) | ★★★★★ (5) |
| **가중 합계** | **100%** | **3.05** | **4.00** | **2.75** |

산술 검증:
- A: 0.15×4 + 0.20×2 + 0.15×2 + 0.15×5 + 0.25×2 + 0.10×5 = 0.60+0.40+0.30+0.75+0.50+0.50 = **3.05**
- B: 0.15×2 + 0.20×5 + 0.15×5 + 0.15×2 + 0.25×5 + 0.10×4 = 0.30+1.00+0.75+0.30+1.25+0.40 = **4.00**
- C: 0.15×5 + 0.20×1 + 0.15×2 + 0.15×5 + 0.25×1 + 0.10×5 = 0.75+0.20+0.30+0.75+0.25+0.50 = **2.75**

## Decision

**Option B를 선택합니다.**

근거:
1. 인터뷰에서 사용자가 "되고 안 됨은 없다 — 모두 어떤 mechanism으로든 강제돼야 한다"를 명시. 다중 mech 지원은 본질 요구.
2. 자기참조적 Mech 재분류(ADR-002의 Meta 트리거)는 rule의 mech 필드를 동적으로 변경함 — `enforce_via`라는 명시 필드가 없으면 구현 자체 불가.
3. "통짜 완성도 우선" 릴리즈 정책(L-full)과 정합 — 최소형 A는 1~2개월 후 B로 재작업해야 하므로 단계 릴리즈의 변형이 됨.

**수용한 Trade-off:**
- 마이그레이션 비용 상승 (Option A 대비 ★5→★2). → §Migration Plan으로 완화.
- 구현 복잡도 증가. → 기존 훅 재활용 + 명시 스키마로 상쇄.

**거부된 대안과 이유:**
- Option A: `strength`와 `mech` 개념 혼합이 미래 meta-rule 구현을 막음. 단기 편익 < 장기 부채.
- Option C: 인터뷰 goal과 정면 충돌. Trust-restoration 미션 무효화.

**Reversal condition:**
- A1 검증 스파이크에서 self-check prompt-inject가 실효성 없음이 확인되면(Mech-B가 근본적으로 작동 안 하면) → Option A로 롤백하고 scope를 Mech-A + Mech-C 로 축소.
- 런타임 오버헤드가 hook당 p95 > 300ms 로 측정되면 → Mech-B의 UserPromptSubmit 주입을 지연 로딩으로 재설계.

## Schema 설계

```typescript
// src/store/types.ts 확장

export type EnforcementMech = 'A' | 'B' | 'C';
export type HookPoint = 'PreToolUse' | 'PostToolUse' | 'Stop' | 'UserPromptSubmit';

export interface VerifierSpec {
  kind: 'file_exists' | 'pattern_match' | 'tool_arg_regex' | 'artifact_check' | 'self_check_prompt';
  params: Record<string, string | number | boolean>;
  // 예 (Mech-A): { kind: 'artifact_check', params: { path: '.forgen/state/e2e-result.json', max_age_s: 3600 } }
  // 예 (Mech-B): { kind: 'self_check_prompt', params: { question: '직전 응답에 mock 키워드가 있고 실검증 증거가 있는가?' } }
}

export interface EnforceSpec {
  mech: EnforcementMech;
  hook: HookPoint;
  verifier?: VerifierSpec;   // Mech-A/B에서 필수, Mech-C에서는 미사용
  block_message?: string;    // Mech-A BLOCK 시 Claude에게 전달할 reason
  drift_key?: string;        // Mech-C: drift-score.ts 키
}

// 기존 Rule 확장
export interface Rule {
  // ... 기존 필드 ...
  enforce_via?: EnforceSpec[];   // optional: 기존 23개 rule은 null → auto-classifier가 채움
}
```

## Hook 연결 구조

```
┌────────────────────────────────────────────────────────┐
│  UserPromptSubmit                                       │
│  ├ solution-injector.ts (기존)                          │
│  │   → 관련 rule의 enforce_via 스캔                     │
│  │   → Mech-B 규칙: appendContext로 self-check prompt   │
│  │      ("다음 답변 전 확인: Docker e2e 증거 존재?")    │
│  │   → Mech-A 규칙: rule 텍스트 + verifier 명세 inject  │
│  │      (Claude가 규칙을 명시적으로 인식하도록)         │
│  └ keyword-detector.ts (기존)                           │
│      → 기존 skill 주입 역할 유지                        │
├────────────────────────────────────────────────────────┤
│  PreToolUse                                             │
│  └ pre-tool-use.ts (기존)                               │
│      → enforce_via에서 hook='PreToolUse' Mech-A 규칙    │
│         scan → verifier 실행 → BLOCK 여부 결정          │
│      예: 'rm -rf' 패턴 + 무확인 → decision: "deny"      │
├────────────────────────────────────────────────────────┤
│  PostToolUse                                            │
│  └ post-tool-use.ts (기존, 확장)                        │
│      → 도구 실행 후 verifier 재평가                     │
│      → drift-score 평가 (Mech-C)                        │
│      → approveWithWarning으로 규칙 환기                 │
├────────────────────────────────────────────────────────┤
│  Stop (신규 hook)                                       │
│  └ stop-guard.ts (신규)                                 │
│      → Claude 응답에서 "완료 선언" 패턴 스캔            │
│         (완료|done|ready|finished|shipped|LGTM)         │
│      → 매칭된 Mech-A 규칙 verifier 실행                 │
│      → 위반 감지 시: decision: "block",                 │
│         reason: "<rule.block_message>"                  │
│         → Claude가 현재 세션 내에서 검증 후 재응답      │
│         → 추가 API 호출 없음 (β1 준수)                  │
└────────────────────────────────────────────────────────┘
```

## 주입·적용 추적 이벤트 구조

기존 `solution-outcomes.ts`의 `OutcomeEvent`를 일반화하여 `EnforcementEvent`로 확장:

```typescript
// ~/.forgen/state/enforcement/{session_id}.jsonl (append-only)
export interface EnforcementEvent {
  ts: number;
  session_id: string;
  rule_id: string;
  mech: EnforcementMech;
  hook: HookPoint;
  action: 'inject' | 'verify_pass' | 'verify_fail' | 'block' | 'self_check_inject' | 'drift_sample';
  verifier_kind?: string;
  block_message?: string;
  // 사후 질의: "rule X가 세션 Y에서 몇 회 inject됐고, 몇 회 block됐나"
}
```

대시보드(`forgen dashboard` 명령)에 **Enforcement Tracking** 섹션 신규:
- Mech별 inject/verify_pass/block 카운트
- 최근 24h에 가장 자주 block된 rule top 5
- 주입·적용 이벤트 추적률: `events_with_outcome / total_injects`

이것이 S2 지표(추적률 ≥80%)의 측정 원천.

## Consequences

### Positive
- 다중 mech 규칙이 자연 표현됨 → meta-rule, 충돌 해소(ADR-002)의 전제 확보.
- 대시보드에서 "이 규칙이 실제로 동작했는가"를 사후 검증 가능 → 사용자 관찰성 요구(인터뷰 Q3=d) 충족.
- Mech-B 주입이 UserPromptSubmit 기반이므로 Claude API 추가 호출 없음 → β1 유지.

### Negative
- 기존 23 rule 자동 분류 실패 시 런타임 무시 → Mech 미할당 rule은 기존처럼 렌더링만 됨 (degrade gracefully). 완전 마이그레이션은 Phase 2(migration 스크립트)에서.
- `Rule` 스키마 확장으로 JSON 파일 볼륨 증가 (rule당 평균 ~200바이트). 성능 영향 무시 수준.

### Risks + 완화
| Risk | 확률 | 영향 | 완화 |
|------|------|------|------|
| A1 가정 실패: self-check inject가 Claude를 멈추지 못함 | 중 | 치명 | **Spike 먼저**(§Spike Plan). 실패 시 Option A 롤백 + scope 축소. |
| verifier 스펙이 런타임에 긴 시간 소모 | 저 | 중 | verifier별 timeout 500ms. 초과 시 fail-open + tracking. |
| BLOCK 남발로 사용자 흐름 차단 | 중 | 중 | Mech-A 규칙 승급 게이트 (ADR-002의 Meta): 위양성 rate > 10% 면 자동 강등. |
| 기존 훅 regression | 중 | 중 | 신규 필드 optional + 기본값 no-op. 모든 hook에 기존 테스트 + 신규 통합 테스트. |

### Follow-up Decisions (ADR 분리)
- ADR-002: lifecycle engine (T1~T5 + Meta)
- ADR-003: 릴리즈 self-gate

## Spike Plan (Assumption A1 검증)

**목표**: Mech-B의 self-check prompt-inject가 추가 API 호출 없이 Claude에게 자가점검을 강제하는지 실증.

**기간**: 3~5일 (v0.4.0 구현 시작 전 완료 필수)

**방법**:
1. 테스트 rule 3개 준비:
   - R-A (Mech-A): "Bash 도구로 `rm -rf` 실행 시 직전 세션에 사용자 confirm 없으면 BLOCK"
   - R-B1 (Mech-B): "응답에서 '완료' 선언 전 Docker e2e 증거 확인"
   - R-B2 (Mech-B): "응답에서 'mock/stub' 키워드가 생산 코드 맥락에 있으면 자가점검"
2. `UserPromptSubmit` 에서 R-B1/B2 의 self_check_prompt 를 appendContext.
3. `Stop` hook 에서 Claude 응답에 "완료" 패턴 감지 + `.forgen/state/e2e-result` 파일 없으면 `decision: "block"` + reason.
4. 수기 시나리오 10회 실행: 의도적 위반 시 Claude가 (a) 차단 메시지 인식 (b) 스스로 검증 후 재응답 하는지.

**합격 기준**:
- 10회 중 **≥8회** Claude가 block reason을 수용하고 Docker e2e를 실행(혹은 실행 요청)한 뒤 다시 완료 선언.
- 추가 API 호출 수: `anthropic.requests` 지표 변화 없음(Claude Code 내부 trace로 검증).
- hook 실행 시간 p95 ≤ 200ms.

**실패 시**:
- 합격률 < 80% 또는 API 추가 호출 발생 → ADR-001 Decision 롤백 → Option A로 재평가. Mech-B는 "관찰만"으로 다운그레이드, scope는 Mech-A + Mech-C 로 축소.

**산출물**:
- `tests/spike/mech-b-inject/` — 스파이크 코드 + 시나리오 결과
- `docs/spike/mech-b-a1-verification-report.md` — 정량 결과 및 결정

## Migration Plan (v0.3.x → v0.4.0)

1. `enforce_via` 필드는 **optional**. 기존 rule JSON 파일은 그대로 유효.
2. 신규 `classify-enforce` 명령(`forgen classify-enforce`): 기존 rule 23개 + memory 15개를 스캔하여 `enforce_via` 제안 생성 → 사용자 확인 후 저장.
3. auto-classifier 규칙(초기):
   - 트리거에 `rm|force|DROP|credentials|\.env` 키워드 → Mech-A BLOCK (PreToolUse, pattern_match verifier)
   - 트리거에 `완료|complete|done|e2e|mock|verify` → Mech-A BLOCK (Stop, artifact_check verifier)
   - `strength=strong|hard` + 문체/응답 관련 → Mech-B (UserPromptSubmit, self_check_prompt)
   - `strength=soft|default` + 수치 기반(facet) → Mech-C (drift_sample)
4. migration은 **idempotent**: 이미 `enforce_via`가 있으면 건드리지 않음.
5. v0.3.x → v0.4.0 업그레이드 시 기존 state 파일(`~/.forgen/state/*`) 그대로 유지, 신규 디렉토리(`~/.forgen/state/enforcement/`)만 추가.

## Related
- **Interview**: Deep Interview v0.4.0 Trust Restoration (2026-04-22, Ambiguity 0.13)
- **Blocks**: ADR-002 (lifecycle 엔진이 `enforce_via`를 변경하므로 선행)
- **Dogfood target**: ADR-003 (self-gate가 이 메커니즘을 forgen 자신에게 적용)
- **Review date**: 2026-05-22 (Spike 완료 + 초기 구현 4주 뒤)
