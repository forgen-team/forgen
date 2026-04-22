# Spike Report: A1 Verification — Mech-B Self-Check Prompt-Inject at $0

**Spike plan**: [mech-b-a1-verification-plan.md](./mech-b-a1-verification-plan.md)
**Related ADR**: [ADR-001](../adr/ADR-001-mech-abc-enforcement-architecture.md)
**Status**: 🟡 In progress — Day 1 complete, Days 2~5 pending
**Last updated**: 2026-04-22

---

## Day 1 — Open Questions Resolution (완료)

Open Question 전 3개가 공식 Claude Code 문서 기반으로 해소됨. A1 가정은 **프로토콜 및 아키텍처 수준에서 검증**됐으며, 남은 것은 효과성(A2) 만임.

### OQ1: `Stop` hook `decision:"block"` 세션 재개 여부

**RESOLVED — 재개됨.**

공식 문서 (`github.com/anthropics/claude-code/.../hook-development/SKILL.md`) 직접 인용:
> `decision` (string) - Required - Can be `approve` to allow stopping or `block` to **prevent stopping and continue the agent's work**.

추가 증거 — 공식 실세계 예제(Ralph loop, `.../plugin-settings/references/real-world-examples.md`):
```bash
jq -n --arg prompt "$PROMPT_TEXT" --arg msg "🔄 Ralph iteration $NEXT_ITERATION" \
  '{ "decision": "block", "reason": $prompt, "systemMessage": $msg }'
exit 0
```
이 예제는 `reason` 을 *다음 루프 이터레이션의 prompt 로 투입* — 즉 block 은 단순 종료 차단이 아니라 **새 턴을 시작시키는 재개 메커니즘**. 우리 Mech-B 설계와 구조적으로 동일.

### OQ2: `reason` vs `systemMessage` 의 모델 전달 의미

**RESOLVED — Stop 훅 전용 스키마에서 둘 다 모델에 도달하되 역할이 다름.**

| 필드 | Stop hook (block) | 일반 hook |
|------|-------------------|-----------|
| `reason` | 다음 턴의 user-turn content (핵심 메시지) | 미사용 또는 이벤트별 |
| `systemMessage` | additional context to Claude (보조) | **UI-only, 모델 미도달** |
| `additionalContext` (in `hookSpecificOutput`) | — | UserPromptSubmit/SessionStart 에서 모델 도달 |

출처 대조:
- 공식 Stop hook: *"`systemMessage` — Additional context or instructions **provided to Claude** if the agent is blocked from stopping."*
- 공식 일반 hook output: *"`systemMessage` allows you to send a specific message directly to Claude"* — 그러나 실제 SDK 동작과 forgen 기존 주석(`src/hooks/shared/hook-response.ts`)이 명시하는 바, **Stop 외 이벤트에서는 UI-only**.

**설계 함의**: Mech-B self-check 질문은 **`reason` 에 전체를 담아야** 하며, `systemMessage` 에는 규칙 ID/짧은 참조만 둠. 그렇지 않으면 자가점검 질문이 UI에만 표시되고 Claude 가 인지 못할 위험.

**신규 helper 필요** (scope: `src/hooks/shared/hook-response.ts` 확장):
```typescript
/** Stop hook only — block stopping and feed self-check question to Claude. */
export function blockStop(reason: string, systemMessage?: string): string {
  return JSON.stringify({
    decision: 'block',
    reason,
    ...(systemMessage ? { systemMessage } : {}),
  });
}
```

### OQ3: `hook-registry.ts` Stop 훅 통합

**RESOLVED — 구조적 블로커 없음.**

- `HookEventType` 유니온에 `'Stop'` 이미 포함 (src/hooks/hook-registry.ts:21).
- 등록 절차 확인(`hooks/hook-registry.json` + `dist/hooks/*.js`): 기존 `post-tool-use`, `pre-tool-use`, `solution-injector` 등과 동일 패턴.
- 추가 작업: `hooks/hook-registry.json` 에 stop-guard 엔트리 + `src/hooks/stop-guard.ts` 신규 구현 + build 시 `dist/hooks/stop-guard.js` 자동 생성.
- tier 분류: `compound-core` (개인화 규칙 강제 = compound 피드백 루프 본질).

### Day 1 최종 판정

**A1 가정은 프로토콜 수준에서 완전 검증.** 남은 검증은 A2 (Claude 가 reason 을 실제로 수용·준수하는가). 이는 Day 3~4 시나리오 실행에서 측정.

**β1 ($0) 재확인**: Stop block → 다음 턴은 동일 Claude Code 세션 내에서 발생. 외부 API 호출 신규 생성 없음. 사용자가 수기로 "다시 해" 입력한 것과 비용 구조 동일. 따라서 **β1 유지**.

**ADR-001 현재 상태 유지**: Proposed. Day 5 종합 판정 후 Accepted 로 전환 또는 Reversal 결정.

---

## Day 2 — Scenario Spec + Prototype (대기)

Day 1 결과를 반영한 Day 2 선결 조정사항:

1. **`scenarios.json` 설계 반영**:
   - self-check 질문을 **`reason` 필드 전체**에 담기 (100~300자). 질문 형식은 "직전 응답 전 <증거 조건>이 충족됐는가? 없다면 <행동 지시>" 가 Ralph 패턴과 호환.
   - `systemMessage` 에는 `"rule: <rule_id> — <1-line policy>"` 만.
2. **prototype scope 확정**:
   - `src/hooks/stop-guard.ts` 신규 — 완료선언 패턴 스캔 + enforce_via=Mech-A/B 규칙 verifier 실행 + block/approve 결정
   - `src/hooks/shared/hook-response.ts` 에 `blockStop()` 추가
   - `hooks/hook-registry.json` 에 stop-guard 엔트리 추가
3. **runner.mjs 설계**:
   - 각 시나리오마다 `forgen` 런처(wraps Claude)로 headless 세션 구동
   - 세션 종료 후 `~/.forgen/state/enforcement/{session_id}.jsonl` 과 `~/.forgen/state/hook-timings/*.json` 수집
   - pass/fail 라벨링: scenario.expected 와 JSONL event sequence 매칭

**Day 2 deliverables**:
- `tests/spike/mech-b-inject/scenarios.json` (10개)
- `src/hooks/stop-guard.ts` prototype (v0.4.0 후보 아님, spike-only branch 에서)
- `src/hooks/shared/hook-response.ts` — `blockStop()` helper 추가

### Day 2 선결 블로커

**Claude Code 실행 headless 가능성** — Day 2 초반 확인 필요. 불가능하면 runner 대신 수기 시나리오로 전환(시간 비용 +1 day).

---

## Day 3~5 — TBD

시나리오 실행 + 결과 분석 + 최종 판정. 계획 문서 §Timeline 참조.

---

## Amendments Log

- **2026-04-22**: Day 1 completed. A1 prototocol-level verified; β1 confirmed. Helper `blockStop()` specified. Ready for Day 2.
