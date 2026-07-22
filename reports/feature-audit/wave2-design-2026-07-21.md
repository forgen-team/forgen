# Wave 2 설계 스펙 (구현 전 논의) — 2026-07-21

> 로드맵 초안의 Wave 2 채택 후보 5개를 실제 코드에 대조. **핵심: 5 중 4가 이미
> 구현돼 있다.** "설계 먼저"가 재구현을 막았다. 아래는 실측 현황 + 진짜 델타 설계.

## 0. 실측 현황 대조 (재구현 방지)

| 후보 | 상태 | 근거 (파일:심볼) |
|---|---|---|
| **W2-1** 패턴 신뢰도 공유 | ✅ 완료 | `compound-share.ts` — `ShareBundlePatternV1{confidence,status,evidence,contentHash}` + import probation(×0.5, experiment 천장). `forgen compound export/import` (PR #70 d141795) |
| **W2-2** 3층 토큰효율 회상 | ✅ 완료 | `solution-injector.ts` Tier0(단독 전문 ≤1200)/Tier2(요약 300)/Tier1(인덱스+compound-read 힌트)/Tier3(MCP compound-read) (PR #70 6f2d9f9) |
| **W2-3** TTL 프루닝/감쇠 | 🟡 대부분 | `lifecycle/trigger-t4-decay.ts`(90일 미주입→retire) + `compound-lifecycle.ts STALENESS_DAYS`(status별). **없는 것**: 점진적 confidence 감쇠(현재는 binary retire), 미승급 후보 pending-TTL |
| **W2-4** 프로젝트 스코핑+주입상한 | ✅ 완료 | `solution-injector.ts:497` `resolveScope(cwd)` → `matchSolutions(prompt, scope, cwd)` 프로젝트 필터; `MAX_SOLUTIONS_PER_SESSION` + `context-budget solutionSessionMax(8000)` + `INJECTION_HARD_CAP_CHARS(4000)`. scope=me/team/project/universal |
| **W2-5** `<private>` 캡처 제외 | ❌ 신규 | 캡처 경로(compound-extractor/reflection, correction-record)에 private/exclude 태그 부재 |

**결론**: Wave 2를 "5기능 채택 웨이브"로 지으면 대부분 no-op(이미 있음). 진짜 신규
작업은 **W2-5(private 태그)** 1개 + **W2-3 얇은 델타(confidence 감쇠 곡선)** 정도.

## 1-IMPL. W2-5 구현 결과 (2026-07-21, flow-reviewer 리뷰 후 확정)

> **구현이 설계보다 넓어졌다.** 설계는 캡처 3경로를 나열했으나, 적대적 리뷰 결과
> **학습 코퍼스로 사용자 텍스트가 들어가는 주 자동 경로가 미포함**이었다. 실제 와이어는
> **6경로 + fail-closed regex**로 확장. (아래 §1 은 원설계 — 이력 보존용으로 남김.)

**실제 와이어된 캡처 경로 (6):**
1. `mcp/tools.ts` correction-record — message/target strip, 통째 private 시 저장 skip + 공지. *(설계 포함)*
2. `engine/compound-extractor.ts` processExtractionResults — sol.content/context strip, 통째 skip. *(설계 포함)*
3. `hooks/compound-reflection.ts` isReflectionCandidate — 매칭 전 code strip. *(설계 포함)*
4. **`core/auto-compound-runner.ts`** — 세션종료 주 자동 추출기. redactSecrets 옆 stripPrivate(LLM 송신·behavior write 전). *(리뷰 SEV-2 추가)*
5. **`hooks/context-guard.ts` appendPromptHistory** — prompt-history.jsonl 영속 전 strip(→ extraction-session 재읽기 정화). *(리뷰 SEV-2 추가)*
6. **`core/session-store.ts`** indexSession/indexCodexSession — FTS 인덱싱 전 strip, 통째 private 메시지 스킵. *(리뷰 SEV-2 추가)*
   + (보너스) `hooks/pre-tool-use.ts` reflection tag-fallback raw-code 매칭 갭 소스 strip.

**regex fail-closed** (리뷰 SEV-2): 미닫힘 `<private>` → EOF 까지 제거(닫기 잊은 사용자 보호),
중첩 depth 카운팅, 공백/속성 태그(`<private foo>`) 허용, `/* forgen:private` 블록주석 마커.
"프라이버시 필터는 사용자 실수에 fail-open 하면 안 된다"는 원칙.

**검증**: private-filter 13 + session-store-private 통합(실 sqlite) + context-guard-main(prompt-history 실측)
+ extractor/reflection 회귀. 전체 vitest 2899 pass, self-gate/runtime/smoke green.
**미테스트(정직)**: auto-compound-runner 는 top-level 즉시실행 스크립트라 유닛테스트 부적합 —
순수함수 stripPrivate 테스트 + 코드리뷰로 커버.

---

## 1. W2-5 — `<private>` 캡처 제외 태그 (원설계, 이력 보존)

**출처**: claude-mem `<private>` 태그. **정합**: $0-로컬·프라이버시 우선 도구에 직결,
캡처 신뢰도↑. **난이도 S.**

### 설계
- **입력 표면**: 사용자가 응답/교정/코드에 `<private>...</private>`(또는 라인 마커
  `// forgen:private`)를 넣으면 그 범위는 compound 추출·correction 캡처·solution
  저장에서 **제외**.
- **적용 지점** (캡처 3경로):
  1. `compound-extractor.ts` — 세션 요약→솔루션 추출 시 private 범위 스트립.
  2. `compound-reflection.ts` 훅 — 반성 캡처 시 제외.
  3. `correction-record` (MCP tools.ts) — 교정 메시지에 private 있으면 저장 skip/마스킹.
- **인터페이스** (신규 유틸 `src/engine/private-filter.ts`):
  ```ts
  /** <private>…</private> 및 라인 마커 범위를 제거한 텍스트. 완전 private면 '' 반환. */
  export function stripPrivate(text: string): { cleaned: string; hadPrivate: boolean };
  /** 캡처 대상이 통째 private면 저장 자체를 skip 할지 판정. */
  export function isFullyPrivate(text: string): boolean;
  ```
- **정직성 가드**: private 제외는 *조용히* 하지 않고, 캡처 스킵 시 debug 로그 +
  (선택) "1건 private 제외" 한 줄 공지. 비밀 유출 방지와 별개 축(secret-filter는 유지).
- **테스트**: 부분 private 스트립, 완전 private skip, 마커 3형식, 캡처 3경로 각각,
  secret-filter와 상호작용(둘 다 발화 시 우선순위).

## 2. W2-3 얇은 델타 — confidence 점진 감쇠 (**DEFER 확정, 2026-07-22**)

> **결정: 착수하지 않는다 (defer).** 데이터 검토 결과 감쇠는 *관측되지 않는 문제*를 위한 해법.
> 실측(match-eval-log 2891건/65일 + 실 코퍼스): 표출의 **84.1%가 단일후보**(감쇠 무관, threshold만
> 작동), 7월 다중후보 경쟁 **57건 전부 합성 픽스처**(실 솔루션 낀 경쟁 0), ROI강등 축 `{}`(0건 발화),
> 방치→binary retire 지연 17~24일(이미 청소). 랭킹식 `relevance = blendedScore × confidence` 상
> 감쇠는 다중후보에서만 영향인데, 매칭이 쿼리 게이트라 낡은 주제는 confidence 무관하게 후보에서 사라짐
> (쿼리 게이팅은 코퍼스 크기와 독립 → 스케일 논증 아님). ROI/T4/감쇠 3중 축 중복 리스크를 없는 문제에
> 도입하는 셈이라, honest-measurement("없는 갭을 갭이라 하지 않는다")를 기능에 적용해 보류.
> **재검토 트리거**: (a) 실 솔루션 간 다중후보 경쟁이 일상적이고 (b) 같은 쿼리에서 stale이 fresh를
> 실제 역전하는 사례가 로그에 관측될 때. 착수 시 리뷰 기준: 감쇠 파라미터 실측근거 기반(임의 상수 금지),
> 되돌림/복구 경로 필수. — 아래 원설계는 트리거 충족 시 참조용으로 보존.

**현황**: T4가 90일 미주입 시 binary retire. ECC식은 신뢰도가 *점진* 감쇠(장기
미관측→0.9→0.7…). **델타**: retire 전 단계로 confidence를 시간에 따라 낮춰 주입
우선순위를 자연 하강시키면, "낡았지만 아직 안 죽은" 솔루션이 조용히 뒤로 밀린다.

### 설계 (있으면 좋은 정도 — ROI/T4와 축 중복 주의)
- `compound-lifecycle.ts`에 `applyTimeDecay(sol, nowDays)`: `last_inject_days_ago`가
  status별 grace 초과 시 confidence를 완만히 감산(예: 초과 30일당 −0.05, 하한 0.05).
- **주의**: ROI 강등(surfaced≫acted)·T4 retire와 **3중 축**이 되지 않게 — 감쇠는
  "미관측(주입 안 됨)" 축, ROI는 "관측되나 안 쓰임" 축, T4는 "감쇠 하한 도달→retire".
  세 축의 상호작용을 문서화하고 이중 처벌 방지.
- **판단**: 실익 대비 복잡도. **W2-5 먼저, W2-3 감쇠는 데이터로 필요성 확인 후.**

## 3. 로드맵/경쟁분석 정정 (정직성)

경쟁 리포트(oss-comparison, feature-scout)가 forgen을 "⚠️ tarball 통짜 / ❌ full
inject / ⚠️ budget만"으로 표기했으나 **실측은 그 너머**(compound-share·tiered
injection·scope 필터·budget cap 전부 구현). → 경쟁 매트릭스의 해당 셀을 forgen ✅로
정정하고, "채택 갭"이 실은 갭이 아님을 기록. (honest-measurement 원칙을 로드맵 자체에
적용 — 없는 갭을 갭이라 하지 않는다.)

## 4. 권고 (구현 착수안)

1. **W2-5 (private 태그)** — 유일한 진짜 신규, 프라이버시 가치, 난이도 S. 착수 권고.
2. **경쟁분석/로드맵 정정** — W2-1/2/4 완료 반영(문서 1커밋).
3. **W2-3 감쇠** — 선택. private 이후 데이터로 필요성 판단.

→ Wave 2는 "5기능 웨이브"가 아니라 **"private 태그 + 문서 정정 + (선택)감쇠"** 가 정직.
사용자 확정 후 W2-5 설계대로 착수.
