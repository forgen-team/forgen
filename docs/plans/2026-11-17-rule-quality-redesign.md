# forgen 룰 품질 재설계 — 세부 설계안 (2026-11-17, 초안)

> 상태: **오너 합의 완료(2026-11-17). 0.6.12 항목(D1·D2·D3·D6-1·D8) 구현·릴리스.** 0.6.13·0.7.0 항목은 이 문서를 타깃으로 구현한다.
> 비평: fresh-context critic 1차 REJECT(4건) → 반영 완료(D8 inject_count 방식, D6-1 고칠 곳 3곳, D1 observe·unflag 기준, P9 호출 지점).
> 근거: 오너 업무 맥 실데이터(룰 356개, 일별 지표 76일, forgen 0.6.8~0.6.11 시기)와 이 서버 `~/.forgen`, 코드 조사(v0.6.11).
> 회사 업무 내용이 들어 있는 룰 본문은 이 문서에 옮기지 않는다(공개 저장소). 예시는 일반화했다.

## 0. 원칙

1. **먼저 해로운 동작을 멈추고, 그다음 새 동작을 넣는다.** 새 기능은 지금 고장 난 신호(T5, accept_count, inject_count) 위에 얹지 않는다.
2. **기존 룰 데이터는 자동으로 바꾸지 않는다.** 바꿔야 하면 미리보기 → 스냅샷 → 적용 → 되돌리기 명령 순서로 한다(`retag --apply`, `habits --apply`와 같은 패턴).
3. **Handoff·witems가 읽는 값의 형식(status·phase 닫힌 집합, 파일 위치)은 0.6.x 안에서 바꾸지 않는다.** 바꿔야 하는 항목은 0.7.0으로 미루고 Handoff와 같이 바꾼다.
4. 각 항목은 단독으로 릴리스하고 되돌릴 수 있어야 한다.

## 1. 진단 — 현상과 코드 원인

| # | 현상 (실데이터) | 원인 (코드) | 확정도 |
|---|---|---|---|
| P1 | 활성 룰의 60% 이상이 flagged (맥 47/77, 서버 76/113) | T5 충돌 감지가 v0.6.9에서 한글 부정어 정규식 수정 후 처음 동작. 무관한 쌍까지 충돌로 판정(서버 11/17 상위 쌍 전부 무관한 룰끼리, 예: 지표 계산 0 나누기 룰 ↔ Dockerfile 환경변수 룰), 이미 기록한 쌍을 매 스캔마다 재기록(서버 11/17 하루 이벤트 4,734건 = 97쌍 × 쌍당 약 29회 스캔). flag는 status를 바꾸지 않아 계속 주입되고, 해제 코드가 없다 (`trigger-t5-conflict.ts:96-138`, `orchestrator.ts:68-80`). 화면 문구는 "repeated violations"로 원인과 다르다 (`inspect-renderer.ts:79`) | 확정 |
| P2 | 오너가 "작업 중 테스트·lint·타입체크 금지"를 1주에 6번 교정 | intent-classifier가 구현·리팩터 요청마다 "Build + lint + type-check must pass", "tests pass before AND after"를 고정 주입. 사용자 룰을 읽지 않고, 개인 룰과의 우선순위 장치가 없다 (`intent-classifier.ts:51-72`) | 확정 (반복 교정과의 인과는 유력) |
| P3 | 같은 날 같은 문장의 활성 explicit 룰 쌍, 12시간 뒤엔 active+suppressed 쌍 | avoid-this/fix-now 교정이 즉시 session 룰을 만들고(`evidence-processor.ts:64-85`), 승급 시 me 룰을 새로 만든다. session 룰은 12시간 유예 뒤에야 suppressed (`rule-store.ts:417-432`, v0.6.9) | 확정 |
| P4 | 서로 다른 render_key의 같은 내용 explicit 룰 | render_key = 축 + target 앞 30자 슬러그. 모델이 target을 다르게 주면 새 룰. explicit에는 문장 유사도 검사가 없다 (`evidence-store.ts:282,327`). 이 경우 렌더러 중복 제거도 안 걸려 두 번 주입 | 유력 |
| P5 | 채굴 룰 ~250개 생성, 222개 제거, 증거 1건 171개, 일회성 작업 지시가 다수 | Haiku 추출 프롬프트가 긍정 지시("~해줘")까지 교정으로 잡게 한다 (`auto-compound-runner.ts:445-480`). 최소 증거 수 없이 즉시 active (`evidence-store.ts:381-391`). 상한 30 초과 시 오래된 순 제거, 재추출되면 생성 시각을 그대로 써서 다음 검사에서 또 제거 → 생성≈은퇴 순환 (`evidence-store.ts:198-225,327-369`) | 확정 (제거 사유 = 상한 초과는 유력) |
| P6 | 채굴 룰이 오너 룰과 반대 내용인데 공존 | 같은 개념 판정에 극성 검사가 없어 반대 문장이 explicit 룰의 "채굴 관측 +1"로 집계되거나(`correction-clustering.ts:115-131`, `evidence-store.ts:311`), 어휘가 안 겹치면 별도 active 룰. 승급은 `saveRule`이라 T5도 안 거친다 | 확정 |
| P7 | 회사 특정 프로젝트 룰이 모든 저장소에서 주입 | 프로젝트 범위는 v0.6.9(11/05)에 도입. 이전 룰엔 `projects` 없음, 자동 보정 없음. 채굴 증거는 projects를 안 담는다. **클러스터 병합이 projects를 버린다**(`correction-cluster-runner.ts:195-204,536-541`). 홈 디렉터리 세션은 모든 프로젝트 룰을 포함(`rule-scope.ts:33-36`) | 확정 |
| P8 | `accepted`=0 (356개 전부) | `accept_count`를 올리는 코드가 없다 | 확정 |
| P9 | 주입 900~1,200회 | v0.6.9 이전엔 세션 시작마다 활성 룰 전부 +1. 지금은 본문에 든 룰만 +1이지만, fgx 래퍼 경유 시 한 세션에 2회 증가 가능: 1차 `harness.ts:441`(prepareHarness), 2차 `session-recovery.ts:180`(SessionStart). 두 호출은 각자 `crypto.randomUUID()`로 다른 세션 ID를 만든다(`v1-bootstrap.ts:145`) | 확정 / 2회 증가는 코드상 |
| P10 | 승급 11/06 이후 0 | 승급 조건이 "주입 20 + 위반 0"에서 "checks.jsonl 통과 10회 + 탐지 가능"으로 강화(`meta-reclassifier.ts:165-182`). 통과 기록은 사실상 룰 1개뿐 | 유력 |
| P11 | 우회 10/08 이후 0 | 오탐 1,114건이던 자연어 우회 추정을 v0.6.0에서 중단. 지금은 `FORGEN_USER_CONFIRMED`만 우회로 인정 | 확정 (정상) |
| P12 | 자문(advisory) 하루 100~290 | 후보 A: self_check 룰 기본이 advise가 되어 Stop 위반이 `kind:'correction'`으로 기록. 후보 B: P1의 T5 재기록. Handoff가 어느 쪽을 세는지 미확인 | 미확인 |

## 2. 설계 항목

각 항목: 현재 → 변경 → 기존 데이터 → 깨질 수 있는 것 → 테스트 → 검증.

### D1. T5 충돌 감지 중지와 오탐 flagged 정리 (P1)

- **변경**
  - T5는 기본으로 **기록만 하고 flag하지 않는다**(`suggested_action: 'observe'`). 재설계(극성 판정이 가능한 방식) 전까지 자동 flag 금지.
  - observe 이벤트는 `conflict_refs`에도 **추가하지 않는다**. 감지기가 오탐 위주라 룰 파일에 근거로 남기지 않고 lifecycle 로그에만 남긴다. `orchestrator.ts` `applyEvent`의 `t5_conflict_detected` 분기(~107행)를 `suggested_action !== 'observe'`일 때만 실행하게 바꾼다. `ACTION_TO_PHASE`에 observe가 없어 phase는 그대로 유지된다(현행 동작).
  - 같은 쌍 재기록 금지: 이미 `conflict_refs`에 있거나 최근 7일 lifecycle에 같은 정렬 쌍이 있으면 건너뛴다.
  - 완전히 같은 정규화 문장 쌍은 T5가 아니라 D4(중복)로 보낸다.
- **기존 데이터**: phase가 flagged이고 flag 근거가 T5뿐인 룰을 판정하는 기준: `conflict_refs`가 비어 있지 않고, **`state/lifecycle/*.jsonl` 전체에 그 rule_id의 t1·t2 이벤트가 하나도 없음**. lifecycle 로그는 정리 코드가 없어 남아 있다. 로그 디렉터리가 없거나 읽기에 실패하면 판정 불가로 보고 flagged를 유지한다(보수적). 이런 룰을 `forgen rule unflag --reason t5 [--apply]`로 active로 되돌린다. 미리보기가 기본, 적용 전 스냅샷, `conflict_refs`는 지우지 않고 남긴다. postinstall 1회 마이그레이션으로 자동 적용할지는 **오너 결정**(권장: 자동 적용 + 결과 건수 안내 + 되돌리기 명령. 이유: T5 flag는 주입에 영향이 없고 표시만 오염시킴).
- **깨질 수 있는 것**: 진짜 충돌을 놓침 → 지금도 해소 장치가 없어 실질 손실 없음. `state/lifecycle/*.jsonl`을 세는 외부 도구(Handoff)의 수치가 급감 → 릴리스 노트에 명시.
- **테스트**: 같은 쌍 2회 스캔 시 이벤트 1건, T5가 phase를 바꾸지 않음, unflag가 T1/T2 flagged는 건드리지 않음, 스냅샷·되돌리기 왕복.
- **검증**: 서버 `~/.forgen` 복사본(FORGEN_HOME 격리)에서 before/after: flagged 76 → T5 외 근거만 남는지, 하루 T5 이벤트 수.

### D2. 내장 고정 문구보다 개인 룰이 우선 (P2)

- **현재**: intent-classifier가 의도별 고정 블록을 매 프롬프트에 주입.
- **선택지 (오너 결정)**
  - (a) 고정 블록에서 **검증 방법을 지시하는 줄**(build/lint/type-check, tests before AND after, failing test first, coverage 83%)을 빼고 의도 한 줄 힌트만 남긴다.
  - (b) 블록은 두되, 개인 룰 중 같은 주제(테스트·lint·타입체크·빌드) 룰이 활성이면 그 블록을 생략한다(키워드 매칭).
  - (c) 룰 블록 머리말에 "이 사용자의 룰이 forgen 내장 안내보다 우선한다"를 넣는다.
  - **권장: (a) + (c).** (b)는 키워드 매칭이라 또 다른 오탐 원천이 된다. 고정 블록의 검증 지시는 근거 데이터가 없고, 실데이터는 반대 방향 교정만 있다.
- **기존 데이터**: 없음.
- **깨질 수 있는 것**: 고정 블록에 의존하던 사용자. 되돌리기용 설정 `hooks.intent-classifier.verbose=true`로 예전 블록 유지.
- **테스트**: 의도별 출력 스냅샷, 머리말 문구, 설정 토글.
- **검증**: 실제 Claude 세션에서 hook 출력 확인(이 세션처럼 additionalContext로 들어오는 문구).

### D3. 승급 시 session 룰 즉시 정리 (P3)

- **유예를 둔 이유 (v0.6.9)**: 세션 ID 불일치로 승급이 누락되면 session 룰이 다음 세션 시작에 바로 suppressed되어 교정이 사라졌다. 유예는 "아직 승급 안 된" session 룰을 지키려는 장치다. 아래 변경은 승급이 끝난 session 룰에만 적용하므로 이 이유와 충돌하지 않는다.
- **변경**: `promoteSessionCandidates`가 me 룰 저장에 성공한 직후, 같은 잠금 안에서 같은 render_key의 session 룰을 `superseded`(superseded_by = 새 me 룰)로 바꾼다. 12시간 유예는 "승급 안 된 session 룰"에만 남긴다.
- **기존 데이터**: 이미 생긴 active+suppressed 쌍은 그대로(무해). 둘 다 active인 쌍은 다음 세션 시작 정리에서 같은 규칙으로 처리.
- **깨질 수 있는 것**: 승급 실패 시 session 룰까지 사라지는 것 → 저장 성공 후에만 바꾼다. 유예를 도입한 이유(v0.6.9, 세션 ID 불일치로 승급 누락)를 다시 깨지 않도록 해당 회귀 테스트 유지.
- **테스트**: avoid-this 1건 → 활성 룰 1개, 승급 실패 경로에서 session 룰 유지.

### D4. explicit 룰 문장 중복 방지 (P4)

- **변경**: me 룰 새로 만들기 전에 활성 me 룰 중 **정규화 문장 완전 일치**(공백·문장부호·대소문자 정규화)가 있으면 새로 만들지 않고 기존 룰에 증거만 연결. 유사(완전 일치 아님)는 자동 병합하지 않고 D8 화면의 "중복 후보"로 보여 준다.
- **기존 데이터**: `forgen rule dedupe [--apply]`(미리보기 기본) — 완전 일치만 대상, 남길 쪽은 strength 높은 → 오래된 순.
- **깨질 수 있는 것**: 정규화가 다른 의미를 같게 만듦 → 완전 일치만 자동, 숫자·부정어는 정규화하지 않음.
- **테스트**: target만 다른 같은 메시지 2회 → 룰 1개.

### D4·D7 세부 (2026-11-17 구현 전 확정)

> critic(구현 전) APPROVE + 조건 3건 반영: drift 강등도 reviewed_at 이후만, 정규화 함수 단일화, systemMessage 병합.

**D4 같은 문장 방지·정리**
- 정규화: NFC → 소문자 → 공백 연속을 하나로 → 앞뒤 공백·끝의 문장부호(. ! ? 。) 제거. 숫자·부정어·중간 문장부호는 그대로(의미가 달라지지 않게).
- 생성 시: `promoteSessionCandidates` 의 explicit(채굴 아님) 새 룰 경로에서, render_key 로 기존 룰을 못 찾았을 때 활성 scope:'me' **explicit** 룰 중 정규화 문장이 같은 것이 있으면 그 룰을 기존 룰로 쓴다(증거 추가·강도 재계산, 새 룰 안 만듦). 채굴 룰과는 비교하지 않는다(ADR-013: explicit 와 채굴은 섞지 않음 — 채굴 쪽 사전 중복 검사가 따로 있다).
- 정리 명령 `forgen rule dedupe [--apply]` (미리보기 기본, 적용 전 스냅샷): 활성 scope:'me' 룰을 출처별(explicit / 채굴)로 나눠 정규화 문장이 같은 묶음을 찾는다. 남길 룰: strength(hard>strong>default>soft) → 오래된 created_at. 나머지는 superseded(superseded_by=남길 룰, 사유 'duplicate-of'). 남길 룰의 evidence_refs 에 같은 출처 증거를 합치고 projects 는 `mergeRuleProjects`(하나라도 전역이면 전역). hard 룰은 대체하지 않는다(남길 쪽이 될 수는 있음).
- 자동 마이그레이션은 하지 않는다. `--health` 의 "같은 문장" 줄에 명령을 안내한다.
- 정규화는 `src/store/rule-normalize.ts` 의 `normalizePolicy()` 하나로 두고, 생성 시 판정·dedupe·`--health`(지금 `rule-health.ts` 의 `normalize` 교체)가 모두 이 함수를 쓴다.

**D7 검토 대기 처리**
- `forgen rule review`: 활성·flagged 룰을 원인별로 보여 준다. 원인은 lifecycle 로그에서 그 룰의 마지막 flag 이벤트로 판정.
  - 교정으로 수정 요청(T1): 그 교정 증거의 문장·날짜
  - 반복 차단(T2): 최근 30일 차단 수, 정밀도(정탐/오탐/미판정, verdicts), 차단/자문 여부. 차단 룰은 "자주 막았다 = 모델이 자꾸 시도함 또는 오탐" 이라 정밀도를 같이 보여 준다.
  - 우회(T3), 원인 기록 없음
- 처리: `--keep <id...>` → phase active + `lifecycle.reviewed_at` 기록. `--suppress <id...>` → status suppressed(사유 'review', hard 룰은 거부). 수정은 명령이 아니라 Claude 에게 "이 룰을 이렇게 바꿔"라고 말하면 `correction-record`(rule_id, prefer-from-now)로 대체된다는 안내만.
- **다시 걸림 방지**: T2·T3 는 `reviewed_at` 이 있으면 그 이후 기록만 센다(`RuleSignals.violations_since_review` / `bypass_since_review`). 없으면 지금처럼 30일. drift 기반 강등(`scanDriftForDemotion`)도 `reviewed_at` 이후 drift 만 센다(critic: 별도 경로라 T2·T3 만 막으면 유지한 룰이 강등될 수 있음). T1(사용자가 룰을 지목한 교정)은 그대로 즉시 flag.
- 화면 문구: `forgen status --rules`(inspect) 의 flagged 표시를 원인별로("교정으로 수정 요청됨" / "반복 차단 — 검토" / "우회됨" / "충돌 감지 기록(참고)").
- 세션 시작 안내: 검토 대기(T5 제외)가 3개 이상이면 사용자 화면(systemMessage)에 한 줄 — 하루 1회만(`state/review-notice.json`). 모델 컨텍스트에는 넣지 않는다(모델이 매 세션 사용자에게 재촉하지 않게). systemMessage 는 단일 필드라 Haiku 안내와 동시에 있으면 줄바꿈으로 합쳐 하나로 낸다.
- `lifecycle.reviewed_at` 은 새 선택 필드 — Handoff 는 모르는 필드를 읽지 않으므로 호환.

### D5. 채굴 룰: 후보 단계와 추출 기준 (P5·P6) — 0.7.0

- **변경**
  1. 추출 프롬프트에 배제 기준 추가: 특정 화면·파일·데이터·이번 작업에만 해당하는 지시는 룰이 아니다. 응답에 `generality: task|project|general`을 받고 `task`는 버린다.
  2. **후보 단계**: 채굴 룰은 서로 다른 세션 2곳 이상에서 증거가 쌓이기 전엔 주입하지 않는다.
  3. 상한·수명 기준을 생성 시각이 아니라 **마지막 증거 시각**으로 → 재추출-즉시제거 순환 제거.
  4. 채굴 결과가 기존 explicit 룰과 같은 개념으로 판정되면 "관측 +1"을 올리지 않고 버린다(극성을 모르므로 지지로 세지 않는다).
  5. 채굴 증거에 러너 cwd의 프로젝트 키를 담아 기본 프로젝트 범위로 둔다.
- **Handoff 호환이 핵심 위험**: 후보를 새 status 값으로 만들면 Handoff·witems의 닫힌 집합(`active|suppressed|removed|superseded`)과 어긋난다. **선택지 (오너 결정)**: (a) status는 active 그대로 두고 `activation: 'candidate'` 필드 추가(렌더러만 제외) — Handoff는 활성 수를 부풀려 셈. (b) 새 status `candidate` + Handoff·witems 동시 수정. 권장: (b)를 0.7.0에서 Handoff와 함께.
- **ADR 개정 필요**: ADR-013(상한 30·TTL 21일 기준), ADR-017 D3(관측 +1 링크), ADR-019(승급이 모든 게이트 앞).
- **깨질 수 있는 것**: 학습이 느려짐(의도). 프롬프트 변경으로 진짜 일반 교정을 놓침 → 실데이터 증거 838건 재생으로 전/후 비교.
- **검증**: 맥·서버 behavior 증거를 격리 환경에서 재추출해 생성 수, task 판정 비율, 후보→활성 전환 수 비교.

### D6. 프로젝트 범위 보완 (P7)

- **변경**
  1. **(버그) 클러스터 병합이 projects를 보존** — 0.6.12. `correction-cluster-runner.ts`에서 고칠 곳 3곳: (i) explicit 클러스터 병합 `createRule`(~195행), (ii) 채굴 클러스터 병합 `createRule`(~536행), (iii) 흡수자(absorber) 경로(~185행)에서 구성원 projects를 흡수자에 합치기. 규칙: 구성원 projects의 합집합, 구성원 중 하나라도 전역(projects 없음)이면 결과도 전역. 이 파일은 현재 `projects`를 한 번도 참조하지 않는다.
  2. D5-5(채굴 증거에 프로젝트 키).
  3. 기존 무범위 룰 분류: `forgen rule classify-projects`를 확장해, 룰이 만들어진 세션의 cwd(증거의 session → transcript cwd)로 프로젝트 후보를 제안. **자동 적용 금지**, 미리보기 후 사용자 승인. 근거 없는 룰은 전역 유지.
- **깨질 수 있는 것**: 전역이어야 할 룰이 프로젝트로 묶여 다른 곳에서 사라짐 → 승인 없이는 안 바꾼다. 홈 디렉터리 세션은 계속 모든 룰 포함(알 수 없으므로) — 문서화.
- **테스트**: 프로젝트 룰 2개 병합 → projects 유지, 전역+프로젝트 → 전역.

### D7. flagged 처리 흐름 (P1 잔여)

- D1 이후 남는 flagged(T1 fix-now, T2 반복 위반)만 대상.
- `forgen rule review`: 대기 목록을 원인별(fix-now 교정 / 반복 위반)로 보여 주고 룰마다 `keep`(active 복귀) / `edit` / `suppress`. 화면 문구를 원인별로 고친다.
- ADR-002의 "flagged → active: 재검토 후 사용자 승인"을 구현.
- 세션 시작 안내는 대기 3건 이상일 때 한 줄만.

### D8. 지표: 의미 고정과 forgen 자체 화면 (P8·P9·P12, 오너 요청)

- **의미 고정**
  - `inject_count`: 세션당 1회. 세션 ID로는 거를 수 없다(두 bootstrap이 각자 새 UUID를 만듦). 대신 **래퍼가 실행하는 claude 자식 프로세스에 `FORGEN_HARNESS_BOOTSTRAPPED=1` 환경 변수를 넘기고**, hook은 그 환경을 물려받으므로 SessionStart의 `bootstrapV1Session`은 이 값이 있으면 `markRulesInjected`만 건너뛴다(룰 렌더·출력은 그대로). 시간 창(N초 이내) 방식은 쓰지 않는다 — 결정적이지 않다. 테스트: 환경 변수 유무에 따른 카운트 1/1, 래퍼 없이 직접 실행 시 1.
  - `accept_count`: 기록 경로가 없으므로 **표시에서 빼고**, 준수 근거는 `checks.jsonl`의 pass + `acknowledgments.jsonl`(차단 뒤 고쳐서 통과)로 정의한다. 필드 삭제는 Handoff가 읽으므로 0.7.0에서.
  - 반복 교정: 새 explicit 교정이 기존 활성 룰과 같은 개념으로 판정되면 `recorrected` 카운트(lifecycle 이벤트 `t1_recorrect`). "기존 룰이 안 먹힘"의 유일한 직접 신호.
- **화면**: `forgen status --health` (+ `--json`)
  - 흐름: 교정(사용자/채굴) → 룰 생성 → 활성(직접/채굴/후보) → 주입 → 평가(pass/위반/자문) → 반복 교정
  - 대기열: flagged(원인별), 중복 후보(D4), 범위 없음(D6) 건수
  - 상위: 많이 막는 룰(정밀도 포함), 반복 교정된 룰
  - 일별 표 14일: 교정·생성·은퇴·차단·자문·우회 — Handoff `days[]`와 같은 필드 이름
- **단일 집계 함수**: `src/core/rule-health.ts`가 계산, CLI와 `--json`이 같은 함수를 쓴다. Handoff가 파일을 직접 파싱하지 않고 `forgen status --health --json`을 읽게 하면 숫자가 항상 같다(Handoff 쪽 변경은 별도).
- **테스트**: 픽스처 `~/.forgen`으로 각 수치 계산, `--json` 스키마 고정 테스트.

### D9. 승급 0 (P10) — 이번 범위 밖

승급 조건 강화는 의도된 변경(D12-C)이다. 자문 룰은 원리상 준수 신호가 없어 승급할 근거가 없다. D8 화면에 "승급 후보 0인 이유"만 보여 주고, 조건 재설계는 D8 데이터를 2주 쌓은 뒤 판단한다.

## 3. 릴리스 단계

| 버전 | 항목 | 성격 | Handoff 영향 |
|---|---|---|---|
| 0.6.12 | D1, D2, D3, D6-1, D8(읽기 전용 화면 + inject_count 이중 증가 수정) | 해로운 동작 중지, 데이터 형식 불변 | flagged·T5 이벤트 수치 급감(릴리스 노트) |
| 0.6.13 | D4, D7 | 정리 명령(미리보기 기본) | 없음 |
| 0.7.0 | D5, D6-2/3, accept_count 정리, Handoff `--json` 연동 | 동작·형식 변경, ADR 개정 | status 집합 변경 — Handoff 동시 수정 |

## 4. 검증 계획 (항목 공통)

1. 단위 테스트(위 항목별).
2. **실데이터 재생**: `~/.forgen` 복사본을 FORGEN_HOME 격리 환경에 두고 새 버전으로 세션 시작·스캔·러너를 돌려 before/after 수치 표 — 활성 수, flagged, 중복 쌍, 주입 블록 크기·룰 수, T5 이벤트 수. 서버 복사본은 바로 가능, 맥 복사본은 오너가 제공할 때.
3. 깨끗한 컨테이너에서 0.6.11 → 새 버전 업그레이드(마이그레이션 1회·되돌리기 확인).
4. 0.6.12까지는 status·phase 값과 파일 위치가 그대로인지 확인하는 테스트(Handoff 호환).
5. 각 단계 구현 후 fresh-context critic.

## 5. 오너 결정 (2026-11-17 확정)

| 항목 | 결정 |
|---|---|
| D1 T5 오탐 flagged 정리 | 업그레이드 때 자동 정리 + 스냅샷 + 되돌리기 명령, 정리 건수 안내 |
| D2 내장 고정 문구 | (a)+(c): 검증 강제 줄 제거, 룰 블록 머리말에 개인 룰 우선 명시, 예전 문구는 설정으로 복원 가능 |
| D5 후보 표현 | 새 status `candidate` + 0.7.0에서 Handoff·witems 동시 수정 |
| 릴리스 | 0.6.12 → 0.6.13 → 0.7.0 세 단계, 단계마다 검증·critic |

## 5-1. (참고) 결정 전 질문 목록

1. D1: T5 오탐 flagged 정리를 업그레이드 때 자동으로 할지, 명령으로만 할지 (권장: 자동 + 되돌리기 명령)
2. D2: (a)+(c) 권장안 채택 여부
3. D5: 후보 단계 표현 — 새 status(Handoff 동시 수정) vs 필드 추가
4. D6-3: 기존 룰 프로젝트 분류를 세션 cwd 근거로 제안하는 방식
5. 릴리스 단계 분할(0.6.12 / 0.6.13 / 0.7.0)
6. Handoff 쪽 수정(새 `--json` 읽기, status 집합)은 누가 언제

## 6. 하지 않는 것

- 프롬프트마다 관련 룰만 골라 주입하는 방식(관련도 판정이 또 다른 오탐 원천이고 범위가 큼)
- Haiku 추출 끄기(ADR-019 기본 ON 유지, 기준만 조정)
- 승급 조건 재설계(D9)
