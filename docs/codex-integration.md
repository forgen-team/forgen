# Codex CLI Integration — Hook 발화 가이드 + 알려진 갭

**Status**: Active (2026-05-14, 0.5.3 갱신 2026-10-01)
**Related**: ADR-001 (mech-ABC), `~/.codex/hooks.json`, `src/host/codex-adapter.ts`

## 요약

forgen 의 Codex hook 등록은 정상이며 (`~/.codex/hooks.json` 의 9개 이벤트
모두 codex-adapter 경유로 wired), 실제 발화도 hook-timing.jsonl 에서 확인됨.
다만 Codex CLI 의 정책 결정 한 가지로 인해 **PermissionRequest 이벤트가
dispatch 되지 않는 환경**이 존재하며, 본 문서는 이 갭과 forgen 측 보완 동작을
박제한다.

## 0.5.3 (ADR-014) — Claude 와 동등해진 것 / 아직 아닌 것

**동등 (실세션 실증)**: hooks.json 22종 (0.5.6: SessionEnd 추가, Codex 미지원 PostToolUseFailure 제외) · MCP forgen-compound · 스킬 10+14 ·
**개인화 룰 주입** (`<forgen-rules host="codex">`, SessionStart; 컴팩션 시 SessionStart 재발화로 재주입) ·
**서브에이전트 14종** (`~/.codex/agents/ch-*.toml`) · auto-compound / FTS / 세션 기록.

**0.5.3 에서 고친 결함**: `codex-adapter` 사영이 Stop `decision:block` 을 `continue:false` 로 변조해
**자기검증 차단이 Codex 에 전달되지 않았다** (ADR-015 X-G1). 이제 pass-through. 격리 `codex exec` 에서
`hook: Stop Blocked` → continuation 관측.

**0.5.4**: Codex 는 이벤트별 출력 스키마가 `additionalProperties:false` 다. Stop/SubagentStop 에
`hookSpecificOutput` 을 보내면 출력 전체가 버려지고 `hook: Stop Failed` 로 표시된다. 사영이 이벤트별
allowlist 로 깎아 보내며, 스키마 사본은 `tests/fixtures/codex-hook-schemas/`.

**0.5.5**: Codex 의 Stop 입력에는 `stop_hook_type` 이 없다. forgen 훅이 Stop 을 판별할 때는
`hook_event_name === "Stop"` 도 봐야 한다 (context-guard 수정). 확인법: `hook-timing.jsonl` 의
`event` 라벨이 Stop 시점에 `Stop` 으로 찍히는지.

**0.5.6 (ADR-016)** — Codex 0.153.4 소스로 전제를 재검증하고 반영:
- **trust 해시는 핸들러 단위** (`event` + `matcher` + 정규화된 핸들러 1개). 새 이벤트 추가·append·미지원 이벤트 제거는
  기존 훅의 신뢰를 건드리지 않는다. 필드(`command`/`timeout`/`async`/`additionalContextLimit`/`matcher`)를 바꾼
  핸들러만 `modified` 가 되어 skip 된다. → 0.5.6 재설치 시 재승인 대상은 **2건**: `session_start:0:0`(modified),
  `session_end:0:0`(신규).
- **SessionEnd 훅을 Codex 에도 등록** — Stop 없이 끝나는 세션의 auto-compound 트리거 (관찰 전용, 1~3s clamp).
- **`session-recovery` 에 `additionalContextLimit: 0`** — Codex 는 `additionalContext` 가 약 10KB(2,500 근사 토큰)를
  넘으면 임시 파일로 스필하고 모델에는 머리/꼬리 미리보기만 준다. 한국어 룰 블록은 쉽게 넘는다. 격리 실세션에서
  기본값은 21KB 블록의 중간이 보이지 않았고, 0 으로는 전문이 전달됨을 확인.
- **`notify` 폴백** — `forgen install codex` 가 config.toml 최상단에 `notify = ["node", ".../dist/host/codex-notify.js"]`
  를 마커 블록으로 등록. notify 는 훅 신뢰와 무관하게 턴 완료마다 돈다: forgen 훅이 방금 돌았으면(codex-adapter 의
  alive 마커) 아무것도 하지 않고, 돌지 않았으면 `state/codex-hooks-silent.json` 을 남기고(`forgen doctor` 가 표시),
  프롬프트 ≥10 인 세션은 Stop 훅과 같은 디바운스 경로로 auto-compound 를 띄운다. **이미 `notify` 를 쓰고 있으면
  건드리지 않는다** — 체인하려면 `notify = ["node", ".../codex-notify.js", "--", "<원래 프로그램>", "<인자…>"]`.
  끄기: `forgen install codex --no-notify`.
- **`forgen doctor` / install 출력이 trusted / modified / new 를 구분** — forgen 이 Codex 와 같은 해시를 계산해 대조한다
  (읽기 전용; 신뢰 기록은 쓰지 않는다).
- **하지 않은 것**: `async` 훅 (같은 이벤트의 핸들러는 이미 동시 실행 — 실측 이득 상한 ≈130ms/이벤트, 대신 제어 효과
  상실·재승인 비용), `PostCompact`/`Interrupt` 등록 (컨텍스트 주입 불가, 할 일이 없음).

**0.5.8 — Codex 0.160.0 확인**: 훅 출력 스키마·trust 해시·이벤트 구성이 0.153.4 와 같다 (스키마 11종 대조, 실머신 22/22).
Codex 는 config.toml 을 다시 쓰며 forgen 마커 주석을 옮긴다 — forgen 은 마커를 범위로 쓰지 않고 TOML 구조로 자기 테이블/키를
찾는다 (ADR-016 0.5.8 addendum).

**아직 다른 것**:
- 룰 재로드 빈도: Claude 는 `.claude/rules` 매 턴, Codex 는 세션 시작 + 컴팩션 후.
- 훅 신뢰: Codex 는 새로 추가되거나 바뀐 훅을 `/hooks` 승인 전까지 **skip** 한다.
  `forgen doctor` 의 `[Codex Hooks]` 섹션으로 상태 확인. forgen 은 신뢰 기록을 쓰지 않는다.
- `PostToolUseFailure` 는 Codex 이벤트가 아니다. 0.5.6 부터 Codex hooks.json 에 등록하지 않는다 (실패 복구 안내는
  Claude 전용).
- 서브에이전트 모델은 Codex 기본 subagent 모델 (`[agents] default_subagent_model`).
- Claude 의 `verify` 스킬 규약(커밋 직전 자동 실행, 0.5.6 에서 `~/.claude/skills/verify` 설치)은 Codex 에 동등 기능이 없다.

### 훅 신뢰 체크리스트 (0.5.6+)
1. `forgen install codex` 출력의 `hook trust: N/22` 와 그 뒤의 목록 확인 — `(modified)` 는 바뀐 훅, `(new)` 는 새 훅.
2. N < 22 이면 codex TUI 에서 `/hooks` → forgen 엔트리 trust. `session_start` 가 대기 중이면 그동안
   `<forgen-rules>` 블록이 주입되지 않는다.
3. 글로벌 npm 업그레이드만으로는 Codex hooks.json 이 바뀌지 않는다 (postinstall 은 Codex 를 건드리지 않음) —
   `forgen install codex` 를 다시 실행했을 때만 위 2건이 재승인 대상이 된다. `npm link` 등으로 pkgRoot 가 바뀌면
   command 문자열이 달라져 전부 재승인.
4. 비대화형 자동화에서만 `codex exec --dangerously-bypass-hook-trust` (forgen 은 쓰지 않음).

## 권장 Codex 설정 (이상적)

`~/.codex/config.toml` (또는 동등 설정):

```toml
approval_policy = "ask"   # 또는 "suggest"
```

`auto` / `dangerously-auto-approve` / `workspace-write` (sandbox) 정책은
PermissionRequest hook 을 **skip** 하고 자동 승인 처리한다. forgen 의
permission-handler 가 등록되어 있어도 Codex 가 호출 자체를 안 함.

증거:
- Codex binary strings: `"internally tagged enum HookHandlerConfig matcher
  PreToolUsePermissionRequestPostToolUse"` — PermissionRequest 는 enum 에만
  존재
- Claude Code 는 모든 정책에서 PermissionRequest 를 dispatch (
  `permissions-<sessionId>.jsonl` 이 항상 갱신됨)
- Codex `auto` 세션에서는 `permissions-<codex-sessionId>.jsonl` 미생성 관찰

## forgen 측 보완 (0.4.6+)

`approval_policy=ask` 권장은 사용자 환경 변경을 요구하므로, forgen 0.4.6 부터
**PreToolUse hook 측에서 권한 결정을 보완 기록**한다:

- 위치: `src/hooks/pre-tool-use.ts`
- 동작: 모든 tool call 에서 sessionId, tool_name, args summary, decision
  (`auto-allowed` 또는 `pre-approved`), timestamp 를 `~/.forgen/state/
  permissions-<sessionId>.jsonl` 에 append
- Claude session 과 dedup: Claude 측 permission-handler 가 동일 record 를 이미
  쓴 경우 PreToolUse 보완은 skip (timestamp 윈도우 1s 기준)
- Codex `auto` 세션도 권한 흐름이 박제되어 forgen me / calibrate / 측정
  트랙에서 동일 가시성 확보

## 알려진 갭 (작동 정상이나 사용자가 오해할 수 있는 출력)

### context-signals.json
**오해**: "Codex 세션에서 갱신 안 됨 → hook 죽음"
**실제**: 도구 실패 (PostToolUseFailure) 시에만 쓰는 의도된 동작. Codex 세션에
실패 이벤트가 없었으면 안 쓰는 게 정상.

### prompt-history.jsonl (0.4.5 이전)
**0.4.5 이전**: writer 부재. compound-extractor.ts:547 에서 read 만 하는 dead
code 잔재.
**0.4.6+**: UserPromptSubmit hook 경로에 writer 신설. sessionId, runtime,
prompt(truncated 1KB), timestamp 를 append.

## 디버깅 체크리스트

Codex hook 발화 검증 시:

1. `~/.codex/hooks.json` 존재 + 9개 이벤트 등록 확인
2. `~/.forgen/state/hook-timing.jsonl` 의 최근 엔트리 timestamp 확인
   (Claude/Codex 구분 없음 — 실행 자체는 검증 가능)
3. `~/.forgen/state/sessions/<id>.json` 생성 확인 (codex 세션 시작 시)
4. PermissionRequest 가 안 보이면 `~/.codex/config.toml` 의 `approval_policy`
   확인 → `ask` 로 변경 OR forgen 0.4.6+ 의 PreToolUse 보완 동작 활용
