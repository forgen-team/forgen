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

**동등 (실세션 실증)**: hooks.json 22종 동일 · MCP forgen-compound · 스킬 10+14 ·
**개인화 룰 주입** (`<forgen-rules host="codex">`, SessionStart; 컴팩션 시 SessionStart 재발화로 재주입) ·
**서브에이전트 14종** (`~/.codex/agents/ch-*.toml`) · auto-compound / FTS / 세션 기록.

**0.5.3 에서 고친 결함**: `codex-adapter` 사영이 Stop `decision:block` 을 `continue:false` 로 변조해
**자기검증 차단이 Codex 에 전달되지 않았다** (ADR-015 X-G1). 이제 pass-through. 격리 `codex exec` 에서
`hook: Stop Blocked` → continuation 관측.

**아직 다른 것**:
- 룰 재로드 빈도: Claude 는 `.claude/rules` 매 턴, Codex 는 세션 시작 + 컴팩션 후.
- 훅 신뢰: Codex 는 hooks.json 이 바뀌면 `/hooks` 재승인 전까지 해당 훅을 **skip** 한다.
  `forgen doctor` 의 `[Codex Hooks]` 섹션으로 상태 확인. forgen 은 신뢰 기록을 쓰지 않는다.
- `PostToolUseFailure` 는 Codex 이벤트가 아니라 발화하지 않음 (context-signals 미기록). trust 감사에서는
  `ignoredByCodex` 로 분리 집계 (21/21 이 정상, 22 가 아님).
- 서브에이전트 모델은 Codex 기본 subagent 모델 (`[agents] default_subagent_model`).

### 훅 신뢰 체크리스트 (0.5.3+)
1. `forgen install codex` 출력의 `hook trust: N/21` 확인 (+1 Claude-only event ignored by Codex).
2. N < 21 이면 codex TUI 에서 `/hooks` → forgen 엔트리 trust.
3. 글로벌 npm 업그레이드는 경로가 같아 hooks.json 이 바이트 동일 → 기존 신뢰 유지. `npm link` 등으로
   pkgRoot 가 바뀌면 재승인 필요.
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
