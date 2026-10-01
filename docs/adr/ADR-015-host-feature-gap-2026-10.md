# ADR-015: 최신 Claude Code 2.1.286 / Codex 0.153 대비 forgen 기능 갭 — 0.5.3 반영분과 백로그

**Status**: Accepted (2026-10-01) — 0.5.3 반영분 구현 완료. 백로그는 다음 릴리스 결정 대상.
**Reversibility**: Type 2
**근거**: fable 분석 에이전트 2건 (Claude Code 2.1.286 공식 docs/CHANGELOG 대조, Codex 0.153.4 공식 docs +
binary 문자열 대조). 보고서 원문은 세션 산출물; 핵심은 본 문서에 요약.
**관련**: ADR-014 (Codex 룰/에이전트), ADR-011/012 (auto-compound), [[forgen-autocompound-gap]]

## Context

오너 요청: "현재 Claude·Codex 최신 기술 대비 모자란 부분을 파악해 이번 버전에 같이 반영". 두 호스트의
현재 기능 표면을 forgen 사용 현황과 대조해 갭을 value/cost 로 순위화했다. 아래 "0.5.3 반영" 은
*오늘 바로 적용 가능하고 격리 환경에서 검증한 것* 만, 나머지는 설계 결정이 필요하거나 Codex hooks.json
변경(=훅 재승인) 이 필요한 것으로 백로그에 둔다.

## 0.5.3 에 반영한 것

### X-G1 (결함) Codex 에 Stop block 이 전달되지 않던 사영 버그 — 수정
- 증상: `codex-adapter` 의 `projectCodexToClaude` 가 `decision:"block"` 을 `continue:false +
  hookSpecificOutput.permissionDecision:"block"` 으로 바꿔 내보냈다. Codex 는 top-level `decision`/
  `reason` 을 읽고 `continue:false` 를 "처리 중단" 으로 해석하므로 **stop-guard 의 자기검증 차단이
  Codex 에서 단 한 번도 continuation 을 만들지 못했다** (forgen 의 핵심 wedge 가 Codex 에서 무력).
- 결정: 사영은 host-native 스키마를 **보존** 한다 (top-level 필드 pass-through, 이벤트명 보강, block 의
  reason 공백 보강, PreToolUse 의 `continue:false` 제거). parity 시나리오 `block-completion-stop` 은
  `decision`/`reason` 키로 비교.
- 검증: 격리 `codex exec` 에서 `rm -rf` 가 포함된 응답 → `hook: Stop Blocked` → `<hook_prompt>` 로
  stop-guard 사유가 다음 턴에 주입되고 모델이 자기 교정. vitest projection/parity 갱신.

#### X-G1 후속 (0.5.4): 출력 스키마 준수
0.5.3 사영은 모든 출력에 `hookSpecificOutput.hookEventName` 을 붙였고, Codex Stop/SubagentStop 스키마는
`hookSpecificOutput` 을 허용하지 않아(`additionalProperties:false`) 실환경에서 Stop 훅이 매 턴 Failed 였다.
0.5.4 에서 이벤트별 allowlist(`CODEX_OUTPUT_SCHEMA`) 로 재작성하고 rust-v0.153.4 스키마를 vendoring 한
conformance 테스트를 추가. 교훈: **격리 검증은 실환경과 같은 입력(실 stdin 의 `hook_event_name`)으로
돌려야 한다** — 0.5.3 격리 통과는 입력 필드명 불일치 덕분의 우연이었다.

#### 0.5.5: Codex Stop 분기 복구
`context-guard` 의 Stop 판별이 Claude 전용 `stop_hook_type` 에 묶여 있어 Codex 에서 Stop 트리거
auto-compound / finalizeSession 이 돌지 않았다. `hook_event_name:"Stop"` 을 인정하도록 수정.
교훈: **host 간 입력 필드 차이**(Claude `stop_hook_type` vs Codex 없음)는 사영이 아니라 각 훅의 판별
로직에서도 터진다 — 훅마다 "이 분기가 Codex 입력으로도 도달하는가" 를 hook-timing 의 event 라벨로
확인할 것.

### X-G2 Codex 훅 신뢰 가시화 — ADR-014 D4 로 이미 반영 (실머신: 20/21 trusted, 미지원 이벤트 1 분리)

### C-G6 `SessionEnd` 훅 (Claude 전용) 으로 auto-compound 트리거 보강
- 메모리 [[forgen-autocompound-gap]]: auto-compound 는 Stop 트리거라 Ctrl+C/종료·긴 컴팩션 세션의 후반
  학습이 유실. Claude Code 2.1 의 `SessionEnd` (예산 1.5s) 에서 user 메시지 ≥10 이면 detached 러너 spawn.
  `runAutoCompound` 의 in-flight/cooldown dedup 이 Stop/PreCompact 와의 이중 실행을 막는다.
- registry 에 `hosts: ["claude"]` 도입 — **Codex hooks.json 은 22개 바이트 동일 유지** (훅 신뢰 보존).

### C-G1 중첩 `claude -p` 실행에서 forgen 훅 재귀 발화 차단
- `--bare` 는 OAuth 를 끊어(ANTHROPIC_API_KEY 전용) 쓸 수 없다. 대신 forgen 이 띄우는 추출 run 에
  `FORGEN_NESTED_RUN=1` 을 주입하고 `isHookEnabled` 가 이를 최우선으로 읽어 모든 훅을 끈다.
  `--no-session-persistence` 로 추출 run transcript 가 디스크/다음 SessionStart 의 "이전 세션" 후보에
  남지 않게 한다.

### C-G2 플러그인 `skills/*/SKILL.md` frontmatter 보존
- 빌드가 name+description 만 남겨 `/forgen:ship` 의 `disable-model-invocation: true`, `allowed-tools`,
  `argument-hint`, `model` 이 플러그인 스킬에서 사라졌다 (모델이 릴리스 파이프라인을 자동 호출 가능).
  이제 command 소스의 frontmatter 전체를 보존 (`name` 만 디렉토리명으로 고정).

## 백로그 (설계 결정 또는 훅 재승인 필요 — 0.5.3 미반영, 정직 표기)

| # | 항목 | 왜 보류 | 비용 |
|---|---|---|---|
| X-G3 | Codex `notify` 설정으로 trust-free turn-complete 신호 → auto-compound/evidence | config.toml 단일 배열이라 사용자 값과 병합 불가, 설계 필요 | S |
| X-G4 | `codex exec --json` usage → usage-telemetry, `--output-schema` 로 추출 구조화 | 추출 파싱이 0.5.2 에서 막 재설계됨, 회귀 위험 | S/M |
| X-G5/G6 | Codex `async:true`, `additionalContextLimit:0`, SessionEnd/PostCompact/Interrupt 등록, dead `PostToolUseFailure` 제거 | hooks.json 변경 = 22개 훅 `/hooks` 재승인. 한 번에 묶어 다음 릴리스 | M |
| X-G7 | `mcp_tool` 훅으로 관찰 훅 통합 (node spawn 22→1) | 신뢰 모델 상호작용 미검증 | M/L |
| X-G8 | 프로젝트 `.codex/` 레이어 (agents/rules/hooks), `.codex/rules` prefix_rule 로 db-guard/secret 네이티브화 | 저장소 커밋 경로 설계 | M |
| X-G9/G10 | managed hooks(requirements.toml), Codex memories/`/import` 와 compound 의 관계 | 설계 | L |
| C-G3 | 2.1.286 `verify` 스킬 규약 (커밋 전 자동 실행) 에 forgen-verify 연결 | 플러그인 네임스페이스가 규약을 만족하는지 미확인 | S |
| C-G4 | stop-guard 의 `stop_hook_active` 처리 + Stop `additionalContext` 로 advisory 룰 전달 | 현재 per-rule 3-strike 와의 관계 결정 필요 (Mech-B 설계) | S |
| C-G5 | tool 훅 `if:` 필터, `async`, PreToolUse `updatedInput`/`additionalContext` | Codex hooks.json 과 분기 필요, 성능 측정 먼저 | S/M |
| C-G7 | `InstructionsLoaded` 훅으로 "룰이 실제 로드됨" 증거 | 이벤트 의미 미검증 | S |
| C-G8 | `claude plugin eval` 을 공개 증명 하네스로 | forgen-eval 과의 공존 설계 | M |
| C-G9 | `type: prompt`/`agent` Stop 훅으로 Mech-B 판정 | Codex parity 깨짐, 비용 오너 결정 | M |
| C-G10 | 플러그인 매니페스트 통합 (settings.json 절대경로 주입·수동 plugin cache 제거) | 설치 경로 전면 변경 | M |

## Verification (0.5.3)
- vitest 전체 + 신규: `tests/host/projection.test.ts`(재작성), `tests/hooks-generator-hosts.test.ts`,
  `tests/session-end.test.ts`. self-gate static/runtime.
- 격리 라이브 (Codex 0.153.4): Stop block continuation 1건 관측.
- fresh-context critic (fable) 2라운드: MAJOR 2 반영 — SessionEnd 가 대용량 transcript 전체를 세다
  예산 초과(239MB=3.2s)로 SIGKILL → 앞 200KB 만 세는 bounded count + timeout 3s; 중첩 run 의 hook-timing
  기록 생략. MINOR — invoke-agent 는 `nestedRun:false` 로 훅 유지, projection 이 stdin 의
  `hook_event_name`(snake_case) 도 읽음.
