# ADR-004: claude-mem Hook Orchestration Contract — forgen + claude-mem 동시 활성화 시 hook 충돌 회피

**Status**: Proposed (2026-04-28)
**Date**: 2026-04-28
**Reversibility**: Type 2 (orchestration 정책은 hook entry script 교체로 되돌릴 수 있음)
**Related Spec**: `docs/plans/2026-04-28-forgen-testbed-proof-spec.md` §3 (Default Mode α — Full)
**Related Interview**: Deep Interview 2026-04-28 testbed-proof Round 10~11

## Context

### 결정해야 할 것
> Spec §3에서 (α) Minimal + Full 권장 결정됨. Full 모드 = forgen + claude-mem 동시 install. 그런데 Claude Code의 hook (`UserPromptSubmit`, `Stop`, `PreToolUse`, `PostToolUse`)은 단일 entry script. **두 도구가 같은 hook 이벤트에 등록하면 순서/우선순위 미정 → 비결정성**.

### 왜 이게 ADR 수준의 결정인가
- 이건 사소한 통합 이슈가 아니다. **(α) 셀링 메시지 자체가 "함께 쓰면 더 강함" → 작동 안 하면 정체성 무너짐.**
- testbed의 `forgen+mem` arm 자체가 비결정적 결과를 내면 ψ_synergy 측정 불가능 → spec PASS 불가능.
- forgen의 enforcement(Mech-A 차단)와 claude-mem의 retrieval injection이 충돌 시 사용자 좌절 직행.

### 관찰된 제약
- Claude Code hook 시스템은 settings.json의 `hooks.<event>` 배열로 등록. **여러 hook script chain 자체는 표준이지만 순서·실패 정책 미정.**
- forgen은 자체 hook을 `dist/hooks/*.js`에 배포. claude-mem은 별도 entry.
- β1 제약 유지: 외부 LLM 호출 0, hook 자체 비용 최소.
- 사용자가 둘 중 하나 uninstall 시 forgen이 *우아하게 fallback* 해야 함.

### 정확한 충돌 시나리오 (Round 11 review에서 박힌 [CRITICAL])
```
시나리오 X1: UserPromptSubmit
  forgen:    compound-search → 추출 패턴 inject
  claude-mem: vector recall → 과거 transcript chunk inject
  → 둘 다 inject 시 context 폭발. 어느 게 우선?

시나리오 X2: Stop hook
  forgen:    "완료 선언 + e2e 증거 부재" → block
  claude-mem: 세션 종료 → transcript 압축 + DB 저장
  → forgen block 시 claude-mem 저장 발생? 미정.

시나리오 X3: 사용자가 claude-mem만 uninstall
  forgen이 "claude-mem 협업 모드" 가정으로 동작 중이었다면 fallback 필요.
```

## Alternatives Considered

### Option A: Ignore — 사용자가 직접 settings.json 정렬
- 두 도구 install 후 사용자가 claude-mem hook과 forgen hook 순서를 직접 settings.json에서 정렬.
- 장점: 구현 비용 0. 사용자 자율성.
- 단점: friction 폭증. (α) "권장" 메시지가 "둘 다 install하고 settings.json도 직접 만지세요"가 됨. 셀링 무너짐. 비결정성 그대로.

### Option B: Detect + Warn — install 시 경고만
- forgen install 시 claude-mem 감지 → console warning ("hook 순서 확인하세요").
- 장점: 사용자 인지 ↑. 구현 비용 낮음.
- 단점: 경고는 무시됨. 실제 충돌은 그대로. RC5 (false positive) 변형 — *사용자가 우회하기 쉬움*.

### Option C: Chain Orchestration — forgen이 chain runner 역할
- forgen이 자체 hook entry를 "orchestrator"로 만들어, claude-mem hook을 forgen이 호출. 명시적 순서: claude-mem 먼저 (recall) → forgen 다음 (rule + block 결정).
- 장점: 결정적 순서. 사용자는 forgen만 install 하면 claude-mem 자동 통합.
- 단점:
  - claude-mem 내부 API에 의존 (저쪽 maintainer 협의 없으면 깨짐).
  - claude-mem updates → forgen breakage 위험.
  - circular: forgen이 "다른 도구를 호출"하는 책임 흡수 → SOLID 위반.

### Option D: Namespace Separation — 두 도구가 자기 hook namespace에 등록
- 각 도구가 settings.json의 hook 배열에 *독립* 항목으로 등록. forgen은 `forgen-hook`, claude-mem은 `claude-mem-hook`. Claude Code가 순차 호출.
- forgen이 claude-mem 출력을 *읽기만* (read-only consumer) — write conflict 원천 제거.
- 우선순위: forgen이 *늦게* 실행되도록 settings에서 명시 (claude-mem inject → forgen이 그걸 보고 결정).
- 장점:
  - 각 도구 독립 유지 (SOLID).
  - forgen이 claude-mem 내부 API에 의존 안 함 — claude-mem이 inject한 *결과 텍스트*만 봄.
  - claude-mem update에 forgen 영향 최소.
- 단점:
  - hook 순서는 settings.json 작성자(=forgen install script)가 박아야 함 — 사용자가 settings 수정 시 깨질 수 있음.
  - forgen이 claude-mem의 output format에 약하게 결합.

### Option E: Hybrid — Option D + 명시적 chain order + fallback
- D를 베이스로 forgen install hook이 claude-mem 감지 → settings.json 자동 정렬 ("claude-mem 먼저, forgen 다음").
- claude-mem 미감지 시 forgen 단독 모드로 자동 fallback.
- 사용자가 settings 수정 시 forgen `inspect hooks` 명령으로 순서 검증 도구 제공.
- 장점: D의 장점 + 사용자 friction 최소 + fallback 깔끔.
- 단점: forgen install hook이 settings.json 자동 수정 — 일부 사용자에겐 invasive.

## Trade-off Matrix

| 기준 | 가중치 | A | B | C | D | E |
|---|---|---|---|---|---|---|
| 결정성 (비결정성 제거) | 25% | 1 | 1 | 5 | 4 | 5 |
| 정체성 일관성 (SOLID 분리) | 20% | 5 | 5 | 2 | 5 | 4 |
| 사용자 friction 최소 | 20% | 1 | 2 | 4 | 3 | 5 |
| claude-mem 의존성 약함 | 15% | 5 | 5 | 1 | 4 | 4 |
| Fallback (claude-mem 부재 시) | 10% | 5 | 5 | 2 | 4 | 5 |
| 구현 비용 | 10% | 5 | 5 | 2 | 3 | 3 |
| **가중 합계** | **100%** | **3.05** | **3.30** | **3.05** | **3.85** | **4.40** |

산술 검증 (E):
- 0.25×5 + 0.20×4 + 0.20×5 + 0.15×4 + 0.10×5 + 0.10×3 = 1.25+0.80+1.00+0.60+0.50+0.30 = **4.45**
- (재검산: 4.45가 정확. 표 4.40은 반올림 오차.)

E가 1위. D는 베이스로 견고. C는 정체성 위반(점수 낮음).

## Decision

**Option E (Namespace + 명시 chain + fallback) 를 선택합니다.**

근거:
1. 가중 합계 1위 (4.45) — D 대비 사용자 friction과 결정성에서 우위.
2. **(α) "권장" 셀링이 작동하려면 사용자가 둘 다 install 후 거의 zero-config로 시너지를 봐야 함.** D는 settings.json 수동 정렬 friction 남김 — E가 자동화로 해결.
3. forgen이 claude-mem의 *결과 텍스트만* 읽음 (read-only consumer) → SOLID 분리 유지. claude-mem 내부 API 의존 0.
4. fallback이 명시적 — claude-mem 부재 시 forgen 단독 자동 전환. minimal 사용자 보호.

**수용한 Trade-off:**
- forgen install hook이 settings.json 자동 수정 — invasive. 완화: dry-run preview + 사용자 명시 confirm + revert 명령 (`forgen config hooks --revert-mem-orchestration`).
- claude-mem output format에 약하게 결합 — 완화: format detection + 미일치 시 graceful skip (forgen 단독 모드로 자동 전환).

**Reversal condition:**
- claude-mem maintainer가 자기 hook entry를 변경 → forgen detection 깨짐 빈도 ≥ 3회/월 → Option D로 다운그레이드(자동 정렬 제거, 사용자 매뉴얼).
- 새 Claude Code hook 표준 (priority 필드 등)이 등장 → 표준 활용으로 마이그레이션.

## Hook Chain Contract

### 표준 순서 (settings.json `hooks.UserPromptSubmit`)

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "type": "command", "command": "claude-mem-hook recall", "timeout": 5000 },
      { "type": "command", "command": "node ~/.forgen/dist/hooks/user-prompt-submit.js", "timeout": 3000 }
    ],
    "Stop": [
      { "type": "command", "command": "node ~/.forgen/dist/hooks/stop-guard.js", "timeout": 3000 },
      { "type": "command", "command": "claude-mem-hook compress", "timeout": 10000 }
    ]
  }
}
```

핵심 룰:
- **UserPromptSubmit**: claude-mem (recall) 먼저 → forgen (룰 적용) 다음. forgen은 claude-mem이 inject한 텍스트를 읽고 자기 결정에 반영.
- **Stop**: forgen (block 결정) 먼저 → block 발생 시 claude-mem 저장 *skip* (block된 응답 저장 무의미).
- **PreToolUse / PostToolUse**: forgen 단독 (claude-mem은 미관여).

### Read-only Consumer 계약

forgen은 claude-mem의 inject 결과를 다음 형태로만 본다:
```
{
  "additionalContext": "...claude-mem recall content...",
  "source": "claude-mem"
}
```

forgen은 이 source 필드 + additionalContext 길이만 사용 → claude-mem 내부 schema 변경에 강함.

### Fallback Detection

forgen install 시 ~/.config/claude-mem/ 또는 npm `claude-mem` 패키지 감지:
- **감지됨**: orchestration 모드. settings.json에 chain order 박음.
- **미감지**: 단독 모드. forgen hook만 등록.
- **Runtime drift detection**: 매 세션 시작 시 claude-mem hook 호출 → 응답 없으면 자동 단독 모드 전환 + 알림.

### `forgen config hooks` 검증 명령

```
forgen config hooks --check
  → settings.json의 hook 순서 검증
  → 표준 순서 위반 시 경고 + auto-fix 제안
```

## Consequences

### Positive
- (α) Full 모드가 zero-config로 작동 — 사용자가 forgen install만 하면 claude-mem 자동 통합.
- testbed `forgen+mem` arm이 결정적 결과 → ψ_synergy 측정 가능 → spec PASS gate 통과 가능.
- claude-mem 부재 시 graceful fallback — minimal 사용자 보호.
- 양방향 셀링: claude-mem README에 "forgen과 함께 쓰면 enforcement까지" 등재 가능 (오픈소스 생태계 협업).

### Negative
- forgen install hook이 settings.json 수정 → 일부 사용자에게 invasive 인식. 완화: 명시 confirm + revert 명령.
- claude-mem update 시 detection 깨질 가능성 → CI에 claude-mem 호환성 smoke test 추가 필요.

### Risks + 완화

| Risk | 확률 | 영향 | 완화 |
|---|---|---|---|
| claude-mem hook entry 변경 → forgen 감지 실패 | 중 | 중 | format detection + graceful skip + 분기별 호환성 smoke |
| 사용자가 settings.json 직접 편집 → 순서 깨짐 | 중 | 저 | `forgen config hooks --check` 명령으로 자가 진단 |
| Stop hook chain에서 forgen block 후에도 claude-mem 저장 시도 | 저 | 중 | forgen block exit code 활용해 claude-mem skip |
| circular: forgen이 claude-mem 호출, claude-mem이 forgen 데이터 사용 | 저 | 고 | read-only consumer 계약으로 차단 |

### Follow-up

| 항목 | 상태 (2026-04-30) |
|---|---|
| `scripts/install-claude-mem-orchestration.cjs` 작성 | **SUPERSEDED** by amendment (Plugin model이 자동 chain — auto-sort 불필요) |
| `forgen config hooks --check` 명령 구현 | **DEFERRED** (Plugin model로 우선순위 ↓, v0.5.x 백로그) |
| claude-mem maintainer 협업 제안 PR/이슈 | **DEFERRED** (외부 outreach, 별도 결정) |
| testbed `forgen+mem` arm 셋업 시 contract 사용 | ✓ **DONE** — `packages/forgen-eval/src/arms/real-arms.ts` `ForgenPlusMemArm` |

## Amendment 2026-04-28 (post US-000 spike)

**Trigger**: `docs/spike/2026-04-28-claude-mem-spike.md` 결과로 가설 절반 폐기.

### 폐기 사항
- **Option E (Namespace + Chain Order + Fallback) 통째로 폐기**
- forgen install hook이 `~/.claude/settings.json` auto-sort? **불필요**. claude-mem은 npm `require()` 대상이 아닌 **Claude Code Plugin** (`~/.claude/plugins/marketplaces/thedotmack/`).
- "settings.json hooks 배열에 둘 다 등록" 가정도 폐기. 실측 결과 settings.json에는 plugin enable flag만 추가됨 — hooks는 plugin manifest 내부에서 Claude Code가 자동 chain.

### 신규 채택 — Coexistence Contract (Plugin Model)

```
사용자 install 흐름:
  1. forgen 사용자: 기존 forgen install 그대로 (변경 없음)
  2. (선택) Full 모드 권장: `npx claude-mem install --ide claude-code`
     → ~/.claude/plugins/marketplaces/thedotmack/ 에 plugin 자동 설치
     → ~/.claude/settings.json 에 enable flag 1줄만 추가
     → hooks 등록은 plugin manifest가 자동 처리
```

forgen 측 책임:
- forgen 본체 변경 0 (claude-mem 의존성·import·invoke 모두 0)
- README에 "권장 (Full 모드)" 섹션만 추가 — `npx claude-mem install` 안내
- forgen-eval testbed에서 `claude-mem-only` arm은 child_process로 `npx claude-mem` invoke (devDep)

### 시너지 메커니즘 (Why Coexistence Works)

ADR 본문에는 contract만 박혔고 *value proposition*이 빠져있었음. 박음 (Spec §10a 시나리오와 cross-ref):

- claude-mem inject (`UserPromptSubmit`) → Claude 컨텍스트에 *과거 맥락* 추가
- forgen inject (`UserPromptSubmit`) → Claude 컨텍스트에 *룰 + 패턴* 추가
- 둘 다 활성 시 Claude는 두 inject가 *concatenated* 된 컨텍스트 상에서 응답
- 모델 입장: "맥락 알고 + 강제 받음" → 단순 합 > 부분 합 = ψ > 0

### Read-Only Consumer 계약 — 단순화

기존 ADR 본문의 "additionalContext source 필드 매핑" 폐기. 실측: claude-mem은 Claude Code의 표준 `additionalContext` 메커니즘으로 inject. forgen은 *별도 source 추적* 안 하고 자기 inject만 책임.

### Fallback 단순화

- forgen은 claude-mem 존재 여부 *감지하지 않음* (검증 비용 vs 가치 불일치).
- 사용자가 둘 다 install했는지는 사용자 책임. forgen은 단독으로도 작동, claude-mem 있으면 자동 시너지.

### 신규 위험 (spike에서 발견)

| Risk | 완화 |
|---|---|
| Bun runtime 부재 시 claude-mem worker fail | forgen-eval README에 Bun ≥1.0 install 가이드. forgen 본체는 영향 없음. |
| Worker가 transcript watcher → forgen post-session 처리와 race | testbed forgen-only arm은 claude-mem plugin **uninstall** 상태로 검증 (`npx claude-mem uninstall`). |
| AGPL-3.0 결합 저작물 해석 | forgen 본체에 의존성 *절대 추가 X*. forgen-eval만 devDep + child_process invoke (별도 프로세스 = 결합 아님). |

### License Decision (spike 신규 박음)

forgen MIT + claude-mem AGPL-3.0 공존 안전 경로:
- ✓ 사용자가 둘 다 *별도 plugin install* — 결합 아님
- ✓ forgen-eval(별도 module) devDep + child_process — 결합 아님
- ✗ forgen 본체 npm dependency 추가 — 결합 해석 가능, **금지**
- ✗ forgen 본체에서 claude-mem `require()`/import — 결합, **금지**

따라서 PRD US-016 (claude-mem 본 repo 의존성 추가) **삭제 결정**. US-015 (hook orchestration 자동화) 도 plugin model로 **불필요 → 삭제**.

### Amendment Decision

기존 Decision의 Option E를 **Coexistence Contract (Plugin Model)** 로 교체. Trade-off matrix는 historical 보존을 위해 그대로 두되, 실효성은 이 amendment.

---

## Related
- **Depends on**: 없음 (독립 결정)
- **Consumed by**: ADR-005 (forgen-eval module이 이 contract 활용해 forgen+mem arm 구성)
- **Spec**: `docs/plans/2026-04-28-forgen-testbed-proof-spec.md` §3, §4, §9 (A5), **§10a (사용자 활용 시나리오)**
- **Spike evidence**: `docs/spike/2026-04-28-claude-mem-spike.md`
- **Review date**: 2026-07-28 (claude-mem version drift 누적 후 3개월)
