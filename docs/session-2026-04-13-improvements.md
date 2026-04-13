# Forgen v0.3 세션 개선 기록 (2026-04-13)

## 목차

1. [이번 세션 변경사항 (v0.3 기능 추가)](#part-1-이번-세션-변경사항)
2. [다음 단계 계획 (Hoyeon 분석 기반)](#part-2-다음-단계-계획)

---

## Part 1: 이번 세션 변경사항

### 개요

이번 세션에서 forgen에 8개의 신규 기능과 3개의 버그 수정이 적용되었다. 핵심 방향은 "파이프라인 가시성 확보"와 "반영률 0% 문제 해소"이며, Docker E2E 테스트가 51개 체크로 확장되어 전체 통과 상태다.

---

### 8개 신규 기능

#### 1. Hook 에러 추적 (`failOpenWithTracking`)

**변경 파일:** `src/hooks/shared/hook-response.ts`

기존 `failOpen()`은 에러 시 `{ continue: true }`만 반환해 실패가 무음으로 묻혔다. 신규 `failOpenWithTracking(hookName)`은 fail-open 원칙은 유지하면서 `~/.forgen/state/hook-errors.jsonl`에 실패 기록을 남긴다.

```typescript
// 에러 시 호출: hook 이름을 전달하면 JSONL에 기록 + 통과
export function failOpenWithTracking(hookName: string): string {
  try {
    const logPath = path.join(STATE_DIR, 'hook-errors.jsonl');
    const entry = JSON.stringify({ hook: hookName, at: Date.now() });
    fs.appendFileSync(logPath, entry + '\n');
  } catch { /* tracking itself must not throw */ }
  return JSON.stringify({ continue: true });
}
```

19개 훅의 `.catch()` 핸들러가 `failOpen()`에서 `failOpenWithTracking('훅-이름')`으로 교체되었다. `forgen dashboard`의 Hook Health 섹션에서 훅별 실패 횟수와 마지막 실패 시각을 확인할 수 있다.

**테스트 커버리지:** `tests/unit/hook-response.test.ts` — 에러 로그 파일 생성 및 내용 검증

---

#### 2. 암묵적 피드백 (Revert/Repeated-Edit 감지)

**변경 파일:** `src/hooks/post-tool-use.ts`

사용자가 명시적으로 교정하지 않아도 행동 패턴으로 품질 저하를 감지한다. 두 가지 신호를 `implicit-feedback.jsonl`에 기록한다.

| 신호 유형 | 감지 조건 | 기록 타입 |
|-----------|-----------|-----------|
| 반복 편집 | 동일 파일 5회 이상 수정 | `repeated_edit` |
| 되돌리기 | 이전에 작성한 내용 해시가 재출현 | `revert_detected` |

되돌리기 감지 방식: 파일별로 최근 10개 쓰기 내용의 경량 해시(32비트 정수)를 유지하고, 새 쓰기가 직전 이전 해시와 일치하면 revert로 판단한다.

```typescript
// 경량 해시 (비암호학적, 내용 비교용)
function simpleHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}
```

**테스트 커버리지:** `tests/unit/post-tool-use.test.ts` — revert_detected, repeated_edit JSONL 기록 검증

---

#### 3. Bigram 시맨틱 매칭

**변경 파일:** `src/engine/solution-matcher.ts`

솔루션 검색에 문자 바이그램 Dice 계수를 추가했다. 태그 완전 일치가 낮더라도 오타나 약어가 유사한 경우("databse" vs "database") 후보로 올라온다.

**알고리즘:** Dice coefficient = 2 × |교집합| / (|A| + |B|), 문자 바이그램 기준

```typescript
export function bigramSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/\s+/g, '');
  const nb = b.toLowerCase().replace(/\s+/g, '');
  if (na.length < 2 || nb.length < 2) return 0;
  if (na === nb) return 1.0;
  // ... 바이그램 Map 구성 후 교집합 크기 계산
  return (2 * intersectionSize) / (totalA + totalB);
}
```

현재 가중치 구조: TF-IDF 기반 태그 매칭이 주 신호, bigram이 보조 신호로 borderline 케이스를 구제한다. Phase 2-C에서 BM25 앙상블(TF-IDF 0.5 + BM25 0.3 + bigram 0.2)로 확장 예정이다.

**테스트 커버리지:** `tests/unit/solution-matcher.test.ts` — 오타 문자열 유사도 임계값 검증

---

#### 4. 프로젝트별 훅 설정 (`mergeHookConfigs`)

**변경 파일:** `src/hooks/hook-config.ts`

훅 설정을 글로벌(`~/.forgen/hook-config.json`)과 프로젝트(`.forgen/hook-config.json`)로 분리하고, 프로젝트 설정이 글로벌을 훅 단위로 오버라이드하도록 병합한다.

**설정 우선순위:**

```
{프로젝트}/.forgen/hook-config.json  >  ~/.forgen/hook-config.json
```

```typescript
export function mergeHookConfigs(global: HookConfig, project: HookConfig): HookConfig {
  const merged: HookConfig = { ...global };
  // tiers: 프로젝트가 글로벌을 tier 단위로 오버라이드 (shallow merge)
  merged.tiers = { ...globalTiers, ...projectTiers };
  // hooks: 프로젝트가 글로벌을 hook 단위로 오버라이드
  merged.hooks = { ...globalHooks, ...projectHooks };
  return merged;
}
```

**안전 보장:** `compound-core` 티어는 tier 레벨 비활성화가 불가능하다. 복리화 파이프라인을 티어 설정으로 끄는 것을 원천 차단한다. 개별 훅은 `hooks.훅이름.enabled: false`로만 비활성화할 수 있다.

**테스트 커버리지:** `tests/unit/hook-config.test.ts` — 머지 우선순위 및 compound-core 보호 검증

---

#### 5. Hook 타이밍 프로파일러

**변경 파일:** `src/hooks/shared/hook-timing.ts`

모든 훅의 실행 시간을 `~/.forgen/state/hook-timing.jsonl`에 기록한다. 파일이 500줄을 초과하면 최근 500줄만 유지하도록 자동 로테이션된다.

```typescript
export function recordHookTiming(hookName: string, durationMs: number, event: string): void {
  const entry = JSON.stringify({ hook: hookName, ms: durationMs, event, at: Date.now() });
  fs.appendFileSync(TIMING_LOG, entry + '\n');
}

export interface TimingStats {
  hook: string;
  count: number;
  p50: number;   // 중앙값 (ms)
  p95: number;   // 95 백분위수 (ms)
  max: number;   // 최대값 (ms)
}
```

`getTimingStats()`는 훅별 p50/p95/max를 계산하고 p95 기준 내림차순으로 반환한다. 훅 시작 직전에 타임스탬프를 찍고 `finally` 블록에서 `recordHookTiming()`을 호출하므로 예외가 발생해도 기록이 보장된다.

**테스트 커버리지:** `tests/unit/hook-timing.test.ts` — 통계 계산 및 로테이션 동작 검증

---

#### 6. Knowledge Export/Import

**변경 파일:** `src/engine/compound-export.ts`

축적된 개인 지식(`~/.forgen/me/solutions/`, `rules/`, `behavior/`)을 tar.gz로 내보내고, 다른 머신에서 가져올 수 있다.

```bash
# 내보내기
forgen compound export
forgen compound export --output ~/my-knowledge.tar.gz

# 가져오기 (기존 파일은 덮어쓰지 않음)
forgen compound import ~/my-knowledge.tar.gz
```

**보안 처리:** 가져오기 시 경로 트래버설 공격 방지를 위해 각 파일의 실제 경로가 `ME_DIR` 내부인지 검증한다(`path.resolve` 후 `startsWith` 확인). 임시 디렉토리에 먼저 압축 해제한 후 파일별로 복사하며, `finally`에서 임시 디렉토리를 정리한다.

**테스트 커버리지:** `tests/unit/compound-export.test.ts` — export/import 파일 수 카운트, 경로 트래버설 차단 검증

---

#### 7. 세션 종료 자동 Compound 트리거

**변경 파일:** `src/hooks/context-guard.ts`

세션 종료 시 프롬프트 수에 따라 compound 루프를 자동으로 안내하거나 트리거한다.

| 프롬프트 수 | 동작 |
|-------------|------|
| 10-19개 | `/compound` 수동 실행 안내 메시지 표시 |
| 20개 이상 | `pending-compound.json` 마커 파일 생성 → 다음 세션 시작 시 자동 compound 트리거 |

```typescript
if (state.promptCount >= 20) {
  const marker = {
    reason: 'session-end',
    promptCount: state.promptCount,
    detectedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(STATE_DIR, 'pending-compound.json'), JSON.stringify(marker));
}
```

마커 파일은 다음 세션의 `session-recovery.ts`가 읽어 compound 루프를 자동 실행한다. 마커 생성 자체가 실패해도 fail-open 처리된다.

**테스트 커버리지:** Docker E2E Phase 6 — 25개 프롬프트 시뮬레이션 후 마커 파일 생성 검증

---

#### 8. Compound 대시보드 (`forgen dashboard`)

**변경 파일:** `src/core/dashboard.ts`

```bash
forgen dashboard
```

6개 섹션으로 구성된 터미널 대시보드를 출력한다.

| 섹션 | 표시 내용 | 데이터 소스 |
|------|-----------|-------------|
| Knowledge Overview | 솔루션 상태별 수, 규칙 수, 날짜 범위 | `~/.forgen/me/solutions/*.md` 프론트매터 |
| Injection Activity | 총 주입 결정 수, 상위 5개 솔루션, 최근 주입 이력 | `match-eval-log.jsonl` |
| Code Reflection | 반영률(%), 반영된/미반영 솔루션 수 | 솔루션 `evidence.reflected` 필드 |
| Lifecycle Activity | 상태 분포 막대, 승격 후보 목록 | 솔루션 프론트매터 |
| Session History | 마지막 추출 날짜, 오늘 추출 횟수 | `state/last-extraction.json` |
| Hook Health | 훅별 에러 횟수, 마지막 에러 시각 | `state/hook-errors.jsonl` |

반영률은 `evidence.reflected > 0`인 활성 솔루션 수 / 전체 활성 솔루션 수로 계산된다. 50% 이상이면 녹색, 20-49%는 노란색, 20% 미만은 빨간색으로 표시된다.

**테스트 커버리지:** `tests/unit/dashboard.test.ts` — 각 데이터 수집 함수 단위 검증, Docker E2E Phase 7

---

### Auto-compact 기능

**변경 파일:** `src/hooks/context-guard.ts`

추적된 프롬프트 문자 합계가 120,000자를 초과하면(실제 context의 약 20% 추정) Claude에게 즉시 `/compact` 실행을 지시하는 컨텍스트를 주입한다.

```typescript
const AUTO_COMPACT_CHARS_THRESHOLD = 120_000;

export function buildAutoCompactMessage(totalChars: number): string {
  return `<forgen-auto-compact>
[Forgen] Context 사용량이 ${Math.round(totalChars / 1000)}K 문자에 도달했습니다 (추정 ~20%+).
지금 즉시 /compact를 실행하여 컨텍스트를 압축하세요.
현재 작업을 마무리하지 말고, 다음 응답에서 바로 compact를 실행하세요.
</forgen-auto-compact>`;
}
```

5분 쿨다운이 적용되어 연속 트리거를 방지한다. 프로젝트별 `hook-config.json`에서 `autoCompactChars` 값으로 임계값을 커스텀할 수 있다.

---

### Reflection 0% 문제 수정

반영률이 0%로 집계되던 원인은 세 가지였으며, 각각 독립적으로 수정되었다.

#### 수정 1: Progressive Disclosure Tier 2 → 2.5

**변경 파일:** `src/hooks/solution-injector.ts`

기존 Tier 2(이름+태그만 전달)는 Claude가 솔루션 내용을 알 수 없어 실제 코드에 반영할 수 없었다. Tier 2.5는 솔루션 본문에서 코드 블록을 제외한 핵심 텍스트를 최대 3줄, 300자까지 함께 주입한다.

```
[기존 Tier 2 주입 형식]
solution-name [pattern|0.85]: tag1, tag2, tag3

[신규 Tier 2.5 주입 형식]
solution-name [pattern|0.85]: tag1, tag2, tag3
  핵심 내용 첫 번째 줄
  핵심 내용 두 번째 줄
  핵심 내용 세 번째 줄 (최대 300자)...
```

#### 수정 2: 태그 기반 반영 감지 fallback

**변경 파일:** `src/hooks/pre-tool-use.ts`

식별자(`identifiers`) 필드가 없는 솔루션은 반영 감지 대상에서 제외되던 문제를 수정했다. 6자 이상의 비범용 태그 2개 이상이 작성 코드에 출현하면 반영으로 인정하는 fallback을 추가했다.

```typescript
// Tag-based fallback: identifiers 없는 솔루션도 반영 감지
const genericTags = new Set(['pattern', 'solution', 'workflow', 'quality', 'best-practice']);
const eligibleTags = sol.tags.filter(
  (t: string) => t.length >= 6 && !genericTags.has(t) && /^[a-zA-Z가-힣]/.test(t)
);
if (eligibleTags.length >= 2 && eligibleTags.filter(t => code.includes(t)).length >= 2) {
  reflected = true;
}
```

#### 수정 3: Action-oriented 주입 Footer

솔루션 주입 메시지 하단에 "이 솔루션을 현재 작업에 적용하세요" 형식의 행동 유도 텍스트를 추가했다. 단순 참고 정보가 아니라 즉각 적용을 유도하는 framing이다.

---

### Docker E2E 테스트 확장

**총 체크 수: 51개 (전체 통과)**

새로 추가된 Phase 6과 Phase 7이 세션 생명주기와 기능 내보내기를 검증한다.

#### Phase 6: Session Lifecycle Simulation

25개 프롬프트를 시뮬레이션하여 세션 종료 시 동작을 검증한다.

- UserPromptSubmit 훅에 25회 프롬프트 전달
- `context-guard.json`의 `promptCount`가 25로 기록되었는지 확인
- 세션 종료 후 `pending-compound.json` 마커 파일 생성 확인
- auto-compact 지시(120K 임계값)가 올바른 타이밍에 주입되는지 확인

#### Phase 7: Feature Exports Verification

- `forgen compound export` 실행 후 `.tar.gz` 파일 생성 확인
- 아카이브 내 `solutions/`, `rules/`, `behavior/` 경로 검증
- `forgen dashboard` 실행 후 6개 섹션 헤더 출력 확인
- `hook-timing.jsonl` 파일 생성 및 JSONL 형식 유효성 검증

---

## Part 2: 다음 단계 계획

### Hoyeon 분석 개요

Hoyeon 분석은 "강의 조언(문서 분리, 동적 맥락, 세션 핸드오프)" 원칙을 forgen의 현재 구조에 적용할 수 있는지를 검토한 것이다. Critic 피드백을 통해 API 제약과 구현 가능성을 교차 검증하여 현실적인 계획으로 다듬었다.

#### Critic 피드백으로 제거/재설계된 항목

| 원래 계획 | 제거/재설계 이유 | 대안 |
|-----------|-----------------|------|
| `tool-output-truncator` (PostToolUse) | PostToolUse 단계에서는 이미 output이 context에 진입 → truncate 불가 | PreToolUse 기반으로 재설계 (Phase 1-E) |
| `.claude/rules/` 파일 분리 + 동적 로딩 | `.claude/rules/`는 정적 로드 구조, 동적 변경 시 사용자 편집 충돌 | `additionalContext` 주입 방식으로 전환 (Phase 2-B) |
| WTF-likelihood 별도 구현 | 기존 `implicit-feedback` 인프라와 중복 | 기존 `recordImplicitFeedback()`에 drift 타입 추가로 통합 (Phase 1-B) |

---

### 맥락 관리 3원칙

Hoyeon 분석에서 도출된 핵심 설계 원칙이다. 이후 Phase 계획은 모두 이 원칙에서 파생된다.

1. **문서 분리**: 정적인 사용자 편집 문서(`.claude/rules/`)와 동적인 컨텍스트 주입(`additionalContext`)을 엄격히 구분한다. `.claude/rules/`를 프로그램적으로 수정하지 않는다.

2. **동적 로딩**: intent에 따라 필요한 규칙만 `additionalContext`로 추가 주입한다. 항상 전체 규칙을 주입하는 것이 아니라 현재 작업 의도에 맞는 규칙을 선별한다.

3. **세션 핸드오프**: compact/세션 전환 시 다음 세션이 이전 세션의 맥락을 이어받을 수 있도록 구조화된 브리프를 저장한다. `~/.forgen/handoffs/{timestamp}-session-brief.md` 형식.

---

### Phase 1: 확실하게 실현 가능한 것 (이번에 할 것)

#### 1-A. edit-error-recovery 5패턴 강화

**대상:** `src/hooks/post-tool-failure.ts:72-95` (`getRecoverySuggestion()`)

기존 6개 패턴에 5개 추가:

| 에러 패턴 | 새 복구 안내 |
|-----------|-------------|
| `old_string not unique` | 더 넓은 컨텍스트를 포함하거나 `replace_all` 사용 |
| `file not found` | Glob으로 유사 파일 탐색 후 재시도 |
| `stale content` | Read로 최신 내용 확인 후 재시도 |
| `permission denied` | `chmod` 명령으로 권한 수정 안내 |
| `binary/encoding` | UTF-8 인코딩 확인 안내 |

**난이도:** 낮음 — 144줄 파일, 단순 패턴 배열 확장  
**테스트:** `tests/post-tool-failure.test.ts`에 5개 케이스 추가

---

#### 1-B. WTF-likelihood → Drift Score 통합

**대상:** `src/hooks/post-tool-use.ts` `recordImplicitFeedback()` 확장

기존 5회 반복 경고를 "drift score"로 통합하여 더 정밀한 품질 저하 감지를 구현한다.

| 신호 | 조건 | 레벨 |
|------|------|------|
| `repeated_edit` | 동일 파일 5회 수정 | 경고 |
| `drift_warning` | 세션 내 수정 총 15건 초과 | 경고 |
| `drift_critical` | revert 2회 이상 또는 수정 30건 초과 | 강력 경고 |
| 하드캡 | 수정 50건 초과 | `systemMessage`로 "중단 권고" 표시 |

**구현 위치:** `main()` 길이를 50줄 이내로 유지하기 위해 `checkDriftScore()` 함수를 별도 분리한다.

**난이도:** 중간 — `main()` 길이 주의 필요

---

#### 1-C. 구조화된 세션 브리프 핸드오프

**대상:** `src/hooks/pre-compact.ts` + `src/hooks/session-recovery.ts`

compact 실행 시 다음 세션이 이어받을 수 있는 구조화된 브리프를 생성한다.

**저장 경로:** `~/.forgen/handoffs/{timestamp}-session-brief.md` (최대 1,500자)

브리프 포함 내용:

```markdown
## Session Brief
- Mode: {collectActiveStates()에서 추출}
- Files modified: {STATE_DIR/post-tool-state.json의 modifiedFiles}
- Prompt count: {STATE_DIR/context-guard.json의 promptCount}
- Solutions injected: {injection-cache-*.json의 솔루션 이름 목록}
- Corrections: {correction-*.json 파일 수}
```

**데이터 소스 경로 (Critic 검증):**

| 항목 | 실제 파일 경로 | 필드 |
|------|--------------|------|
| 수정 파일 목록 | `STATE_DIR/post-tool-state.json` | `modifiedFiles` |
| 프롬프트 수 | `STATE_DIR/context-guard.json` | `promptCount` |
| 주입 솔루션 | `STATE_DIR/injection-cache-*.json` | `solutions[].name` |
| 교정 기록 | `~/.forgen/me/rules/` | 파일 수 |

`session-recovery.ts`는 기존 handoff 읽기 패턴(라인 302-323)을 참고하여 session-brief 파일을 읽고 `additionalContext`로 주입한다.

**난이도:** 중간 — pre-compact는 단순, session-recovery는 `main()` 길이 주의

---

#### 1-D. Harness 성숙도 진단 (`forgen doctor` 확장)

**대상:** `src/core/doctor.ts` (220줄) `runDoctor()` 함수 확장

`[Harness Maturity]` 섹션을 doctor 출력 마지막에 추가한다. 5개 축을 L1/L2/L3로 평가하고 Quick Wins 상위 3개를 제시한다.

| 축 | 측정 항목 |
|----|-----------|
| 준비 | CLAUDE.md 존재, `.claude/rules/` 파일 수, 활성 훅 수 |
| 맥락 | `project-context.md` 존재, solutions 수, behavior 패턴 수 |
| 실행 | 세션 로그에서 스킬 사용 빈도 (JSONL 파싱) |
| 검증 | `tests/` 디렉토리 존재, CI 설정 (`.github/workflows/`) |
| 개선 | reflection rate, compound 추출 이력 |

**난이도:** 낮음 — doctor.ts는 순차 출력 구조, 독립적

---

#### 1-E. 과대 출력 방지 (PreToolUse 기반, 재설계)

**원래 계획:** PostToolUse에서 truncate — API 제약으로 불가(이미 context에 진입)  
**재설계:** `solution-injector.ts` 주입 footer에 한 줄 추가

```
Grep/Bash 사용 시 head_limit 또는 | head -n으로 출력을 제한하세요
```

**난이도:** 낮음 — footer 1줄 추가

---

### Phase 2: 맥락 관리 개선 (다음 세션)

#### 2-A. 규칙 간결화 (AI 최적화)

**대상:** `src/renderer/rule-renderer.ts` (202줄) `renderRules()` + `ruleToText()`

현재 규칙 렌더링은 Pack 요약 헤더, 섹션 설명 등 Claude에게 불필요한 메타 정보를 포함한다.

**변경 내용:**
- Pack 요약 헤더 제거
- 섹션 설명 제거, 규칙 본문만 유지
- 카테고리/강도를 앞 태그로 축약: `[quality|strong] 빈 catch 블록 금지`

**예상 효과:** 토큰 사용량 ~6.5K → ~4K (실제 측정 기반 추정)

---

#### 2-B. Intent 기반 맥락 주입

**대상:** `src/hooks/intent-classifier.ts` (84줄)

`.claude/rules/`는 현재 구조를 유지하고, intent에 따라 `additionalContext`로 추가 규칙을 주입하는 방식으로 구현한다.

| Intent | 추가 주입 규칙 |
|--------|--------------|
| `implement` | quality/testing 규칙 |
| `review` | code-review 체크리스트 |
| `debug` | 디버깅 패턴 |

규칙 텍스트는 `~/.forgen/me/rules/` 또는 하드코딩 상수에서 로드한다. `.claude/rules/`를 건드리지 않아 사용자 편집이 보장된다.

---

#### 2-C. Compound-Search BM25 추가

**대상:** `src/engine/solution-matcher.ts`

현재 TF-IDF 단일 신호에서 3-way 앙상블로 확장한다.

```
최종 점수 = TF-IDF × 0.5 + BM25 × 0.3 + bigram × 0.2
```

**주의사항:** BM25는 document frequency 계산을 위한 I/O가 추가되므로 성능 테스트 필수다. 솔루션 수가 증가할수록 초기화 비용이 선형으로 증가한다.

---

### 검증 체크리스트

Phase 1 구현 완료 시 다음 순서로 검증한다.

```bash
# 1. 타입 안전성
npx tsc --noEmit

# 2. 유닛/통합 테스트 (기준: 1,459+ pass)
npx vitest run

# 3. Docker 클린 환경 E2E (기준: 51+ checks pass)
npm run build && npm pack
docker build -f tests/e2e/docker/Dockerfile -t forgen-e2e .
docker run --rm forgen-e2e

# 4. 대시보드로 반영률 변화 확인
forgen dashboard

# 5. Doctor로 harness maturity 확인
forgen doctor
```

---

### 수정 대상 파일 요약

| 파일 | Phase | 변경 내용 | 위험도 |
|------|-------|-----------|--------|
| `src/hooks/post-tool-failure.ts` | 1-A | 5개 에러 패턴 추가 | 낮음 |
| `src/hooks/post-tool-use.ts` | 1-B | drift score 통합 | 중간 |
| `src/hooks/pre-compact.ts` | 1-C | session brief 생성 | 낮음 |
| `src/hooks/session-recovery.ts` | 1-C | session brief 주입 | 중-높음 |
| `src/core/doctor.ts` | 1-D | harness maturity 섹션 | 낮음 |
| `src/hooks/solution-injector.ts` | 1-E | footer 1줄 추가 | 낮음 |
| `src/renderer/rule-renderer.ts` | 2-A | 규칙 간결화 | 중간 |
| `src/hooks/intent-classifier.ts` | 2-B | intent 기반 맥락 주입 | 낮음 |
| `src/engine/solution-matcher.ts` | 2-C | BM25 앙상블 | 중간 |
