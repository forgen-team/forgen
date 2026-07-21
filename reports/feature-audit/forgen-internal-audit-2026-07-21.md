# forgen 내부 기능 감사 (Track A) — 2026-07-21

> 목표: 현재 제공 기능 전수 조사 → 중복/저가치 정리 → 핵심만 남긴 뒤 살 붙일 토대.
> 방법: 코드베이스 실측(cli.ts 디스패치, assets, src/hooks, src/mcp) + 실사용 신호
> (hook-timing.jsonl). 경쟁 라이브러리 분석은 Track B(feature-scout) 별도.

## 0. 표면적(surface area) 총량

| 종류 | 수 | 비고 |
|---|---|---|
| CLI 사용자 명령어 | ~25 | help 노출 기준 (dev-only 별도) |
| 스킬 (assets/claude/commands) | 10 | + 플러그인 스킬 12(forgen-{go,node,react,vue}-*) 별도 팩 |
| 에이전트 | 14 | tenetx/ch- 세트와 상당 중복 |
| 훅 | 23 | 대부분 조건부·희소 발화 |
| MCP 도구 | 9 | compound-{list,read,search,stats}, correction-record, profile-read, rule-list, session-search, invoke-agent |

**진단**: 표면이 과대하다. 특히 "상태를 보여주는" 명령이 10개로 파편화됨(§2.1).
핵심 가치(개인화+recall+정직측정+결정적가드) 대비 부수/유지보수 명령이 사용자
표면을 어지럽힌다.

## 1. 전체 인벤토리

**CLI (사용자 노출)**: forge, onboarding, inspect, rule(list/suppress/activate/scan/
health-scan/classify), stats, health, probe-workflow, workflows, watch, explain,
changelog, last-block, recall, migrate, parity, compound, dashboard, me, init,
config hooks, mcp, skill(promote/list), notepad, doctor, uninstall.

**스킬(10)**: ship(294줄), forge-loop(281), deep-interview(273), learn(231),
calibrate(226), code-review(218), retro(215), architecture-decision(183),
compound(176), docker(164).

**에이전트(14)**: architect, analyst, verifier, critic, code-reviewer,
forgen-verify, executor, git-master, solution-evolver, designer, test-engineer,
explore, planner, debugger.

**훅(23)**: pre-tool-use, post-tool-use, stop-guard, subagent-stop-guard,
context-guard, secret-filter, db-guard, slop-detector, rate-limiter,
intent-classifier, keyword-detector, prompt-injection-filter, notepad-injector,
skill-injector, solution-injector, session-recovery, pre-compact,
compound-reflection, subagent-tracker, post-tool-failure, permission-handler,
forge-loop-progress, post-tool-handlers.

## 2. 중복/정리 대상 클러스터

### 2.1 상태-표시 명령 난립 (최대 정리 기회) 🔴
같은 "내 상태를 보여줘"를 **10개 표면**이 나눠 가짐 — 각각 별도 구현:

| 명령 | 무엇 | 구현 |
|---|---|---|
| `stats` | trust-layer 대시보드 + philosophy | stats-cli.ts (462줄) |
| `health` | 단일 건강 점수 0-100 | health-cli.ts (107) |
| `dashboard` | compound 시스템 대시보드 | dashboard.ts (722) |
| `me` | 개인 대시보드 | dashboard-cli.ts (297) |
| `retro`(스킬) | git 메트릭+compound 회고 | 215줄 스킬 |
| `recall` | 최근 compound 주입 이력 | recall-cli.ts |
| `explain` | 최근 차단 N건 설명 | explain-cli.ts |
| `last-block` | 최근 차단 1건 | (explain 축약) |
| `watch` | 실시간 훅 이벤트 스트림 | watch-cli.ts |
| `inspect` | profile/rules/corrections/session | inspect-cli.ts |

합계 ~1800줄+ 이 "보여주기"에 분산. **제안**: `forgen status [--compound|--profile|
--blocks|--live]` 하나로 통합. dashboard/me/stats/health → 한 진입점의 뷰. explain/
last-block → `status --blocks`. watch → `status --live`. recall → `status --compound`.
inspect는 저수준 디버그로 유지하되 status가 상위 래핑.

### 2.2 dev/유지보수 명령이 사용자 표면 점유 🟡
`probe-workflow`, `parity`, `migrate`, `backfill`, `regress-map`, `classify`,
`scan`, `health-scan`(rule 하위) — 개발/스키마 유지보수용인데 top-level 노출.
**제안**: `forgen dev <...>` 네임스페이스로 이동 또는 help에서 숨김.

### 2.3 온보딩/개인화 진입 중복 🟡
`forge`(프로필 개인화) · `onboarding`(4질문) · `deep-interview`(스킬) · `calibrate`
(스킬) — 개인화 여정이 4곳. **제안**: `forge`를 단일 진입점으로, onboarding=forge의
첫 실행, calibrate=forge의 점검 모드, deep-interview=요구분석 전용으로 역할 명확화.

### 2.4 학습/지식 명령 중복 🟡
`compound`(지식 관리) · `learn`(learn-cli) · `retro`(스킬) · `recall` — compound
recall/축적을 4각도. **제안**: `compound`를 CLI 단일 관문(list/search/read/export/
import/prune), learn/retro는 compound의 워크플로우 스킬로.

### 2.5 스킬·에이전트 중복 🟡
- 스킬 `code-review`(218줄) vs 플러그인 `forgen-{lang}-be/fe-review`(언어별 12개)
  — 범용 1 + 언어별 12. 범용은 라우터로, 언어별은 팩으로 분리 정리.
- 에이전트 14개 중 architect/analyst/planner/critic + code-reviewer/verifier가
  tenetx ch- 세트와 개념 중복. **제안**: forgen 고유로 꼭 필요한 것만(예:
  forgen-verify, solution-evolver) 남기고 범용 역할은 사용자 에이전트에 위임.

## 3. 실사용 신호 (hook-timing.jsonl 실측)

실제로 자주 발화하는 훅 (최근 세션):
```
388 pre-tool-use      384 post-tool-use   ← 모든 도구 호출마다(코어)
 53 context-guard     31 stop-guard       29 subagent-stop-guard
 22 keyword-detector  22 forge-loop-progress  22 solution-injector
  9 session-recovery
```
**거의 안 뜨는 훅**: secret-filter, db-guard, slop-detector, rate-limiter,
intent-classifier, prompt-injection-filter, notepad-injector, skill-injector,
pre-compact, compound-reflection, subagent-tracker, post-tool-failure,
permission-handler. (조건부라 정상이나, 실효성 낮은 것은 통합·제거 후보.)
→ solution-injector(recall)·stop/subagent-guard(가드)·context-guard는 코어.
  secret/db-guard는 희소하지만 "결정적 안전"이라 유지(발화=고가치).

## 4. 핵심 가치 기능 (반드시 유지 — 정직 포지셔닝 정합)

1. **compound recall/injection** (solution-injector 훅 + compound MCP) — recall 축.
2. **correction→4축 profile** (forge/onboarding/inspect/calibrate + correction-record MCP).
3. **결정적 가드** (secret-filter, db-guard) — 모델 정직성 무관 발화.
4. **ROI 강등** (roi-demotion + surfaced/acted 텔레메트리).
5. **정직 측정** (forgen-eval + calibrate/recalibration 공시).
6. **하네스 런처** (forgen 기본 실행 — 개인화+auto-compound+훅 래핑).
7. **compound export/import** (팀 공유, probation) — 최근 추가.

## 5. 정리 제안 요약 (사용자 확정 대상)

| 액션 | 대상 | 효과 |
|---|---|---|
| **통합** | 상태 10명령 → `forgen status [뷰]` | 표면 −7, 1800줄 정리 |
| **이동/숨김** | dev·유지보수 8명령 → `forgen dev` | 사용자 표면 −8 |
| **명확화** | 개인화 4진입 → forge 단일관문 | 온보딩 혼선 제거 |
| **명확화** | 학습 4명령 → compound 관문 | recall UX 일관 |
| **분리** | 범용 code-review vs 언어팩 12 | 유지보수 경계 |
| **감축** | 에이전트 14 → forgen 고유만 | 사용자 에이전트와 비중복 |
| **유지** | §4 핵심 7 | 정직 포지셔닝 축 |

**순효과**: 사용자 명령 ~25 → ~12 (핵심만), 나머지는 dev 네임스페이스/뷰로 흡수.
"중요한 기능만 남기고" 목표 달성. 여기에 Track B(경쟁 분석)의 채택 후보로 살을 붙임.

## 다음
- Track B(feature-scout): OMC/OMO/ECC 세부 기능 → 채택 후보. 도착 시 §5 정리안 위에
  "무엇을 새로 붙일지" 결합해 로드맵 초안.
- 그 후 사용자와 설계 확정 → 개발 착수.
