# ADR-007: forgen-eval Testbed Arm Isolation — ForgenPlusMemArm single-session 결합 + claude-mem 콘텐츠 fetch

**Status**: Accepted (2026-05-08)
**Date**: 2026-05-08
**Reversibility**: Type 2 (arm 구조 변경 가능. 단 본 ADR 이전 측정값들은 모두 재산정 필요 — 명시적 disclaimer 첨부)
**Related ADR**: ADR-005 (forgen-eval 모듈 아키텍처), ADR-006 (PASS gate metric)
**Affected**: 모든 ψ-stat 측정 보고 (v0.4.4 release note 포함)

## Context

### 무엇을 박제하는가

2026-05-08 정성 분석 (probe-mem-inject) 결과 forgen-eval 의 `ForgenPlusMemArm`
및 mem recall 경로에 두 개의 구조적 결함이 식별됐다:

**결함 1 — ForgenPlusMemArm 비-결합**

이전 구현 (`src/arms/real-arms.ts:264-282` pre-25c8ac0):

```ts
override async runCase(c, ctx) {
  const forgen = await super.runCase(c, ctx);   // forgen-only LLM 세션 (call A)
  const memArm = new ClaudeMemOnlyArm();
  const mem = await memArm.runCase(c, ...);     // mem-only LLM 세션 (call B, 응답 폐기)
  return {
    ...forgen,
    injectEvents: [...forgen.injectEvents, ...mem.injectEvents],
    finalResponse: forgen.finalResponse,         // forgen 응답만 채택
  };
}
```

`full` arm 은 **forgen + mem coexistence 를 한 LLM 세션 안에서 결합하지 않고**
별개의 두 LLM 호출을 각각 돌린 뒤 forgen 응답만 채택했다. Driver 가
`qwen2.5:14b @ temperature=0.3` 비결정 호출이라:

- `forgenOnly.finalResponse` = 러너의 ForgenOnlyArm 호출 (LLM call X)
- `full.finalResponse` = ForgenPlusMemArm.super.runCase 호출 (LLM call Y)

X 와 Y 는 동일 분포 (LLM | forgen rules) 에서 두 번 샘플링한 결과. 따라서:

- `full.W − forgenOnly.W` ≈ **LLM stochastic noise** (양/음 ±0.3 양방향)
- ψ = full.W − max(forgenOnly.W, memOnly.W) ≈ noise + max-selection bias

즉 ψ 는 forgen+mem coexistence 신호 대신 LLM 분산을 측정.

**결함 2 — mem recall 메타 inject**

이전 mem recall 경로는 `npx claude-mem search "<query>"` CLI 출력을 그대로
inject 했는데, 본 명령은 검색 결과 *테이블* (세션 ID + 제목 + 읽기 횟수) 만
반환하지 실제 과거 콘텐츠가 아니다:

```
{"content":[{"type":"text","text":"Found 63 result(s) matching ... \n
| ID | Time | T | Title | Read |\n| #576 | 6:11 PM | 🔵 | Title... |\n..."}]}
```

LLM 컨텍스트로 들어가는 게 "과거에 이런 세션이 있었다" 는 메타 표 이지 실제
recall 이 아님. 5개 음수 케이스 정성 분석 결과, 이 메타 inject 가 LLM 응답을
verbose / cautious / "context 더 주세요" 쪽으로 shift 시키고, sonnet judge 는
이를 actionable advice 부족으로 채점 강하 (γ↓, β↓).

### 영향 범위

이 두 결함 위에서 산출된 모든 ψ 측정은 **신호가 아닌 noise/메타 효과를 측정**.
구체적으로:

| 측정 | mean ψ | CI | 결함 arm | 결함 mem |
|---|---|---|---|---|
| v0.4.4 release note (haiku judge) | +0.098 | [+0.002, +0.222] PASS | ✓ | ✓ |
| 2026-05-07 track2rev (sonnet, broken arm) | +0.023 | [-0.056, +0.120] FAIL noise | ✓ | ✓ |
| 2026-05-08 track-armfix (sonnet, fixed arm only) | -0.044 | [-0.085, -0.002] FAIL signal | (fixed) | ✓ |
| 2026-05-08 track-mem-fix (sonnet, both fixed) | TBD (run in flight) | TBD | (fixed) | (fixed) |

## Decision

### 결정 1 — ForgenPlusMemArm single-session 결합

`Arm` interface 를 직접 implement 하고 한 LLM 세션 안에서 forgen UPS rule
inject 와 claude-mem recall 을 둘 다 system message 로 주입한 뒤 한 번 chat
→ forgen Stop guard 로 평가. coexistence 의 실제 cross-talk 효과를 측정 가능.

```ts
class ForgenPlusMemArm implements Arm {
  async runCase(c, ctx) {
    const history = [{role: 'system', content: baseSystem(c.personaId)}];
    const injectBoth = async (userMsg) => {
      // forgen UPS hook (rule 주입) + claude-mem recall (콘텐츠 주입)
      // 둘 다 history 에 system message 로 push
    };
    const stopMaybeBlock = async (response) => { /* forgen Stop guard */ };

    for (const turn of c.correctionSequence) {
      await injectBoth(turn.userMsg);
      history.push({role: 'user', content: turn.userMsg});
      const raw = await DRIVER.chat(history);
      history.push({role: 'assistant', content: await stopMaybeBlock(raw)});
    }
    await injectBoth(c.trigger.prompt);
    history.push({role: 'user', content: c.trigger.prompt});
    const finalResponse = await stopMaybeBlock(await DRIVER.chat(history));
    return { ..., finalResponse, blockEvents, injectEvents };
  }
}
```

구현: commit `25c8ac0`.

### 결정 2 — claude-mem 콘텐츠 직접 fetch

`claude-mem search` 의 검색 결과 표를 그대로 inject 하지 않고, ID 를 파싱한 뒤
`~/.claude-mem/claude-mem.db` (env `CLAUDE_MEM_DB` override 가능) 의
`observations.{title, narrative, text}` / `session_summaries.{request, learned,
completed}` 를 sqlite3 CLI 로 직접 조회해 실제 콘텐츠를 inject.

```ts
function claudeMemRecallActual(userMsg, topN = 2): string {
  // 1. claude-mem search → JSON 파싱 → table row 의 #NNN / #SNNN ID 추출
  // 2. sqlite3 ~/.claude-mem/claude-mem.db 에서 narrative / learned 조회
  // 3. 상위 N hit 콘텐츠 concat ([#ID]\n<content> 포맷)
  // 4. 어떤 단계든 실패하면 '' (graceful, mem-uninstalled 호환)
}
```

구현: commit `d65b4a4`.

### 결정 3 — 이전 측정 disclaimer 첨부

본 ADR 이전 모든 ψ-stat 측정 보고서 (v0.4.4 release note 포함) 에는 "ADR-007
이전 testbed 결함 위에서 산출됨" disclaimer 를 명시. 측정값 자체는 보존하되
재측정 결과로 갱신.

## Consequences

### Positive

- ψ 가 실제 forgen+mem coexistence 신호를 측정 (이전: LLM noise + 메타 inject 효과)
- 음수 ψ 가 나오면 진짜 cross-talk 결함이 있는 것 (디버깅 액션 가능)
- 양수 ψ 가 나오면 진짜 forgen+mem 결합 효과 (셀링 가능)

### Negative

- 이전 측정 결과 모두 무효화 (v0.4.4 release note 의 mean ψ=+0.098 PASS 포함)
- 재측정 비용: N=10 sonnet 약 70분, N=30 약 3시간
- v0.4.5 이상 릴리스에서 새 baseline 박제 필요

### 회귀 가드

- `tests/arms/forgen-plus-mem.test.ts` (TBD) — full arm 의 finalResponse 가
  forgen 만 또는 mem 만이 아닌 "둘 다 inject 된 후의 LLM 응답" 임을 검증
- inject events 에 `forgen-rule-inject` + `mem:claude-mem-recall` 둘 다
  포함되는지 검증
- claude-mem DB 미설치 환경에서도 graceful no-op 동작 검증

## Probe 데이터 (정성 분석 evidence)

5개 음수 ψ 케이스 (track-armfix N=10 sonnet, fixed arm only / broken mem):

| 케이스 | 페르소나 | forgenOnly W | full W | Δ | 정성 패턴 |
|---|---|---|---|---|---|
| syn-002 | django-orm 마이그레이션 | 0.646 | 0.583 | -0.063 | full 이 단계별 careful → 한 방 처리로 회귀 |
| syn-005 | unsafe-block-review | 0.396 | 0.317 | -0.079 | full 이 "코드 더 주세요" cautious shift |
| retro-001 | docker-e2e-required | 0.846 | 0.683 | -0.163 | 사실상 같은 메시지인데 워딩 차이로 β 1.5 ↓ |

mem 콘텐츠 fetch fix 후 재측정 (track-mem-fix N=10 sonnet) 결과는 측정 완료 후
본 ADR Probe 데이터 섹션에 갱신.

## References

- 결함 발견 세션 transcript: 2026-05-08 (커밋 `25c8ac0`, `d65b4a4` 메시지에 상세)
- ADR-005 forgen-eval 모듈 아키텍처
- ADR-006 PASS gate metric methodology
- 측정 보고서: `packages/forgen-eval/reports/psi-stat/`
