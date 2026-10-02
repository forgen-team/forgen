# ADR-016: Codex `notify` 폴백 + 훅 번들(SessionEnd·컨텍스트 스필 해제·죽은 이벤트 제거) + Claude `verify` 스킬

**Status**: Accepted (2026-10-02) — 오너 지시 "배포하고 바로 그냥 진행" 으로 합의 단계 갈음. 구현 증거는 CHANGELOG 0.5.6.
**Reversibility**: Type 2 (가역 — 설치 산출물 추가/변경. 단 D2 는 Codex 훅 2개의 `/hooks` 재승인을 요구)
**관련**: ADR-015 백로그 X-G3 / X-G5 / X-G6 / C-G3, ADR-014 (Codex 룰 주입·훅 신뢰 감사), ADR-011/012 (auto-compound)

## Context — 조사 결과 (Codex rust-v0.153.4 소스 + 격리 실세션, Claude Code 2.1.287 changelog)

ADR-015 는 네 항목을 "설계 결정 또는 훅 재승인 필요" 로 백로그에 뒀다. 구현 전에 전제를 소스로 재검증했고,
그중 몇 개는 어제의 가정과 달랐다.

| 가정 (ADR-015) | 검증 결과 | 출처 |
|---|---|---|
| hooks.json 을 바꾸면 22개 훅 전부 재승인 | **틀림.** trust 해시는 *핸들러 단위* (`event_name` + `matcher` + 정규화된 핸들러 1개). 새 이벤트 키 추가·뒤에 append·미지원 이벤트 키 제거는 기존 핸들러에 영향 없음. 필드(`async`/`timeout`/`additionalContextLimit`/`command`/`matcher`)를 바꾼 핸들러만 `modified` 가 되어 재승인 전까지 skip | `hooks/src/engine/discovery.rs` `hook_hash`, `config/src/fingerprint.rs`; 실 `~/.codex` 의 trusted_hash 28/28 재현 |
| `additionalContextLimit: 0` 은 설정값 | **핸들러별 필드.** 기본 2,500 "토큰"(= `ceil(bytes/4)`, 약 10KB) 을 넘는 `additionalContext` 는 임시 파일로 스필되고 모델은 머리/꼬리 미리보기만 본다. hooks.json top-level 에 두면 `deny_unknown_fields` 로 **파일 전체가 파싱 실패** | `config/src/hook_config.rs`, `hooks/src/output_spill.rs` |
| `async: true` 로 관찰 훅을 비동기화하면 빨라진다 | 같은 이벤트의 sync 핸들러는 **이미 동시 실행** (`FuturesUnordered`). async 는 제어 효과(block/deny)가 적용되지 않고, `additionalContext` 가 다음 턴으로 밀리며, 세션 종료 시 프로세스 그룹째 kill 된다 | `hooks/src/engine/dispatcher.rs`, `core/src/hook_runtime.rs` |
| Codex SessionEnd 는 불확실 | **실재.** stdin: `session_id`/`transcript_path`/`cwd`/`hook_event_name`/`reason`(항상 `"other"`). stdout 무시(관찰 전용), 타임아웃 1~3s 로 clamp, rollout flush 후 발화, `codex exec` 에서도 발화 | `hooks/src/events/session_end.rs`, 격리 실세션 |
| `PostToolUseFailure` | Codex 이벤트 아님 — 키째 조용히 무시 | 바이너리 문자열 0건 |
| `notify` | top-level `notify = [argv…]` **단일** 프로그램. 턴 완료마다(Stop 훅 뒤) JSON 을 마지막 argv 로 받아 detached 실행. **훅 신뢰와 무관**, `codex exec` 에서도 발화. 페이로드: `type`/`thread-id`/`turn-id`/`cwd`/`client`/`input-messages`/`last-assistant-message` (transcript 경로 없음 — `thread-id` 로 rollout glob) | `hooks/src/legacy_notify.rs`, 격리 실세션 |
| Claude `verify` 스킬 규약이 플러그인 네임스페이스에도 적용되는지 미확인 | 2.1.286 changelog: "when your **project or user** skills include one named `verify`, Claude is now told to run it right before committing, except for docs-only and tests-only commits". 플러그인 스킬(`forgen:verify`)은 대상이 아님 (문서) | `~/.claude/cache/changelog.md` 2.1.286 |

**실측 (측정 부채 정리)** — 어댑터 경유 훅 1회 wall time (격리 FORGEN_HOME, best-of-3, 이 머신): 91~137ms
(bare `node` spawn 25ms). 동시 실행이므로 이벤트당 지연은 합이 아니라 최댓값 ≈ 130ms.

**실 문제 2건** (이번 조사에서 확인):
1. Codex 룰 주입 블록(`<forgen-rules host="codex">`)의 forgen 상한은 15,000 *글자*. 한국어 룰은 UTF-8 3바이트라
   Codex 의 10KB 스필 임계를 쉽게 넘는다 → 룰이 파일로 밀려나고 모델은 잘린 미리보기만 본다 (ADR-014 D1 의 목적 훼손).
2. `auditCodexHookTrust` 는 `hooks.state` 키의 *존재* 만 본다. 핸들러가 바뀌어 `modified` 가 된 훅(Codex 가 skip 함)을
   "trusted" 로 오표시한다.

## Decision

### D1 — Codex `notify` 를 "신뢰 무관 폴백" 으로 등록 (X-G3)

forgen 훅이 Codex 에서 미승인/modified 라 조용히 skip 되는 동안에도 (a) 그 사실이 보이고 (b) 학습 추출이 굶지 않게 한다.

- 바이너리 `dist/host/codex-notify.js`. `forgen install codex` 가 config.toml **최상단**(첫 테이블 헤더 앞 — TOML
  top-level 키 제약)에 마커 블록으로 `notify = ["node", "<pkgRoot>/dist/host/codex-notify.js"]` 를 쓴다.
- **사용자 `notify` 가 이미 있으면 건드리지 않는다** (단일 argv 라 병합 불가). forgen 블록이 있었다면 제거해 중복 키
  (= config.toml 파싱 실패) 를 만들지 않는다. install 출력에 수동 체인 방법을 안내:
  `notify = ["node", ".../codex-notify.js", "--", "<원래 프로그램>", "<인자…>"]` — `--` 뒤 argv 에 페이로드를 붙여 detached 로 먼저 실행.
- 동작 (모든 단계 fail-open, exit 0):
  1. `FORGEN_NESTED_RUN=1`(forgen 자신의 추출용 `codex exec`) 이면 즉시 종료 — 재귀/오탐 방지. `execHost` 가 Codex
     추출 run 에도 이 표식을 준다 (이전엔 Claude 분기에만 있었다 — `--ephemeral` 은 사용자 config 의 훅·notify 를 그대로 로드한다).
  2. 체인 프로그램이 있으면 detached 로 전달.
  3. `agent-turn-complete` 가 아니면 종료.
  4. **훅 생존 판정**: codex-adapter 가 Stop/SubagentStop/UserPromptSubmit 에서 `state/codex-hook-alive.json` 을 갱신한다
     (어댑터 = "Codex 가 forgen 훅을 실제로 실행했다" 의 유일한 choke point). notify 는 Stop 훅 직후 발화하므로
     마커가 최근 120s 안이면 alive → silent 플래그를 지우고 종료 (auto-compound 는 Stop 훅 소관).
  5. silent 이면 `state/codex-hooks-silent.json` 에 기록(`forgen doctor` [Codex Hooks] 가 노출)하고, `thread-id` 로
     rollout 을 찾아 user 메시지 ≥10 이면 Stop 훅과 **같은** 디바운스 경로(`maybeSpawnAutoCompound` — adaptive cooldown +
     in-flight gate)로 auto-compound 를 띄운다. 추출 동의(ADR-012)는 러너가 그대로 강제한다.
- 자동 체인(사용자 notify 를 forgen 래퍼로 감싸기)은 **하지 않는다**: TOML 라이브러리 없이 임의 배열을 재작성하는
  위험 + 원복을 보장할 수 없다.
- 사용자가 `context-guard` 훅을 꺼 뒀으면 폴백도 auto-compound 를 띄우지 않는다 (Stop 경로와 같은 opt-out).
- `--no-notify` 와 `forgen uninstall` 은 forgen 블록을 **제거** 한다. 블록의 notify 줄이 손으로 고쳐져 한 줄 JSON 배열로
  읽히지 않으면 forgen 은 블록을 건드리지 않는다 (`custom-block`).
- `forgen doctor` 는 silent 관측이 연속 2회 이상일 때만 표시한다 — Stop 훅 없이 notify 만 도는 내부 서브세션
  (`/review` 등, 소스상 추정)의 1회성 오탐을 거른다.

### D2 — Codex 훅 번들 (X-G5/G6): 재승인 2건으로 축소

| 변경 | 재승인 | 근거 |
|---|---|---|
| `session-end` 훅을 Codex 에도 등록 (`SessionEnd`) | 신규 1건 | Ctrl+C/종료 시 Stop 이 안 오는 세션의 학습 유실 (forgen-autocompound-gap). 3s 예산 → 기존 bounded count + detached spawn 그대로. user 카운트는 Codex rollout 의 실제 프롬프트 레코드(`event_msg` / `payload.type=="user_message"`)를 raw 바이트 스캔 — `response_item` role=user 는 주입 컨텍스트까지 세어 실측 1.8배 과대(51 vs 91) |
| `session-recovery` 핸들러에 `additionalContextLimit: 0` (Codex 한정) | modified 1건 | 실 문제 1. forgen 이 자체 상한(RULE_FILE_CAPS)을 이미 갖고 있으므로 Codex 스필을 끈다 |
| `post-tool-failure` 를 Codex 에서 제외 (`hosts:["claude"]`) | 0건 | Codex 가 무시하는 죽은 엔트리 |
| `auditCodexHookTrust` 가 trusted_hash 를 **계산해 대조** (`trusted`/`modified`/`untrusted`) | — | 실 문제 2. 읽기 전용 대조라 Codex 의 신뢰 정책을 우회하지 않는다. 위 `modified` 1건을 사용자에게 정확히 알리는 전제 |

**하지 않는 것 (정직 표기)**:
- `async: true` — 실측상 이득 상한이 이벤트당 ≈130ms 인데, 핸들러마다 재승인 + 제어 효과 상실 + 종료 시 kill 위험. 느린
  핸들러가 측정으로 확인되면 재검토.
- `PostCompact` / `Interrupt` 등록 — 둘 다 컨텍스트 주입 불가(관찰 전용)이고 forgen 이 거기서 할 일이 없다. 컴팩션 후 룰
  재주입은 SessionStart(source=compact) 가 이미 담당, 컴팩션 전 추출은 PreCompact 가 담당.
- Codex PostToolUse 에서 실패 감지로 `post-tool-failure` 로직을 재현 — 별도 설계 (백로그).

### D3 — Claude `verify` 스킬 (C-G3)

- `forgen install claude` 가 `~/.claude/skills/verify/SKILL.md` 를 forgen-managed 마커와 함께 설치. **사용자 소유 파일
  (마커 없음/심링크)은 덮어쓰지 않는다.** `forgen uninstall` 이 마커가 있는 것만 제거.
- 본문: 변경 범위 확인 → 프로젝트의 실제 build/typecheck/lint/test 명령 실행 → 변경 자체를 실행해 확인 →
  `confirmed`/`refuted`/`unverified` 판정 (mock 통과는 증거로 치지 않음, refuted 면 커밋하지 않음). 위험한 변경은
  `forgen-verify`/`ch-verifier` 서브에이전트에 반박 검증을 위임.
- user 스킬은 같은 이름의 project 스킬보다 우선하므로, 본문 첫 단계에 "저장소가 자체 verify 레시피
  (`.claude/skills/verify/` 또는 CLAUDE.md/AGENTS.md 의 검증 명령)를 갖고 있으면 그것을 먼저 따른다" 를 둔다.
- Codex 에는 동등 규약이 없으므로 설치하지 않는다.

## Alternatives

- **D1 대안 A (현상 유지 — notify 미사용)**: 훅 skip 이 계속 무음. D2 가 modified 를 만드는 이번 릴리스에서 특히 나쁨. 기각.
- **D1 대안 B (자동 체인)**: 사용자 notify 를 감싸 항상 설치. 병합/원복 안전성을 보장 못함. 기각(수동 체인 안내로 대체).
- **D1 대안 C (세션별 alive 마커를 훅마다 기록)**: 턴당 22회 쓰기 + 서브에이전트 스레드 오탐. 어댑터의 3개 이벤트 전역 마커로 대체.
- **D2 대안 (22개 전부 async 등 일괄 변경)**: 어제의 전제(전부 재승인)에서 나온 안. 핸들러 단위 해시가 확인돼 불필요.
- **D3 대안 (프로젝트별 `.claude/skills/verify/` 생성)**: 저장소에 커밋 가능한 파일을 forgen 이 임의로 만들게 됨. user 레벨 1개 + "프로젝트 레시피 우선" 문구로 대체.

## Consequences

- 업그레이드 후 `forgen install codex` 를 다시 돌리면 `session_start:0:0`(modified) 과 `session_end:0:0`(신규) 이 `/hooks`
  승인 전까지 skip 된다 → **그 사이 Codex 세션에는 룰 블록이 주입되지 않는다.** install/doctor 가 정확히 그 2개를 표시한다.
  (이 경우 Stop/UserPromptSubmit 훅은 여전히 신뢰 상태라 alive 마커가 갱신되므로 notify 폴백은 조용하다 — 폴백이
  잡는 것은 "훅 전체가 미승인" 인 상황이다.) README/CHANGELOG 에 재승인 명시.
- notify 는 사용자가 이미 쓰고 있으면 설치되지 않는다 (폴백 부재 — install 출력에 표시).
- verify 스킬은 Claude 가 문서/테스트 전용이 아닌 커밋마다 실행하도록 안내받는다 → 커밋당 검증 시간이 늘어난다. 끄려면
  `~/.claude/skills/verify/` 를 지우거나 자기 것으로 교체.

## Verification plan

- vitest: trust 해시(실 `~/.codex` 해시와 동일 알고리즘 fixture), notify 블록 upsert/사용자 notify 보존/중복 키 방지,
  codex-notify alive·silent·nested 분기, session-end Codex 스키마 카운트, generator 의 Codex 전용 필드, verify 스킬 install/보존/uninstall.
- 격리 `CODEX_HOME`+`FORGEN_HOME` 실세션(`codex exec`): (1) 승인 전 — notify 가 silent 기록, (2) trust 우회 플래그 —
  alive 마커·SessionEnd 훅 발화·`hooks/list` 로 계산 해시 = Codex 해시 대조.
- fresh-context critic 리뷰 후 반영.

## Review (2026-10-02, fresh-context critic) — 반영 내역

실 Codex 0.153.4 app-server 로 재현된 결함과 수정:

| # | 결함 | 수정 |
|---|---|---|
| C1 | notify 블록 사이에 Codex 가 root 키(`model` 등)를 써 넣는다 (END 마커 주석이 "다음 테이블의 장식" 이라 그 앞에 삽입). 블록을 통째로 교체하면 그 키가 사라진다 | 블록을 줄 단위로 처리 — forgen 이 쓴 줄만 다시 쓰고 나머지는 블록 뒤로 옮겨 보존 |
| C2 | **기존 결함(0.5.3~)**: MCP 블록이 파일 끝에 있으면 `/hooks` 승인으로 생긴 `[hooks.state]` 테이블 22개가 END 마커 앞(= 블록 안)에 들어가고, 재설치가 전부 지운다 → 훅 신뢰 0/22 | 같은 방식. forgen 테이블의 `command`/`args` 만 갱신, 사용자가 붙인 키(`enabled` 등)는 테이블에 유지, 끼어든 테이블은 블록 뒤로 이동 |
| M1 | BOM 으로 시작하는 config.toml 앞에 블록을 붙여 BOM 이 7행으로 밀림 → Codex 기동 실패 | BOM 을 떼었다가 맨 앞에 재부착 |
| m1 | `"notify" = …`, `notify.x = …` 를 사용자 정의로 못 알아봐 중복 키 생성 | 키 패턴 확장 |
| m2 | Codex 추출 run 에 `FORGEN_NESTED_RUN` 미전달 | `execHost` codex 분기에 추가 (실 spawn 테스트) |
| m3 | SessionEnd 의 `async` 해시 정규화가 upstream 과 다름 | raw 플래그 해시 |
| m4 | 손편집된(여러 줄 등) 체인 꼬리를 조용히 버림 | `custom-block` — 건드리지 않음 |
| m7 | `enabled = false` 훅을 trusted 로 집계, 심링크된 `CODEX_HOME` 키 불일치 | `disabled` 분리, realpath 키도 대조 |
| m9 | notify 블록 제거 경로 없음 | `--no-notify` 와 uninstall 이 제거 |
| m10 | 폴백이 꺼진 `context-guard` 를 무시 | hook-config 확인 |

**남은 한계 (정직 표기)**:
- 폴백의 프롬프트 수는 rollout 전체 기준(resume 이력 포함)이고 Stop 경로는 훅이 본 프롬프트 수라, barren 쿨다운의 "세션 성장"
  판정이 두 경로 사이에서 정확히 같지 않다.
- `forgen uninstall` 은 Codex 의 notify 블록만 걷어낸다. hooks.json 의 forgen 엔트리와 MCP 블록 정리는 아직 없다 (기존 갭).
- Review/Compact 내부 서브세션에서 notify 가 Stop 훅 없이 발화하는지는 소스로만 확인했다 (doctor 2회 임계로 완화).

## Addendum (2026-10-02, v0.5.7) — D4: `forgen uninstall` 의 Codex 대칭

**현황**: `forgen install codex` 는 hooks.json 훅 22개 · config.toml 의 MCP/notify 블록 · `skills/` 24개 · `agents/ch-*.toml` 14개 ·
cwd 의 AGENTS.md 블록을 쓰지만, `forgen uninstall` 은 0.5.6 에서 notify 블록만 걷어낸다. 패키지를 지우면 Codex 는 매 훅
이벤트마다 사라진 스크립트를 실행하려다 실패한다. Claude 쪽에도 같은 종류의 누락이 있다 (`~/.claude.json` 의 MCP 등록,
`~/.claude/skills/forgen-<stack>-*` dev-guide 스킬).

**결정**:
- `planCodexUninstall` (`src/host/uninstall-codex.ts`) 를 추가하고 `handleUninstall` 이 `$CODEX_HOME` 이 있을 때 호출한다.
- **hooks.json**: forgen 핸들러만 제거, 사용자 핸들러/그룹은 보존. Codex 의 trust 키는 `<event>:<groupIdx>:<hookIdx>` 라,
  forgen 그룹을 지워 뒤따르는 사용자 그룹의 인덱스가 당겨지면 **다른 도구의 훅이 조용히 skip** 된다 (재승인 전까지).
  그래서 *뒤에 사용자 그룹이 남는 위치의* forgen 그룹은 빈 그룹(`{"hooks": []}`)으로 남겨 인덱스를 유지한다 — Codex
  0.153.4 `hooks/list` 로 확인: 빈 그룹은 경고 없이 로드되고 뒤 그룹의 신뢰가 유지된다. 뒤에 아무것도 없으면 그냥 제거한다.
  forgen 이 `hooks.state` 를 고쳐 쓰는 대안(키 재매핑)은 "신뢰 기록은 쓰지 않는다" 원칙에 어긋나 기각.
  남은 훅이 없고 파일이 forgen 이 만든 형태면 파일을 삭제한다. forgen 핸들러와 사용자 핸들러가 한 그룹에 섞여 인덱스가
  바뀌는 경우는 보존하되 재승인 필요 대상으로 보고한다.
- **config.toml**: MCP 블록(forgen 테이블과 그 하위 테이블)과 notify 블록을 제거. 블록 사이에 Codex 가 끼워 넣은 다른
  내용은 보존 (0.5.6 의 줄 단위 처리). 마커 없는 사용자 관리 테이블은 건드리지 않는다. `[hooks.state]` 는 손대지 않는다.
- **skills / agents**: forgen-managed 마커가 있는 `skills/<cmd>/SKILL.md`, `forgen-(react|vue|node|go)-*` dev-guide 스킬,
  마커가 있는 `agents/ch-*.toml` 만 제거. 사용자 작성/심링크는 보존.
- **AGENTS.md**: cwd(git root) 의 forgen 블록 제거. 블록뿐이던 파일은 삭제.
- **Claude 쪽 보강**: `~/.claude.json` 의 `mcpServers["forgen-compound"]` (forgen 서버 경로를 가리킬 때만),
  `~/.claude/skills/forgen-(react|vue|node|go)-*` 제거.

**대안**: (A) 현상 유지 + 문서로 수동 정리 안내 — 훅 실패가 매 턴 발생하므로 기각. (B) 인덱스 재정렬 + trust 키 재매핑 —
위 원칙 위반으로 기각. (C) 빈 그룹 없이 제거하고 재승인 안내 — 다른 도구의 훅이 조용히 멈추는 기간이 생겨 기각.

**리뷰 반영 (2026-10-02, critic 2라운드)**: 손편집된 notify 블록은 제거하지 않음(첫 줄만 지우면 TOML 이 깨져 Codex 기동 불가 —
0.5.6 의 `--no-notify`/uninstall 에 있던 결함), 체인된 사용자 notifier 복원, 훅 소유 판정을 "pkgRoot 의 dist/ 아래 · codex-adapter
경유 · registry 의 forgen 훅 이름" 으로 축소, 스킬/에이전트 마커를 위치까지 검사, dev-guide 스킬은 패키지가 제공한 이름만 제거,
단계별 오류 격리, 재설치 시 자리표시 그룹 재사용. 남은 한계: MCP 블록 처리는 TOML 파서가 아니다 — forgen 테이블 하위의
여러 줄 문자열 안에 `[` 로 시작하는 줄이 있으면 잘못 자를 수 있다(실사용에서 나오기 어려운 형태); OpenCode 등록분 정리 없음;
`forgen-<stack>-*` 이름의 사용자 스킬은 **install** 의 stale 정리가 여전히 지운다(기존 동작, 별도 정리 필요).

## Addendum (2026-10-02, v0.5.8) — 마커는 범위가 아니라 표식이다

**관측 (실머신, Codex 0.160.0)**: 사용자가 `/hooks` 로 훅을 승인하자 Codex 가 config.toml 을 다시 쓰면서 forgen MCP 블록의
마커가 뒤집혔다 — `# >>> forgen-managed-mcp` 는 forgen 테이블과 함께 파일 끝으로 가고, `# <<< forgen-managed-mcp` 는 앞쪽
`[hooks.state…]` 테이블 위에 고아로 남았다 (toml_edit 는 주석을 "다음 테이블의 장식" 으로 취급하고, 테이블을 재배치할 수 있다).
0.5.6/0.5.7 의 "BEGIN 부터 다음 END 까지" 탐색은 이 형태에서 블록을 찾지 못한다: 재설치는 안전하게 no-op 이지만(같은 테이블이
있으면 append 하지 않음) **uninstall 이 MCP 서버 등록을 지우지 못한다.**

**결정**: 마커를 범위로 쓰지 않는다. 마커는 "forgen 이 쓴 것" 이라는 표식이고, 실제 범위는 TOML 구조로 정한다.
- MCP: `[mcp_servers.forgen-compound]` 헤더부터 다음 테이블 헤더(또는 마커) 직전까지가 forgen 테이블. 파일 어디든 BEGIN 마커가
  하나라도 있으면 forgen 소유, 마커가 전혀 없으면 사용자 관리(건드리지 않음). 설치는 마커를 전부 걷어 테이블 바로 위아래에
  다시 두고 `command`/`args` 만 갱신한다. 제거는 테이블·하위 테이블·모든 마커 줄을 지운다.
- notify: BEGIN 마커 뒤(forgen 주석만 사이에 두고) 처음 나오는 `notify` 줄이 forgen 것. END 마커는 어디에 있든(또는 없어도)
  무방하다.
- 나머지 줄은 순서를 포함해 그대로 둔다. 줄을 지운 자리의 겹친 빈 줄만 하나로 줄인다.

**검증**: 이 머신의 실 config 사본에 적용 — 재설치 diff 는 고아 END 마커 한 줄의 이동뿐(hooks.state 31개 보존, 두 번째 실행은
바이트 동일), 제거 후 forgen 항목 0건, 두 결과 모두 Codex 0.160.0 `codex mcp list` 가 정상 파싱. Codex 0.160.0 의 훅 출력
스키마 11종은 0.153.4 사본과 동일, trust 해시도 동일(실머신 22/22 일치), 실세션에서 SessionStart(룰 주입)·Stop·SessionEnd 발화 확인.
