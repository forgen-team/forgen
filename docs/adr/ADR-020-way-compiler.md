# ADR-020: Way 컴파일러 — 내 방식을 다른 모델·스킬로 내보낸다

**Status**: Accepted (2026-11-04)
**Reversibility**: Type 2 (새 저장소 없음. 읽기 뷰와 파일 출력만 추가)
**관련**: docs/plans/2026-11-04-reliability-decisions.md D0(안 1)·D13, audit extensibility E2·E4·E6·E7

## Context

최종 목표는 오너가 AI 를 쓰는 방식을 정리해 다른 모델에 적용하고 스킬·워크플로우로 만드는 것이다.
감사에서 확인된 결함: 호스트 중립 원본 없음(E2), promote 가 SKILL.md 를 만들지 못함(E6),
Gemini·Cursor·AGENTS.md 로 내보낼 수 없음(E7), 호스트 메모리를 읽지 않음(E4).

## Decision

D0 안 1: 기존 저장소를 그대로 쓰고 읽기 뷰(Way)와 컴파일러를 얹는다. 새 저장소 금지.

1. `src/way/extract.ts` 가 룰·evidence·솔루션·behavior·프로필을 `WayItem` 으로 읽는다.
   필드: id, kind(rule·solution·habit), statement, applies_when, why, projects, strength,
   provenance(you-said 원문·날짜 / mined / imported), enforceable. `enforce_via`·hook 이름은 노출하지 않는다.
2. `src/way/compile.ts` 순수 함수 `compile(way, target, {project, budget})` → `{files, omitted, degraded}`.
   예산 초과는 자르지 않고 우선순위(강도 > 사용자 발언 > 룰 > 솔루션 > 습관)로 고르며 빠진 항목은 `omitted`.
   어떤 대상도 룰을 강제하지 못하므로 강제 가능한 룰은 `degraded` 에 "자문으로 전환".
3. 프로젝트 필터: `--project` 가 없으면 전역 항목만. 프로젝트 항목은 `omitted(project-scope)`.
4. 쓰기 보호: `--out` 이 있을 때만 쓴다. 쓰는 파일과 상위 디렉터리를 realpath 로 풀어 `--out` 의 실경로 밖이면(`..`, 심링크 파일·디렉터리, 끊어진 링크) 거부한다.
   기존 파일이 다르면 `--force` 필요(덮어쓰기 전 `<파일>.forgen-bak-<시각>` 백업). 파일 앞 16줄 안에 표식 줄
   (`<!-- forgen-way ... -->` 전체가 한 줄, json 은 최상위 schema·generator)이 없으면 `--force` 로도 덮어쓰지 않는다 — 본문 아무 데나 있는 단어는 표식이 아니다.
   하나라도 막히면 아무것도 쓰지 않는다.
5. `skill promote` 는 이 컴파일러를 쓴다. 빈 내용 솔루션은 거부, `compound --verify` 게이트는 그대로.
6. `forgen install codex` 는 cwd 가 아니라 `$CODEX_HOME/AGENTS.md` 에 쓴다(E7). 예전 설치가 기록해 둔 경로·현재 cwd·`~/AGENTS.md` 의 forgen 표식 블록은
   설치 때 걷어내고(사용자 글 보존, 블록뿐인 파일은 삭제) 실행 결과에 나열한다. `AGENTS.override.md` 가 같은 위치에 있으면 Codex 는 그것만 읽으므로 경고한다.
   OpenCode 도 같은 원칙으로 `<config>/AGENTS.md`(기본 `~/.config/opencode/AGENTS.md`)에 쓰고 예전 cwd 블록을 걷어낸다.

## 1차 문서 확인 결과 (2026-11-04 WebFetch)

| 대상 | 상태 | 확인한 형식 | 근거 |
|---|---|---|---|
| AGENTS.md | 확인 | 평문 Markdown, 필수 필드 없음, 가장 가까운 파일이 우선. 공식 스펙이 아니라 개요 문서(스키마·버전 정책 없음) | https://agents.md |
| SKILL.md | 확인 | frontmatter `name`(1-64자, 소문자·숫자·하이픈, 디렉터리명과 동일)·`description`(1-1024자, 무엇을·언제), 선택 `license`·`compatibility`·`metadata`(문자열 맵)·`allowed-tools`. 본문 형식 자유, 500줄 미만 권장 | https://agentskills.io/specification |
| Claude Code 스킬 | 확인 | `~/.claude/skills/<name>/SKILL.md`(개인), `.claude/skills/<name>/SKILL.md`(프로젝트). description 이 자동 호출 판단 근거, description+when_to_use 는 1,536자에서 잘림 | https://code.claude.com/docs/en/skills |
| Claude Code rules | 확인 | `.claude/rules/*.md`(재귀), `~/.claude/rules/`(전 프로젝트), 선택 frontmatter `paths`. 지침은 강제가 아니라 컨텍스트이며 강제는 PreToolUse hook. `AGENTS.md` 는 CLAUDE.md 가 없을 때 v2.1.277+ 에서 직접 읽음 | https://code.claude.com/docs/en/memory |
| Gemini CLI | 확인(주의) | `~/.gemini/GEMINI.md`, 작업공간·상위 `GEMINI.md`, `@file.md` import, `context.fileName` 으로 `AGENTS.md` 지정 가능. 문서에 "2026-06-18 Antigravity CLI 로 대체"라는 안내가 있어 새 버전에서 다를 수 있음 | https://geminicli.com/docs/cli/gemini-md/ |
| Cursor rules | 확인 | `.cursor/rules/*.mdc`(`.md` 는 무시), frontmatter `alwaysApply`·`globs`·`description`. AGENTS.md 도 지원 | https://cursor.com/docs/context/rules |
| Claude Code 워크플로우 | **미확인 → 구현 안 함** | 공식 문서를 찾지 못했다(검색 결과는 서드파티뿐). 기존 `assets/claude/workflows/*.js` 는 forgen 자체 템플릿 | - |
| 호스트 중립 체크리스트 | 확인 불필요 | 외부 표준이 없는 forgen 자체 Markdown 체크리스트 (`target: workflow`) | - |
| system-prompt | 확인 불필요 | 단일 텍스트. 표준 없음 | - |

`workflow` 대상은 Claude Code 워크플로우가 아니라 호스트 중립 체크리스트만 낸다.

## 대상별 산출

| target | 파일 | 기본 예산 |
|---|---|---|
| agents-md | `AGENTS.md` | 8000자 |
| claude-rules | `.claude/rules/forgen-way.md` | 8000자 |
| skill | `.claude/skills/<name>/SKILL.md` (솔루션 + 상황이 적힌 workflow 룰마다 하나) | 없음 |
| system-prompt | `system-prompt.txt` | 8000자 |
| gemini | `GEMINI.md` | 8000자 |
| cursor | `.cursor/rules/forgen-way.mdc`(alwaysApply) + `forgen-way-situational.mdc` | 8000자 |
| workflow | `forgen-way-checklist.md` | 8000자 |
| json | `forgen-way.json` (왕복용, `forgen way import`) | 없음 |

`--out` 은 산출 경로의 루트다. 산출 경로가 대상마다 달라 `--out ~` 가 전역이 되는 것은 `claude-rules`(`~/.claude/rules/forgen-way.md`)와 `skill`(`~/.claude/skills/`)뿐이다.
`--out ~` 로 `AGENTS.md`·`GEMINI.md`·`.cursor/rules` 를 내면 `~/AGENTS.md` 처럼 어느 도구도 전역으로 읽지 않는 자리에 떨어진다. 전역 위치(1차 문서 기준):

| 대상 | 전역 위치 | 명령 |
|---|---|---|
| Codex (agents-md) | `$CODEX_HOME/AGENTS.md` (기본 `~/.codex/AGENTS.md`). 같은 위치의 `AGENTS.override.md` 가 있으면 그것만 읽는다 (learn.chatgpt.com/docs/agent-configuration/agents-md) | `--out ~/.codex` (`forgen install codex` 가 관리하는 같은 파일은 표식이 달라 거부된다) |
| Gemini CLI | `~/.gemini/GEMINI.md` | `--out ~/.gemini` |
| Claude Code | `~/.claude/rules/`, `~/.claude/skills/` | `--out ~` |
| Cursor | 파일 없음. User Rules 는 Customize → Rules 화면에 붙여넣는다 (cursor.com/docs/context/rules) | 프로젝트용만 `--out <루트>` |

`way export` 에 `--global` 은 두지 않는다. 경로 안내만 export 결과에 출력한다.
`~/.claude/rules/v1-rules.md`(forgen 렌더)와 `forgen-way.md` 를 함께 두면 같은 룰이 두 번 컨텍스트에 들어간다.
사용자 수준 Claude 에는 forgen 렌더만 쓰고, `claude-rules` 산출은 다른 프로젝트로 옮길 때 쓴다.

## 알려진 한계

- 룰 `trigger` 는 "교정이 필요했던 계기"이지 적용 조건이 아니다. `claude-rules`·`skill`·`json` 에만 "계기"로 싣고 나머지 대상에서는 뺀다. 알려진 프로젝트 이름을 말하는 계기는 다른 프로젝트 산출물에서 숨긴다.
- 룰에는 사용 시점이 없어 skill 대상은 기본적으로 솔루션(Context 가 있는 것)만 낸다. 룰은 `--item` 으로 지정해야 나오고 "낮은 품질"로 표시된다. 맥락 있는 스킬은 `forgen way draft skill "<주제>"`. 금지 룰은 "절차"가 아니라 "금지"로 쓴다. 스킬 이름은 영문이면 슬러그, 한글이면 로마자 표기 슬러그.
- 프로젝트를 지정하지 않은 전역 산출물에는 프로젝트 전용일 수 있는 룰(알려진 프로젝트 키 언급, 제품 이름으로 시작)을 경고한다. 분류는 `forgen rule classify-projects`.
- 다른 모델 대상(agents-md·gemini·cursor·system-prompt·workflow)에서는 문장 끝의 호스트 전용 절(`secret-filter hook` 등)만 떼고, 문장 안에 남으면 degraded 로 표시한다.
- 예산 우선순위와 render_key 중복 제거는 렌더러(`compareRank`)와 같은 비교를 쓴다. 프로젝트 가산점은 없다.
- import 신뢰 경계: 적용 전 자동 스냅샷, 알 수 없는 필드 거부, `hard` 신규 부여 금지, 강도 하향·강제 룰 문장 수정은 `--allow-enforced-edit` 없이 거부, 새 룰은 active 만.
- `habit`(behavior md 의 `- [분류] 문장`, 프로필 팩)은 모델이 쓴 잡음이 많아 `--habits` 일 때만 내보낸다.
- 준수 여부는 이 ADR 의 범위가 아니다. 호스트가 파일을 읽는 것까지만 실물로 확인했다.
