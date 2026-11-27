# 공개 출력 계약 (K0 · K2-b)

forgen 밖의 도구(Handoff 등)가 기대도 되는 forgen 의 기계용 출력·입력 목록이다. 여기 적힌 것만 공개 계약이고, 사람용 문구(`--json` 없는 출력, stderr 안내)는 언제든 바뀔 수 있으니 파싱하지 않는다.

- **JSON Schema**: npm 패키지의 `assets/schemas/<id 의 / 를 . 로>.schema.json` (draft 2020-12). 예: `forgen-rate-limit/v1` → `assets/schemas/forgen-rate-limit.v1.schema.json`. 설치본에서는 `$(npm root -g)/@wooojin/forgen/assets/schemas/`.
- **실제 출력 픽스처**: 저장소 `tests/fixtures/contracts/` (합성 데이터로 실제 명령을 돌려 뜬 것). 이 저장소의 `tests/contracts-k0.test.ts`·`tests/readonly-outputs.test.ts` 가 실제 출력·픽스처를 스키마로 검사한다. 소비자는 같은 픽스처를 복사해 자기 파서를 고정한다.
- **호환 규칙**: 같은 `schema` 값 안에서는 칸을 더하기만 한다(소비자는 모르는 칸을 무시). 칸을 빼거나 뜻·enum 을 바꾸면 `schema` 값을 올린다. 스키마의 객체는 새 칸을 허용하도록 열어 두었다(입력 `forgen-way-import/1` 만 닫힘).
- **맞지 않을 때**: 소비자는 스키마 검사에 실패한 출력을 쓰지 않고 그 연동을 끈다(경계 설계 R6).

정본 설계: 워크스페이스 `docs/plans/2026-11-27-forgen-handoff-boundary.md` §6(K0·K2), §2 C4, §9 D2.

## 한눈에

| 종류 | schema | 명령 | 쓰기 | 스키마 파일 |
|---|---|---|---|---|
| K0 | `forgen-way/1` | `forgen way --json` (`way export --target json`, `way collect-memory --json` 도 같은 schema) | 없음 | `forgen-way.1.schema.json` |
| K0 | `forgen-rule-list/v1` | `forgen rule list --json [--archive]` | 없음 | `forgen-rule-list.v1.schema.json` |
| K0 | `forgen-rule-history/v1` | `forgen status --history --json [--days N] [--rule <id>]` | 있음(아래) | `forgen-rule-history.v1.schema.json` |
| K0 | `forgen-rule-health/v1` | `forgen status --health --json [--days N]` | 있음(아래) | `forgen-rule-health.v1.schema.json` |
| K0 | `forgen-events/v1` | `forgen status --events --json [--since ISO] [--until ISO]` | 없음 | `forgen-events.v1.schema.json` |
| K0 입력 | `forgen-way/1` 문서 | `forgen way import <파일> [--apply]` | `--apply` 때 룰 | `forgen-way-import.1.schema.json` |
| K2-b | `forgen-audit-recurrence/2` | `forgen audit recurrence --latest --json` | **없음** | `forgen-audit-recurrence.2.schema.json` |
| K2-b | `forgen-rate-limit/v1` | `forgen status --rate-limit --json [--latest]` | **없음** | `forgen-rate-limit.v1.schema.json` |
| K2-b | `forgen-project-which/1` | `forgen project which [폴더] --json` | **없음** | `forgen-project-which.1.schema.json` |

`--history`·`--health` 는 읽기 명령이지만 닫힌 날의 일별 보관 파일(`<FORGEN_HOME>/state/metrics/daily/`)을 채운다(기존 동작). 쓰기가 없어야 하는 소비자는 이 두 명령을 부르는 횟수를 줄인다.

`forgen status --json`(옵션 없이)은 옛 대시보드 출력이라 계약이 아니다.

## K2-b — 저장된 결과 읽기 (Unreleased, 측정 중 예외 D2)

두 명령 모두 **새로 판정하지 않고 어떤 파일도 쓰지 않는다**(회차·지문·두 층 색인·교정 원장·판정 캐시·모델 안내 표시·rate-limit 압축 모두). 테스트가 실행 전후 `FORGEN_HOME` 의 파일 해시·수정 시각이 같음을 확인한다. stdout 에는 JSON 하나만 나온다.

### `forgen audit recurrence --latest --json` → `forgen-audit-recurrence/2`

- 저장된 회차(`<FORGEN_HOME>/audit/recurrence/<runId>/result.json`) 가운데 감사 첫 화면과 같은 규칙으로 고른 것(`latestRecurrenceRun()`): 전부로 잰 회차(`prompts.limit === null`) → 표본 회차 → 판정을 대부분 못 한 회차(`incomplete`) 순. `model-off` 회차와 schema 가 다른 회차는 고르지 않는다.
- 출력 = 그 `result.json` 그대로 + `runId`(문자열). 회차 기간은 `window.since`·`window.until` 에 있으니 화면에 같이 보인다.
- 저장된 회차가 없으면: `{ "schema": "forgen-audit-recurrence/2", "status": "no-data", "statusNote": "…", "runId": null }`. `runId` 가 `null` 이면 이 한 덩이, 문자열이면 전체 결과다.
- `status` 는 5종 그대로: `ok` | `insufficient`(참고값 — 교정 수가 표본 하한 미달) | `incomplete`(판정 못 한 것이 많음 — 숫자를 보이지 말 것) | `model-off` | `no-data`. 하나로 뭉치지 않는다. (`--latest` 는 `model-off` 회차를 고르지 않으므로 실제로는 `model-off` 가 나오지 않지만 스키마는 5종을 다 받는다.)
- 필수 칸: `schema, runId, forgenVersion, generatedAt, claudeDir, window{since,until,lookbackDays,days}, judge(객체|null), status, statusNote, prompts{window,lookback,sampled,judged,unjudged,limit(수|null),per30d}, corrections{total,taskSpecific,lookback,per1000,per30d,becameMemory}, counts·per1000·per30d{ignored,notLoaded,written,unwrittenRepeat,deletedRepeat,total[,tier2Missed]}, ci95per1000{total[2],written[2]}, unknown, pairsJudged, memory{items,byKind,unknownTime,deleted}, loadedVia{renderLog,replay}, notes[], items[]`. 선택: `range`(엄격~관대 범위), `biweekly[]`.
- `items[]` 는 교정 단위다(`branch`: `ignored | not-loaded | unwritten-repeat | deleted-repeat | new`, `match`·`earlier`·`pairs[].verdict: yes|no|unknown|null`). 규칙별 집계는 없다(1.0 뒤). `utterance`·`gist`·`match.text` 는 사용자 원문이므로 화면에는 forgen `maskQuote` 와 같이 80자로 가려 보인다.
- `--json` 없이 쓰거나 `--since`·`--until`·`--lookback`·`--limit`·`--no-model`·`--claude-dir` 와 같이 쓰면 오류(종료 코드 1, stdout 비어 있음).
- 새로 판정하는 `forgen audit recurrence --json` 은 그대로다 — 회차·지문·색인·원장을 쓰므로 외부 도구가 부르면 안 된다.

### `forgen status --rate-limit --json` → `forgen-rate-limit/v1`

```ts
type ForgenRateLimit = {
  schema: "forgen-rate-limit/v1";
  samples: Array<{ w: "five_hour" | "seven_day"; t: number /* epoch ms */; used: number /* % */; resets_at: number | null /* epoch s */ }>;
};
```

- 원천: `<FORGEN_HOME>/state/rate-limit-samples.jsonl`(statusline 이 쌓음). 샘플 형식은 파일 그대로이고, 읽는 규칙은 forgen 예측과 같다(`readSamples()`): 최근 7일 줄만, 파싱 안 되는 줄(잘린 줄)·형식이 틀린 줄은 뺀다. 파일 순서 그대로.
- 파일이 없으면 `samples: []`. 파일을 만들거나 압축하지 않는다.
- `--json` 없는 `--rate-limit` 은 지금처럼 "알 수 없는 status 옵션" 오류다.
- `--latest`: 창(`five_hour`·`seven_day`)마다 `t` 가 가장 늦은 샘플 하나만(최대 2개, 창 순서). 같은 형식이라 스키마는 같다. 파일 전체(수 MB)를 넘기지 않으려는 화면용.

### `forgen project which [폴더] --json` → `forgen-project-which/1`

```ts
type ForgenProjectWhich = { schema: "forgen-project-which/1"; folder: string /* 절대 경로 */; key: string | null /* 소문자 */ };
```

- 규칙은 `--json` 없는 `project which` 와 같다(`projectKeyFor()`: 등록부 → git 저장소 폴더 이름). 어떤 파일도 쓰지 않는다. 폴더를 빼면 현재 폴더.

## K0 — 이미 있는 출력 (형식 유지 선언)

아래는 지금 코드가 내는 모양을 그대로 적은 것이다. 자세한 칸은 스키마 파일이 정본이다.

### `forgen-way/1` (`forgen way --json`)
- 최상위 필수: `schema`(`forgen-way/1`), `generator`(`forgen-way`), `generated_at`, `items[]`. 선택: `stats`(정수 8칸, `way --json` 만), `render`(객체|null, `way --json` 만), `project`(문자열|null, export 만).
- 항목 필수: `id, kind, statement, applies_when, why, projects, strength, provenance, enforceable`. 선택: `status, category, render_key, source, updated_at, conflicts_with`.
- enum: `kind` rule|solution|habit · `strength` soft|default|strong|hard · `status` active|suppressed|removed · `source` explicit_correction|onboarding|behavior_inference|pack_overlay|imported.
- `provenance`: `you-said`(quote?, date?) | `mined`(date?) | `imported`(**from 필수**, date?).

### `forgen-rule-list/v1` (`forgen rule list --json`)
- 최상위 필수: `schema, generatedAt, rules[]`.
- 룰 필수: `id, status, phase, category, strength, source, origin, scope, projects, statement, trigger, renderKey, createdAt, updatedAt, counts{inject,violation,bypass}, lastInjectAt, lastViolationAt, enforce{hasEnforceVia,mode,label}, statusHistory[], evidence[], evidenceTruncated, supersededBy, reviewedAt, archived`. 선택: `scopeState`(`unresolved`).
- enum: `status` active|candidate|suppressed|removed|superseded · `phase` active|flagged|suppressed|retired|merged|superseded|null · `category` quality|autonomy|communication|workflow|safety · `scope` me|session · `origin` user|mined|default|other · `enforce.mode` block|advise · `evidence[].kind` user|mined|other. `evidence` 최대 20개.

### `forgen-rule-history/v1` (`forgen status --history --json`)
- 필수: `schema, generatedAt, columns[], days[]{day(YYYY-MM-DD), asOf, rows[][]}`. `rows` 는 `(문자열|수|null)[][]`, 지금 `columns` 는 `id, status, phase, inject, violation, bypass`. 소비자는 `columns` 로 칸 위치를 찾는다(위치 고정 아님).

### `forgen-rule-health/v1` (`forgen status --health --json`)
- 필수: `schema, generatedAt, windowDays, rules{active,flagged,candidates,neverInjected,unscopedLearned,duplicateGroups}, flow, top{blocking,blockingAll,recorrected}, days[], history{retentionDays,oldestDay,definition}`. `flow.correctionClasses` 는 선택(지금은 항상 나옴). `days[].source` 는 선택, live|closed|backfill.

### `forgen-events/v1` (`forgen status --events --json`)
- 필수: `schema, generatedAt, since, until, sources{enforcement,evidence,sessionsDb}, events[]{at,sessionId(문자열|null),kind,ruleId(문자열|null)}, sessions[]{id,cwd,startedAt}`.
- `kind`: block|bypass|false_positive|correction_user|correction_mined|solution_matched|solution_surfaced|solution_acted_on. 문구(룰 문장·발화)는 싣지 않는다.

### 입력: `forgen way import <파일>` (`forgen-way-import/1` 스키마)
- 문서의 `schema` 값은 `forgen-way/1`. 최상위 필수 `schema, items`, 허용 칸 `generator, generated_at, project, stats, render`. 모르는 칸은 오류(닫힌 스키마).
- 항목 필수: `id`(빈 값 불가), `kind`, `statement`(공백만은 불가), `applies_when`, `projects`(문자열 배열), `strength`, `provenance{kind[,quote,date,from]}`, `enforceable`(불리언). 선택 `why`, `status`(active|suppressed|removed) 등. `provenance.kind` 가 `imported` 면 `from` 필수.
- 스키마로 못 잡는 검사: 같은 파일 안 id 중복, "새 룰은 imported 여야 함"·"새 룰에 hard·비활성 금지"(저장소 상태에 따라 갈림). 최종 판정은 `forgen way import` 다.
- 결과 출력(`--json`, K2-a `forgen-way-import-result/v1`)은 아직 없다 — 1.0 뒤.

### 그 밖의 K0 (JSON 아님)
- 쓰기: `forgen rule suppress|activate <id>`.
- MCP: 서버 `forgen-compound` 의 읽기 도구.
- 탐지: `forgen --version`, `~/.forgen`(또는 `FORGEN_HOME`) 존재, `~/.forgen/bin/forgen-run`.
- 환경 변수: `FORGEN_HOME`.
