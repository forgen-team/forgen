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
