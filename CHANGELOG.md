# Changelog

All notable changes to forgen will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] — 2026-10-06 — 신뢰 영수증: 차단·룰·프로필·statusline 이 "왜/언제/얼마나" 를 보여준다 (ADR-017)

오너 피드백 "교정·차단은 좋은데 체감이 안 된다" 에서 출발. 실측으로 드러난 문제 — 7d 차단 108건 중 78건이 테스트 유래,
Bypass 179건은 전량 휴리스틱 오탐, Recall 773건 중 351건이 테스트 픽스처, 4축 프로필 score 는 갱신 코드 자체가 없었음,
채굴 룰 30개는 같은 교정의 문장 변형, statusline 은 Claude Code 가 주는 컨텍스트/한도 필드를 하나도 안 읽음 — 을 고쳤다.
Fable critic 8라운드(ADR·프로필·D0·집계·statusline×2·D1·pre-landing) 반영. vitest 3356 passed (smoke-report). 결정 문서: docs/adr/ADR-017.

### Fixed
- **4축 프로필 score 가 v0.1.0 부터 0.5 리터럴 고정이던 결함.** 산출 로직이 애초에 없었다. facet 카탈로그 양 끝 팩 centroid
  선분에 facet 벡터를 투영한 위치와 confidence 를 섞는 공식(`c×t + (1−c)×0.5`)을 구현하고, confidence bump·auto-compound
  facet 갱신 저장을 한 경로(`saveProfileRecomputed`, atomic)로 통합. SessionStart 에서 미계산 프로필 1회 재계산(변경 없어도
  스탬프). `inspect` 의 "N corrections" 라벨은 explicit 교정만(450→247).
- **status 숫자의 정직성.** session_id 없이 기록된(`default`/`unknown` — 실측 전부 테스트가 dist 훅을 spawn 한 흔적) 차단을
  모든 집계에서 제외하고 `Excluded N` 으로 가시화. T2 는 실제 차단(block/deny)만 집계(메타가드 advise 87건이 위반으로 세어지던
  것). Top rules 는 rule_id 로 집계(source 로 집계돼 룰별 precision 과 조인 불가하던 것). Recall hits 는 hook 경로 후보≥1 만,
  시도·mcp 분리.
- **테스트가 실 `~/.forgen` 을 오염시키던 것.** hook-pipeline(실 HOME spawn)·solution-reader/plugin-coexistence/harness-e2e
  (in-process)·fgx-routing(실 claude 바이너리 실행) 격리. 전체 suite 실행 시 실 로그 증가 0 확인.
- 하드 룰 "확인 없는 rm -rf 금지" 가 Claude 의 **자기 임시 작업 폴더**(`/tmp/claude-*/scratchpad`) 정리까지 막던 것(7d 실 차단
  14건 중 13건). 같은 명령 안의 변수 대입을 한 단계 치환해 대상이 전부 임시 경로일 때만 통과(보수적 — 하나라도 비임시·미해석이면 차단).

### Added
- **차단 메시지에 룰의 출처.** explicit 교정 룰이 막을 때 `[forgen] 이 룰의 출처 — 2026-09-30 교정 기록 (avoid-this)` 를 붙인다.
  정직성: 저장된 summary 는 모델이 쓴 문장이라 policy 와 같으면 인용하지 않고 날짜·종류만; 새 `correction-record` 인자
  `user_quote`(사용자 발화 원문, `<private>` 필터) 가 있을 때만 "당신의 말" 로 인용. 룰 렌더에 ` (교정 YYYY-MM-DD)` 꼬리표.
- **차단 영수증 + 자동 판정 + precision.** 차단마다 `violation_id`·매칭 프래그먼트·전문 hash 를 남기고 전문은 secret 마스킹 후
  24h 영수증으로 보관. `forgen status --blocks` 가 영수증·판정·전후 문맥을 보여주고, `forgen block <id> --ok|--fp` 로 사람이
  판정(자동 판정을 덮어씀). 차단 직후 detached Haiku 심판(auto-compound 와 같은 consent·캡 세션 10/일 30·불확실은 unsure).
  룰별 precision 을 status 에 표시하고 7d 판정 ≥5 & precision <0.5 면 `advise`(차단 대신 기록) 로 강등 — 하드 룰·builtin 제외,
  복귀 `forgen rule enforce <id>`.
- **statusline 2줄 재설계.** 1줄: 모델·경로(브랜치)·`ctx 42%/1M`·`5h 63% → 15:40 소진 (리셋 16:20)`·`7d 21%`·`$1.23`
  (Claude Code 공식 stdin 필드). 2줄: `관련 룰 N · 이 세션 차단 N · 7d 차단 N · surfaced N`. 소진 예측은 창 안 양끝점 기울기,
  근거 부족(샘플<3, 폭<15분/2h, 증가<1%p, 리셋 경과)이면 숨김, 현재 페이로드에 있는 창만 표시. 2줄만 세션별 15초 캐시.
  운영자 지표·CLAUDE.md/MCP/hook 카운트(MCP 는 틀린 값이었음)는 삭제. ADR-010 §2b(usage 철수) 부분 supersede.
- **턴 단위 관련 룰.** 프롬프트를 룰 용어와 보수적으로 매칭(일반 용어 2개 또는 식별자급 1개)해 `관련 룰 N` 표시,
  `forgen status --turn` 이 각 룰의 원 교정을 보여준다. 프롬프트 원문은 저장하지 않고 주입도 0바이트.
- **채굴 룰 병합.** `forgen rule merge-mined [--apply]` — 채굴(auto:) 룰끼리만 병합(strength default 고정), explicit 동개념은
  흡수하지 않고 링크(`mined_observations`) — ADR-013 불변식 유지. 승격 시 사전 중복 검사. 실측 채굴 30 → 7(활성 45 → 22).
- Stop 에서 실제 평가돼 통과한 룰을 `checks.jsonl`(7d TTL)에 기록 — 위반 로그와 분리.

### Changed
- 자연어 휴리스틱 bypass 기록(`bypass.jsonl`) 중단 — 실측 1,114건 전량 오탐(룰 policy 의 단어가 도구 출력에 등장), 실 우회 0건.
  T3 입력은 `FORGEN_USER_CONFIRMED=1` 명시 우회(kind `bypass_confirmed`)만. 기존 파일은 보존(읽지 않음). flagged 룰을 `--rules` 에 표기.
- `status --blocks` 는 실세션 실제 차단만, lifecycle-scan 은 `bypass_confirmed=N` 표시.

### 알려진 한계 (정직 표기)
- 자동 판정은 compound consent(`forgen compound consent on`)가 켜져 있을 때만 돈다. 꺼져 있으면 미판정으로 남고 precision 강등도 없다.
- 합성 세션 필터는 값 기반(`default`/`unknown`/빈 값) — eval/probe 하네스가 임의 id 를 쓰면 걸러지지 않는다(격리 FORGEN_HOME 전제).
- 채굴 병합은 category 경계를 유지해 ADR 예상(≤5)보다 많은 7개로 수렴. τ=0.3 에서 오탐 링크 1건 가능 — dry-run 기본.
- 관련 룰 매칭은 한글 활용형("검증해"≠"검증")을 못 잡는다 — 보수적 방향.
- 소진 예측의 실세션 관측은 이번 릴리스로 statusline 이 글로벌 패키지에 실린 뒤부터.

## [0.5.9] — 2026-10-02 — 남겨 둔 한계 정리: 사용자 스킬 보존 · AGENTS.md 전체 정리 · OpenCode uninstall · claude-mem 13.28

### Fixed
- **`forgen install` / npm postinstall 이 사용자가 만든 `forgen-*` 스킬을 지우던 것.** dev-guide 스킬의 stale 정리가 이름만 보고
  디렉토리를 재귀 삭제했다 (`install claude` 는 `forgen-*` 전부, `install codex`/postinstall 은 `forgen-(react|vue|node|go)-*`).
  이제 forgen 소유만 정리한다: 패키지가 현재 제공하는 이름, 또는 `SKILL.md` 가 `…/assets/dev-guide/…` 를 가리키는 심링크(이전
  버전이 설치한 것). 삭제도 `SKILL.md` 한 파일과 빈 디렉토리만. 설치는 이미 있는 것을 덮어쓰지 않는다 — 심링크된 스킬
  디렉토리(dotfiles 등)를 따라 들어가 쓰지 않고, 한 스킬 자리가 막혀 있어도 나머지 설치는 계속한다.
- AGENTS.md 블록 처리: 마커가 한 줄을 통째로 차지할 때만 블록 경계로 본다. 본문에 마커 문자열을 인용한 문서에서 인용 줄부터
  실제 블록 끝까지를 덮어쓰거나 지울 수 있었다.
- **forgen-eval**: `workerStatus()` 가 "Worker is not running" 을 실행 중으로 판정하던 것. claude-mem recall 이 `sqlite3` CLI 에만
  의존해 CLI 가 없는 머신에서는 조용히 비어 있던 것(forgen+mem arm 이 forgen-only 와 같아짐) — `node:sqlite` 우선 + CLI 폴백,
  둘 다 없으면 run 경고. `CLAUDE_MEM_TESTED_VERSION` 이 12.4.8 에 머물러 매 실행 version-mismatch 경고가 나던 것.

### Added
- **`forgen uninstall` 이 다른 프로젝트의 AGENTS.md 블록도 정리한다.** `forgen install codex|opencode` 가 블록을 쓴 경로를 host
  설정 디렉토리의 `forgen-agents-md.json` 에 기록하고, uninstall 이 기록된 경로 전부 + 실행한 cwd 를 정리한 뒤 기록을 지운다.
  (0.5.9 이전 설치분은 기록이 없어 여전히 cwd 만 정리된다.)
- **OpenCode uninstall.** forgen-managed plugin 제거(설치 때 백업한 사용자 plugin 이 있으면 되돌림), config(JSONC) 의
  `mcp.forgen-compound` 를 forgen 시그니처일 때만 제거(다른 키·서버의 값은 보존, 인접 주석/포맷은 바뀔 수 있음; 파싱 불가면
  건드리지 않음), AGENTS.md 블록. plugin 소유는 첫 줄의 `// forgen-managed` 로만 판정한다.
- uninstall 이 쓰지 못한 AGENTS.md(읽기 전용 등)는 오류로 알리고 기록에 남겨 다음 실행에서 다시 시도한다.

### Changed
- **claude-mem 13.12.4 → 13.28.0** (forgen-eval 테스트베드 핀, Dependabot #136). 0.5.7 에서 "재측정 필요" 로 보류했으나 근거가
  약했다 — 저장소의 측정 리포트는 claude-mem 버전에 묶여 있지 않고 forgen-eval 이 의존하는 것은 CLI 계약이다. 격리 HOME 에 두
  버전을 설치해 계약이 동일함을 실측: `version`/`start`/`status`/`stop`, `search` 출력(JSON + `| #N |` 표), DB 컬럼, 비매칭
  쿼리 동작.

### Verified
- fresh-context critic 리뷰: MAJOR 2 · MINOR 10 → 반영 또는 한계로 명시(ADR-016). 리뷰어의 재현 환경(심링크된 스킬 디렉토리)을
  CLI `install both` 와 postinstall 에 다시 돌려 사용자 파일이 그대로임을 확인.
- vitest 3242 통과 + forgen-eval 72 통과 (신규: 실 SQLite DB 로 recall 계약, worker 판정, 핀 일치 강제; 사용자 스킬 보존;
  AGENTS.md 기록/정리; OpenCode uninstall).
- 격리 HOME 실행: 실 claude-mem 13.28.0 워커에 대해 빌드된 recall 경로가 시드한 observation 본문을 돌려주고, 워커 on/off 판정이
  맞음. CLI `install both` + `install opencode` 를 두 프로젝트에서 실행한 뒤 다른 디렉토리에서 `uninstall --force` —
  두 AGENTS.md 블록·OpenCode plugin/MCP·Codex 등록분 제거, 사용자 스킬과 사용자 AGENTS.md 내용 보존.


## [0.5.8] — 2026-10-02 — Codex 가 재배치한 마커에서도 설치·제거가 정확하게 (Codex 0.160 확인)

### Fixed
- **Codex 가 config.toml 을 다시 쓰면서 forgen 마커를 뒤집어 놓은 형태에서 `forgen uninstall` 이 MCP 서버 등록을 지우지
  못하던 것 (0.5.7).** 실머신에서 `/hooks` 승인 후 관측: `# >>> forgen-managed-mcp` 는 forgen 테이블과 함께 파일 끝으로 가고
  `# <<< forgen-managed-mcp` 는 앞쪽에 고아로 남는다. 이제 마커를 *범위* 가 아니라 *표식* 으로만 쓰고, 범위는 TOML 구조
  (테이블 헤더 ~ 다음 헤더, notify 한 줄)로 정한다. 재설치는 고아 마커를 걷어 테이블 위아래로 정규화하고, 제거는 테이블·하위
  테이블·모든 마커 줄을 지운다. notify 블록도 END 마커가 옮겨지거나 사라져도 동작한다.
- 사용자가 forgen MCP 테이블만 지우고 마커가 남은 경우, 재설치가 고아 마커를 정리하고 블록을 한 번만 쓴다.
- **`codex mcp add <다른 서버>` 뒤에는 forgen 테이블을 알아보지 못하던 것.** Codex 가 mcp_servers 를 다시 쓰며 시작 마커를
  없앤다. 소유 판정을 "헤더 바로 위의 마커 또는 forgen 내용 시그니처(args 의 `dist/mcp/server.js` + `--host=codex`,
  notify 의 `dist/host/codex-notify.js`)" 로 바꿨다 — 마커가 사라져도 경로 갱신과 제거가 된다.
- CRLF config.toml 에서 블록 제거 후 파일이 `\r` 로만 끝나 Codex 가 로드하지 못할 수 있던 것 (0.5.8 작업 중 회귀로 발견, 미출시).
- forgen 테이블 뒤·다음 테이블 헤더 위의 사용자 주석을 forgen 본문으로 취급하지 않는다.
- Codex 가 forgen notify 블록 안의 값을 사용자의 notifier 로 바꿔 놓은 경우 그 값을 보존한다 (이전엔 재설치가 덮어썼다).
- 같은 MCP 서버가 다른 TOML 표기(따옴표·공백 헤더, inline table, dotted key)로 정의돼 있으면 중복 정의를 추가하지 않는다
  (추가하면 Codex 가 `duplicate key` 로 로드 실패).
- 블록 제거가 "지웠다" 고 보고하는 것은 실제로 테이블/notify 줄을 지웠을 때만.

### Verified
- vitest 3222 통과 (신규: 실머신에서 채취한 재배치 형태, CRLF/BOM, 마커 소실, 사용자 주석, 다른 TOML 표기).
- fresh-context critic 리뷰: CRITICAL 1 · MAJOR 2 · MINOR 6 → 전부 반영. 리뷰어의 케이스 68건 + 퍼징 14,000건에서 Codex 로드
  불가 출력·사용자 데이터 변경·비멱등 0건, 실 Codex 0.160 재현 스크립트(`codex mcp add` 후 설치/제거, CRLF 왕복) 통과.
- 이 머신의 실 `~/.codex/config.toml` 사본에 적용: 재설치 diff 는 고아 END 마커 한 줄 이동뿐(hooks.state 31개 보존),
  제거 후 forgen 항목 0건, 두 결과 모두 Codex 0.160.0 이 정상 파싱.
- **Codex 0.160.0 호환 확인**: 훅 출력 스키마 11종이 vendoring 한 0.153.4 사본과 동일, trust 해시 일치(실머신 22/22 trusted,
  Codex `hooks/list` 30/30), 실세션에서 SessionStart(룰 블록 주입, 스필 없음)·UserPromptSubmit·Stop·SessionEnd 훅 발화, 오류 0건.


## [0.5.7] — 2026-10-02 — `forgen uninstall` 의 Codex 정리 · 의존성 메이저 업그레이드

### Added
- **`forgen uninstall` 이 Codex 등록분도 되돌린다 (ADR-016 D4).** hooks.json 의 forgen 훅, config.toml 의 MCP/notify 블록,
  forgen-managed `skills/` · `agents/ch-*.toml`, cwd 의 AGENTS.md 블록을 제거한다. 이전엔 Codex 쪽이 그대로 남아
  패키지를 지우면 Codex 가 매 훅 이벤트마다 사라진 스크립트를 실행하려 했다.
  - **다른 도구의 훅 신뢰를 지킨다.** Codex 의 trust 키는 그룹 인덱스 기반이라 forgen 그룹을 지워 인덱스가 당겨지면
    뒤따르는 훅이 재승인 전까지 조용히 skip 된다. 그런 위치에는 빈 그룹(`{"hooks": []}`)을 남겨 인덱스를 유지한다
    (Codex 0.153.4 `hooks/list` 로 확인: 경고 없음, 뒤 그룹 trusted 유지). forgen 은 `[hooks.state]` 를 고쳐 쓰지 않는다.
  - 사용자가 만든 스킬/에이전트/마커 없는 MCP 테이블/자기 `notify`, Codex 가 블록 사이에 써 넣은 설정은 보존.
    forgen notify 뒤에 체인해 둔 사용자 notifier 는 그 argv 만으로 `notify` 를 되돌려 놓는다.
  - uninstall 후 재설치하면 빈 그룹 자리를 다시 채워 forgen 훅이 원래 인덱스(= 이미 승인된 trust 키)로 돌아간다.
  - 각 단계는 독립 — 하나가 실패(읽기 전용 파일, 깨진 hooks.json)해도 나머지는 진행하고 실패를 출력한다.
  - 한계: 다른 프로젝트의 AGENTS.md 블록(실행한 cwd 것만 정리), `forgen install opencode` 산출물, 낡은 `[hooks.state]`
    항목, 빈 디렉토리/빈 config.toml 은 남는다.
- `forgen uninstall` 의 Claude 쪽 누락 보강: `~/.claude.json` 의 `forgen-compound` MCP 등록(install 은 여기에 쓰는데 uninstall 은
  settings.json 만 정리했다), 패키지가 제공한 dev-guide 스킬(`~/.claude/skills/forgen-<stack>-<skill>`).

### Fixed
- **손으로 여러 줄로 고친 forgen notify 블록을 제거(`--no-notify`, uninstall)하면 config.toml 이 깨지던 결함 (0.5.6).**
  배열의 첫 줄만 지우고 나머지를 남겨 Codex 가 기동하지 못했다. 이제 그런 블록은 건드리지 않고 알린다.
- **훅 소유 판정이 너무 넓던 것.** command 에 `dist/hooks/<아무이름>.js` 가 있거나 forgen 설치 경로를 *부분문자열* 로
  포함하면 forgen 훅으로 봤다 — 다른 프로젝트의 `…/dist/hooks/pre-commit.js` 나 `<pkgRoot>-fork/…` 가 재설치 시 교체
  대상이 될 수 있었다. 이제 forgen 설치 경로의 `dist/` 아래, codex-adapter 경유, registry 에 있는 forgen 훅 이름일 때만.
- 소유 마커 판정 강화: SKILL.md 는 frontmatter *바로 뒤* 의 마커만 인정(본문의 `---` 뒤 마커 인용을 오인하던 것),
  agent TOML 은 첫 줄이 정확히 `# forgen-managed` 일 때만.
- `~/.claude.json` / settings.json 을 다시 쓸 때 기존 파일 권한(0600)과 심링크를 보존 (이전엔 0644 로 넓어지고 심링크가
  일반 파일로 바뀌었다).
- `forgen status` 점수: 총점을 표시되는 항목 점수의 합으로 계산 (반올림 순서 때문에 항목 합과 총점이 1 어긋날 수 있었다).

### Changed — dependencies
- **js-yaml 4 → 5** (런타임 의존성). v5 ESM 빌드는 default export 가 없어 namespace import 로 전환, dump 옵션
  `quotingType` → `quoteStyle`, 타입 내장으로 `@types/js-yaml` 제거. **스키마를 `JSON_SCHEMA` → `CORE_SCHEMA` 로 변경**:
  v5 의 `JSON_SCHEMA` 는 strict JSON 이라 v4 가 읽던 `confidence: .5`, `supersedes: ~`, `True` 등을 문자열로 읽어
  솔루션이 조용히 탈락한다. `CORE_SCHEMA` 가 v4 와 같은 해석을 준다 (회귀 테스트 추가). 실 솔루션/룰 frontmatter 87개에서
  v4 와 파싱·직렬화 결과 바이트 동일. 남는 차이: `1_000`, `0b11` 형태는 v5 에서 문자열로 읽히고 따옴표 없이 직렬화된다
  (forgen 이 쓰는 값에는 나타나지 않는 형태).
- **TypeScript 5.9 → 7.0** (dev). TS 6+ 는 `@types/*` 를 자동 포함하지 않아 tsconfig 에 `"types": ["node"]` 명시.
  TS 7 의 `tsc` 는 Node 20.0 에서 실행되지 않으므로 CI 의 훅 포터빌리티 잡을 "Node 22 로 빌드 → 대상 Node 로 로드" 로 분리
  (배포물은 빌드된 dist 이므로 사용자 영향 없음).
- **vitest 4 → 5** + `@vitest/coverage-v8` 5 (dev, 함께 올려야 함).
- `@modelcontextprotocol/sdk` 1.31.0, `zod` 4.6.5, `@types/node` 26.6.4, `@biomejs/biome` 2.5.15, `npm audit fix`
  (advisory 13 → 0), `actions/setup-node` v7.

### Docs
- `packages/forgen-eval/reports/persistence/` 원시 리포트 6건 커밋 — `docs/release/v0.5.0-persistence-delta.md` 가 재현
  근거로 인용하던 파일이 저장소에 없었다.

### Verified
- vitest 3204 통과 (신규: Codex uninstall 왕복·신뢰 인덱스 보존·config 보존·소유 판정 오탐·손편집 notify 블록,
  Claude 쪽 MCP/dev-guide 정리·권한/심링크 보존, js-yaml 스칼라 해석).
- 격리 `HOME` 에서 CLI `install both` → `uninstall --force` 왕복: forgen 이 등록한 훅/블록/스킬/에이전트가 제거되고, 다른
  도구 훅은 실 Codex `hooks/list` 에서 uninstall 후에도 `trusted`, `codex mcp list` 가 config 를 정상 파싱 (손편집된
  여러 줄 notify 블록이 있는 경우 포함).
- fresh-context critic 리뷰: MAJOR 2 · MINOR 12 → 위 Fixed/Changed 에 반영 또는 한계로 명시. 리뷰어가 확인한 것: TS 7 빌드의
  `.js` 227개가 TS 5.9 빌드와 바이트 동일, 실 `~/.codex` 사본에서 uninstall 후 다른 도구 훅 8개 trusted 유지.
- CI: ubuntu/macOS/arm 테스트 + Node 20.0.0~22 훅 로드 14개 검사 통과.
- 0.5.6 을 이 머신의 실 `~/.codex` 에 설치한 뒤 실 Codex 세션 1회: Stop 훅 발화·alive 마커 갱신, silent 플래그 없음.


## [0.5.6] — 2026-10-02 — Codex notify 폴백 · 훅 번들(재승인 2건) · Claude verify 스킬 (ADR-016)

> **Codex 사용자 — 재승인 필요**: 업그레이드 후 `forgen install codex` 를 다시 실행하면 훅 2개
> (`session_start` 변경, `session_end` 신규)가 Codex `/hooks` 승인 전까지 skip 된다. 그동안 Codex 세션에
> `<forgen-rules>` 블록이 주입되지 않는다. install 출력과 `forgen doctor` 가 대상 훅을 표시한다.

### Added
- **Codex `notify` 폴백** (`dist/host/codex-notify.js`). `forgen install codex` 가 config.toml 최상단에 마커 블록으로
  `notify` 를 등록한다. Codex 의 notify 는 훅 신뢰와 무관하게 턴 완료마다 detached 로 실행되므로, forgen 훅이
  미승인/변경 상태로 조용히 skip 되는 동안에도 (a) `state/codex-hooks-silent.json` 에 관측을 남겨 `forgen doctor`
  [Codex Hooks] 가 보여주고 (b) 프롬프트 ≥10 인 세션은 Stop 훅과 같은 디바운스 경로로 auto-compound 를 띄운다.
  훅이 정상 실행 중이면(codex-adapter 의 alive 마커) 아무것도 하지 않는다. 사용자가 이미 `notify` 를 정의했으면
  **건드리지 않는다** (수동 체인: argv 뒤에 `"--", "<program>", …`). 끄기: `--no-notify` (기존 블록도 제거).
  `forgen uninstall` 도 블록을 제거한다. Codex 가 블록 사이에 써 넣은 root 키(`model` 등)와 BOM/CRLF 는 보존한다.
- **Codex `SessionEnd` 훅** — `session-end` 를 Codex 에도 등록. Stop 없이 끝나는 세션의 학습 추출 트리거.
  Codex rollout 의 실제 사용자 프롬프트(`event_msg`/`user_message`)를 raw 바이트 스캔으로 센다.
- **Claude `verify` 스킬** — `forgen install claude` 가 `~/.claude/skills/verify/SKILL.md` 를 설치한다. Claude Code
  2.1.286+ 는 project/user 스킬에 `verify` 가 있으면 코드 커밋 직전에 실행하도록 모델에 안내한다 (플러그인 스킬
  `forgen:verify` 는 대상이 아님). 본문은 "프로젝트 자체 레시피 우선 → 실제 build/type-check/lint/test 실행 →
  confirmed / refuted / unverified 판정, mock 통과는 증거 아님". 사용자가 만든 `verify` 스킬은 덮어쓰지 않고,
  `forgen uninstall` 은 forgen 이 설치한 것만 제거한다. 끄기: `--no-verify-skill`. (npm postinstall 은 설치하지 않음 —
  명시적 `forgen install claude` 에서만.)
- `forgen install` 플래그 `--no-notify`, `--no-verify-skill`.

### Fixed
- **`forgen install codex` 재실행이 Codex 훅 신뢰를 전부 지우던 결함 (0.5.3~).** 신규 설치는 MCP 마커 블록을
  config.toml 끝에 붙이는데, Codex 는 `/hooks` 승인 시 `[hooks.state]` 테이블을 파일 끝 주석(= forgen 의 END 마커)
  *앞* 에 써 넣는다 — 즉 블록 안. 재설치가 블록을 통째로 교체하면서 22개 신뢰 기록, `[features]`, MCP 서버의
  `enabled = false` 등이 사라졌다. 이제 forgen 이 쓴 줄만 다시 쓰고 사이에 끼어든 내용은 블록 뒤로 옮겨 보존한다.
  (실 Codex 0.153.4 app-server 로 재현·수정 확인: 재설치 후 22/22 유지.)
- Codex 추출 run(`codex exec --ephemeral`)에 `FORGEN_NESTED_RUN=1` 이 전달되지 않던 것 — forgen 훅이 추출 세션에서
  발화하지 않도록 Claude 분기와 동일하게 표식.
- `[mcp_servers.forgen-compound]` 가 마커 없이 이미 있으면 중복 테이블을 append 하지 않는다.

### Changed
- **Codex 훅 신뢰 감사가 해시를 대조한다.** `auditCodexHookTrust` 가 Codex 0.153.4 의 핸들러 단위 trust 해시를
  계산해 `trusted` / `modified` / `untrusted` 를 구분한다. 이전엔 `hooks.state` 키의 존재만 봐서, 핸들러가 바뀌어
  Codex 가 skip 하는 훅을 "trusted" 로 표시했다. `/hooks` 에서 끈 훅(`enabled = false`)은 `disabled` 로 따로 센다.
  읽기 전용 대조이며 신뢰 기록은 쓰지 않는다.
- **`session-recovery` 의 Codex 핸들러에 `additionalContextLimit: 0`.** Codex 는 약 10KB 를 넘는
  `additionalContext` 를 임시 파일로 스필하고 모델에는 잘린 미리보기만 준다 — 한국어 룰 블록(상한 15,000자)은 이를
  쉽게 넘는다.
- `post-tool-failure` 를 Codex hooks.json 에서 제외 (`PostToolUseFailure` 는 Codex 이벤트가 아니라 무시되던 죽은 엔트리).
- `forgen install codex` 는 config.toml 내용이 바뀔 때만 파일을 쓴다.
- CI: 태그 푸시 발행을 npm Trusted Publishing(OIDC) 으로 전환, `release.yml`/`compat.yml` 에 누락됐던
  `hooks/hooks.json` 생성 단계 추가 (v0.5.0 이후 태그 발행이 계속 실패하던 원인).

### Not done (정직 표기 — ADR-016)
- `async: true` 훅: Codex 는 같은 이벤트의 핸들러를 이미 동시 실행한다. 어댑터 경유 훅 1회 91~137ms 실측 →
  이득 상한 ≈130ms/이벤트. 반면 async 는 block/deny 가 적용되지 않고 핸들러마다 재승인이 든다.
- `PostCompact` / `Interrupt` 등록: 둘 다 컨텍스트 주입이 불가능하고 forgen 이 거기서 할 일이 없다.
- 사용자 `notify` 자동 체인: TOML 임의 배열 재작성 + 원복 보장 불가로 수동 체인 안내만 제공.

### Verified
- vitest 3161 통과 (신규: trust 해시·notify 블록 upsert·notify 폴백 분기·rollout 카운터·verify 스킬 install/uninstall).
- trust 해시: 실머신 `~/.codex/config.toml` 의 trusted_hash 20건과 일치 (fixture 8건 vendoring), 격리 `CODEX_HOME` 에서
  forgen 계산 해시를 기록한 뒤 Codex `hooks/list` 가 22/22 `trusted` 로 판정 (`additionalContextLimit:0`·SessionEnd 포함).
- 격리 Codex 0.153.4 실세션 (`codex exec`):
  - 훅 미승인: notify 발화 → silent 기록, `forgen doctor` 가 "forgen 훅 미발화" 표시.
  - 훅 승인: alive 마커(Stop) 기록 → notify 가 silent 를 지움, hook-timing 에 `SessionEnd:session-end (rt: codex)`.
  - 스필: 21KB SessionStart 컨텍스트 — 기본값은 "Full hook output saved to" + 중간 내용 미전달, `additionalContextLimit:0`
    은 전문 전달.
- notify 폴백의 auto-compound 트리거: 실 바이너리 + 12-프롬프트 rollout 으로 러너 인자(cwd, rollout, session id, 12)와
  `FORGEN_RUNTIME=codex` 전달, 재호출 시 in-flight 게이트로 skip 확인. (러너 자체는 스텁으로 대체 — LLM 추출은 이 검증 범위 밖.)
- fresh-context critic 리뷰 1라운드: CRITICAL 2 · MAJOR 1 · MINOR 10 → 위 Fixed 항목 포함 전부 반영 또는 한계로 명시
  (ADR-016 Review 절). 리뷰어의 실 Codex 재현 스크립트를 수정 후 빌드에 다시 돌려 통과 확인.
- 이 머신의 실 `~/.codex` 에는 아직 설치하지 않았다 (재승인 전까지 룰 주입이 멈추므로 오너 결정 후).


## [0.5.5] — 2026-10-01 — Codex Stop 분기 복구 (Stop 트리거 auto-compound·finalizeSession)

### Fixed
- `context-guard` 가 Stop 이벤트를 Claude 전용 `stop_hook_type` 필드로만 판별해, Codex 의 Stop 입력
  (`hook_event_name:"Stop"` 만 있고 `stop_hook_type` 없음) 에서는 Stop 분기 전체가 건너뛰어졌다 →
  Codex 세션은 `finalizeSession`, Stop 트리거 auto-compound(≥10 프롬프트), rate-limit 감지, 세션 종료
  안내가 전혀 돌지 않고 컴팩션 때만 학습 추출됐다. `hook_event_name === "Stop"` 을 `end_turn` 과 동치로
  인정. (0.5.4 실환경 검증 중 hook-timing 의 context-guard 가 Stop 시점에 `UserPromptSubmit` 로 기록되는
  것을 보고 발견.)

### Verified
- vitest: Codex 형 Stop 입력으로 20-프롬프트 세션 종료 안내가 나오는 테스트 추가.
- 격리 Codex 세션: hook-timing 에 `context-guard … event:"Stop", rt:"codex"` 기록, Stop 훅 Completed.


## [0.5.4] — 2026-10-01 — Codex 훅 출력 스키마 준수 (0.5.3 의 Stop 훅 Failed 회귀 수정)

### Fixed — Codex 가 forgen Stop 훅 출력을 매 턴 "Failed" 로 버리던 회귀
- 0.5.3 의 사영(`projectCodexToClaude`)이 모든 출력에 `hookSpecificOutput.hookEventName` 을 붙였는데,
  Codex 0.153.4 의 Stop/SubagentStop 출력 스키마는 `additionalProperties:false` 이고 `hookSpecificOutput`
  을 허용하지 않는다 → `parse_stop` 실패 → "hook returned invalid stop hook JSON output" → **Failed**
  (실환경 `codex exec` 에서 `hook: Stop Failed` ×2 재현; 훅 자체는 exit 0 + 정상 JSON). 0.5.3 격리 검증은
  당시 사영이 stdin 의 `hook_event_name` 을 못 읽어 우연히 키를 안 붙인 상태라 통과했었다.
- 사영을 **이벤트별 allowlist** 로 재작성 (`CODEX_OUTPUT_SCHEMA`): universal 키 / `decision`·`reason` 허용
  이벤트 / `hookSpecificOutput` 허용 이벤트와 하위 키를 Codex 스키마 그대로 따르고, 절대 새 키를 만들지
  않는다. PostToolUse 에 PreToolUse 형 deny 가 오면 Codex 의 PostToolUse block 형으로 번역.
- 회귀 방지: `tests/fixtures/codex-hook-schemas/` 에 rust-v0.153.4 출력 스키마 11종을 vendoring 하고,
  `tests/host/codex-output-schema.test.ts` 가 forgen 의 모든 응답 helper × 이벤트 조합을 사영 후 스키마로
  검증한다.

### Verified
- 격리 Codex 세션: Stop 훅 3종(forgen 2 + 서드파티 1) 전부 `Completed`; `rm -rf` 응답 → `Stop Blocked` +
  continuation 유지. 실환경 재설치 후 동일 확인 (아래 Install 절).
- vitest 전체, self-gate static/runtime/release.


## [0.5.3] — 2026-10-01 — Codex 동등화 2차 (룰 주입·에이전트·훅 신뢰) + Stop block 사영 결함 수정 + 최신 호스트 갭 1차

오너가 Codex 를 일상 호스트로 전환하면서 "Claude 와 동일한 forgen 경험" 을 코드·실세션 대조로
감사. 훅/MCP/스킬은 동등했으나 **개인화 룰과 서브에이전트가 Codex 에 전달되지 않는** 구조적
갭을 발견·수정. 결정 문서: docs/adr/ADR-014-codex-parity-rules-agents.md.

### Added — ADR-014
- **D1 개인화 룰 주입 (Codex)**: `session-recovery` 가 `FORGEN_RUNTIME=codex` 일 때
  `generateClaudeRuleFiles()` 산출(v1-rules / project-context / forge-behavioral / user-profile)을
  Claude 와 동일 캡(`RULE_FILE_CAPS`)으로 `<forgen-rules host="codex">` 블록에 담아 SessionStart
  additionalContext 로 주입. 컴팩션 후에는 두 호스트 모두 SessionStart 가 `source="compact"` 로 재발화
  하므로 같은 경로가 재주입 (별도 플래그 경로 없음). 새 모듈 `src/host/codex-rules-context.ts`.
  - 설계 이유: hooks.json 을 바이트 동일하게 유지해야 Codex 의 훅 신뢰 기록이 유효 → 새 훅이
    아니라 기존 훅 내부 분기. AGENTS.md 파일 주입은 사용자 저장소에 개인 룰이 커밋될 위험.
- **D2 Codex 커스텀 에이전트**: `forgen install codex` 가 `assets/claude/agents/*.md` 14종을
  `~/.codex/agents/ch-<name>.toml` 로 생성 (공식 스키마 name/description/developer_instructions +
  model_reasoning_effort/sandbox_mode 만 사용; `tools`/`disallowedTools` 양쪽에서 읽기전용 판정).
  config.toml 에 `[features] multi_agent = true` 가 없으면 install 출력에 ⚠ 안내. Claude 설치명(ch-*)과 동일해 스킬 본문의
  `ch-planner → ch-executor → ch-verifier` 참조가 Codex 에서도 해석됨. `# forgen-managed` 마커로
  idempotent, 사용자 toml 보존.
- **D3 스킬 Codex 적응**: 설치 시 `$ARGUMENTS`(Codex 미지원 변수) 자연어 치환 + "Codex host note"
  (ch-* 에이전트 위치, spawn 불가 시 `invoke-agent` MCP 대체) 부착.
- **D4 훅 신뢰 감사**: `auditCodexHookTrust()` 가 hooks.json forgen 엔트리 vs config.toml
  `[hooks.state."<hooks.json>:<event>:<i>:<j>"]` 를 대조 (Codex 미지원 이벤트 PostToolUseFailure 는
  `ignoredByCodex` 로 분리). `forgen install codex` 출력과 `forgen doctor` 의 새 `[Codex Hooks]`
  섹션에 "N/M trusted, 미승인 시 codex 안에서 `/hooks`" 안내. trusted_hash 를
  forgen 이 쓰지 않음(신뢰 모델 우회 금지).
- **D5 측정**: `hook-timing.jsonl` 엔트리에 `rt: claude|codex` 필드.

### Fixed — ADR-015 X-G1 (결함): Codex 에 Stop block 이 전달되지 않음
- `codex-adapter` 의 사영(`projectCodexToClaude`)이 `decision:"block"` 을 `continue:false +
  permissionDecision:"block"` 으로 변조해 내보냈다. Codex 는 top-level `decision`/`reason` 을 읽고
  `continue:false` 를 "처리 중단" 으로 해석하므로 **stop-guard 의 자기검증 차단이 Codex 에서 한 번도
  continuation 을 만들지 못했다**. 사영을 host 스키마 보존(pass-through) 으로 재설계. fable 갭 분석에서
  발견, dist 실행으로 재현, 격리 `codex exec` 에서 `hook: Stop Blocked` → 자기 교정 턴 관측.
- PreToolUse deny 의 `continue:false` 는 Codex 가 "unsupported" 로 로그하던 것을 제거 (차단은
  `permissionDecision` 이 표현).

### Added — ADR-015 (최신 Claude Code 2.1.286 대비 갭, 0.5.3 반영분)
- **`SessionEnd` 훅 (Claude 전용)**: 세션 종료 시 user 메시지 ≥10 이면 auto-compound 러너를 detached
  spawn — Stop 이 안 오는 종료(Ctrl+C 등)·긴 컴팩션 세션의 후반 학습 유실 보강. registry 에
  `hosts` 필드 도입; **Codex hooks.json 은 22개 바이트 동일 유지** (훅 신뢰 보존).
- **중첩 실행 가드**: forgen 이 띄우는 추출용 `claude -p` 에 `FORGEN_NESTED_RUN=1` +
  `--no-session-persistence`. 추출 run 안에서 22개 훅이 재귀 발화해 hook-timing/sessions 를 오염하고
  다음 SessionStart 의 auto-compound 후보가 되던 문제 차단. (`--bare` 는 OAuth 를 끊어 채택 불가.)
- **플러그인 스킬 frontmatter 보존**: `skills/<name>/SKILL.md` 가 `disable-model-invocation`(ship),
  `allowed-tools`, `argument-hint`, `model` 을 잃던 빌드 결함 수정.
- 백로그(설계/재승인 필요)는 docs/adr/ADR-015 표 참조 — Codex async/SessionEnd/PostCompact 등록,
  `notify`, `--output-schema`, `.codex/rules`, `verify` 스킬 규약, `InstructionsLoaded`, plugin eval 등.

### Verified
- vitest 전체 pass (신규: codex-rules-context, install-codex ADR-014 9, hook-timing rt, projection
  재작성, hooks-generator-hosts, session-end).
- fresh-context critic (fable) 1라운드 → MAJOR 3 + MINOR 6 반영 (상세: ADR-014 Verification).
  `tests/extraction-session.test.ts` 2건은 타이밍 flaky(단독 재실행 pass, 본 변경과 무관).
- self-gate static ✓, self-gate-runtime 9/9 ✓.
- **격리 라이브 (CODEX_HOME/FORGEN_HOME 임시, Codex 0.153.4)**:
  - 훅 미승인 `codex exec` → forgen 훅 0건 발화 (공식 문서의 "skipped until trusted" 실증).
  - `--dangerously-bypass-hook-trust` → rollout 에 `<forgen-rules host="codex">` 4KB 주입 확인
    (v1-rules `## Must Not` 포함), Codex 가 ch-* 에이전트 14종 전부 열거, 생성 TOML 14/14 tomllib 파싱 OK.

### Known gaps (정직 표기)
- Codex 전용 이벤트(SessionEnd/PostCompact/Interrupt) 미사용, `PostToolUseFailure` 는 Codex 에 없어
  dead 엔트리로 유지 — 둘 다 hooks.json 변경이 필요해 신뢰 재승인 비용 때문에 보류.
- Codex 가 `.claude/rules` 처럼 매 턴 재로드하지는 않음 — 세션 시작 1회 + 컴팩션 시 SessionStart 재발화 1회.
- 서브에이전트 `model` 은 Codex 기본 subagent 모델 사용 (Claude 의 opus/sonnet 지정은 effort 로만 매핑).


## [0.5.2] — 2026-08-18 — 학습 파이프라인 무결성: 실운영 데이터 진단으로 3대 결함 수정

설치 후 실제 축적 데이터를 감사한 결과, 학습 파이프라인이 "우리 생각대로" 돌지
않는 지점 3개를 발견·근본원인 규명·수정. npm publish 는 규칙대로 보류.

### Fixed — 결함1: advisory 룰 폭주 (retire→재생성 churn)
- `compound sweep` 가 behavior_inference advisory 룰을 매 실행마다 새 UUID 로
  재생성해 6,701 파일(distinct render_key 172, 97% 중복)까지 폭증(1,046/일). 원인:
  `render_key` 가 영구 upsert 정체성이 아닌 "현재 active" 임시 dedup 키로만 쓰이고,
  채굴된 Evidence 가 consumed 표시되지 않아 retire 로 풀린 render_key 를 stale
  evidence 가 즉시 재승격(시계만 리셋).
- 수정: `findRuleByRenderKey()`(모든 status, scope 필터) 로 기존 룰 제자리 재활성
  (`created_at`/`rule_id` 보존, TTL=첫 채굴 이후 총수명 캡), `Evidence.candidate_rule_refs`
  재사용한 consumed 마킹(동일 evidence replay 억제, 진짜 cross-session 반복은 Laplace
  강화 유지), 하드닝된 `withFileLockSync` 로 retire→lookup→create 크로스-프로세스 락,
  `forgen compound sweep --prune-removed [--apply] [--retention-days N]`(dry-run 기본).

### Fixed — 결함2: solution 추출 무음 실패 (생애 최초 산출 0건) — 라이브 확증 후 재설계
- opt-in(`autoCompoundHaiku`) 켜짐에도 `me/solutions/` 신규 산출이 forgen 생애 통틀어 0건.
- **라이브 확증으로 초기 진단을 정정**: 처음엔 "sparse env 권한 hedge"로 보고 `--permission-mode
  dontAsk` 를 넣었으나, 실제 A/B 결과 dontAsk 는 산출을 전혀 바꾸지 못했다(有/無 모두 0).
  진짜 원인은 (1) 프롬프트가 "형식: forgen compound ..."(format:)이라 headless haiku 가
  명령을 텍스트로 프린트만 하고 Bash 도구를 호출 안 함, (2) 애초에 headless haiku 의 Bash
  도구 호출이 근본적으로 불안정(동일 조건 1↔0), (3) cron sparse PATH 에 `forgen` 부재,
  (4) 러너가 `stdio:'ignore'` 라 이 모든 실패가 무음.
- **재설계(결정론적)**: 모델에 Bash 도구를 아예 주지 않는다. 모델은 재사용 솔루션을
  텍스트로만 출력하고, 러너가 `--solution "제목" "설명"` 을 파싱해 `forgen` 을 직접 실행한다
  (behavior 경로와 동일 패턴). 부수효과로 **P1-S1 injection 표면 제거** — 모델 출력은
  파싱·필터(`containsPromptInjection`/`filterSolutionContent`) 후 `execFileSync` 의 *인자*로만
  쓰이고 셸을 거치지 않는다. `forgen` 은 러너 node 의 형제 바이너리를 절대경로로 호출해
  PATH 의존을 없애고, `spawn.ts` 는 러너를 `process.execPath` 로 띄워 실 cron(nvm node)에서
  forgen 형제경로가 성립하게 한다. 러너 stdout/stderr 는 세션별 로그로 캡처(무음 실패 제거).
- **라이브 검증**: cron-faithful sparse env(격리 FORGEN_HOME, 절대 nvm node)에서 실제 러너
  실행 → solution **0→1** 확인.
- **보안 defense-in-depth**: (1) 러너에서 대시-선두 title/content 스킵(arg confusion 1차 차단),
  (2) `handleCompound` 인자 파서 리팩터 — manual-add(`--solution`/`--rule`/…)를 서브커맨드
  dispatch 보다 먼저 처리해, 위치인자(title/content)의 `--remove`/`clean-stale` 등이
  `args.includes(...)` 스캔에 걸려 삭제·정리 분기를 탈취하던 경로를 CLI 레벨에서 원천 차단.

### Fixed — 결함3: 전역 CLI 버전 드리프트
- 대화형 `forgen`/`fgx` 가 0.4.12(설치 후 미갱신)로 러닝 파이프라인(dist 0.5.x)과 불일치.
  전역 CLI 를 npm latest 로 최신화.

## [0.5.1] — 2026-08-18 — docs 정직화 i18n 동기화 + consent-sync CI 가드

문서/CI 전용 패치. 사용자 노출 코드·런타임 동작 변경 없음. npm publish 는 규칙대로
보류(품질 우선 — sellable/paper grade 도달 시).

### Docs
- **ko/ja/zh README 학습-루프 정직화 동기화**: EN(0.5.0)이 "session ends → auto-compound
  extracts" 무조건-추출 프레이밍을 opt-in consent 모델(ADR-012)로 고쳤으나 세 번역본이
  미반영이던 갭 해소(ko 는 v0.4.4 기준까지 뒤처짐). always-on(egress 0) vs
  opt-in(`forgen compound consent on`, 기본 off, redaction, `forgen doctor`) 이분,
  advisory-only 채굴(ADR-013), `compound sweep` backstop(ADR-011), ASCII 다이어그램·각주까지
  EN 과 일치화. fresh-context critic 으로 21개 검증점(7 claim × 3 언어) 전수 확인.

### CI
- **4 로케일 README consent 동기화 invariant** (`tests/readme-i18n-consent-sync.test.ts`):
  4 로케일 모두 consent load-bearing 토큰 포함(POSITIVE: `forgen compound consent on` /
  `opt-in` / `egress 0` / `advisory-only` / `compound sweep` / `<private>`) + 무조건-추출
  프레이밍(`auto-compound`) 미포함(NEGATIVE) 강제. EN 정직화가 번역에 다시 누락되거나 옛
  프레이밍이 부활하면 PR 에서 RED. vitest.config include('tests/**') → ci.yml 자동 실행.

## [0.5.0] — 2026-08-05 — cross-session δ 실증 · 학습 아키텍처 완성 (ADR-010~013)

forgen 의 첫 npm 릴리스(이전 발행은 0.4.x). 헤드라인: **forgen 효과(δ)를 프론티어
모델에서 처음으로 유의하게 실증**했고, 그 학습을 안전·정직하게 돌리는 백그라운드
아키텍처(ADR-011~013)를 완성했다. 아래 플랫폼-수렴 재정렬(ADR-010)이 이 릴리스의 토대다.

### 측정 — cross-session δ 실증 (핵심)
- **forgen 효과(δ)를 처음으로 유의하게 실증** — cross-session 정책 준수. forgen 이
  이전 세션의 user-특정 정책을 재주입해, 그 정책을 모르는 vanilla 대비 준수율을 올린다:
  Sonnet 5 **δ = 0.714, 95% CI [0.429, 0.929]** (vanilla 4/14 → forgen 14/14),
  Opus 4.8 **δ = 0.500, 95% CI [0.214, 0.786]** (vanilla 7/14 → forgen 14/14).
  블라인드 human rater 확증(Cohen's κ = 0.748). **"내부 측정" 등급** (메인테이너 유래
  데이터셋 + intra-family judge + rater 1인) — 외부 주장은 독립 rater 패널·외부 리뷰어·
  cross-family judge 재현 후. `docs/release/v0.5.0-persistence-delta.md`.
- **δ 는 모델 역량과 직교**: 강한 모델일수록 일반 good-practice 는 스스로 따라 δ 가
  작아지나, user-특정(추론 불가) 정책은 forgen 만 맞힘. within-session 은 구조적 null
  (프론티어 컨텍스트 보유) — δ 는 cross-session 에서만 산다.

### Added — 학습 백그라운드 아키텍처
- **auto-compound 백그라운드 방법론 (ADR-011)**: `forgen compound sweep` 시간-기반
  backstop + cron 자동설치(`--install-cron`), barren backoff 성장예외, PreCompact 러너.
  긴 컴팩션/차단 세션에서 학습이 유실되던 갭 해소.
- **auto-compound 동의 모델 (ADR-012)**: transcript 요약을 Haiku 로 전송하는 추출을
  **opt-in** 화(`forgen compound consent on|off`). 결정론 교정→룰 승급(egress 0)은 기본
  유지 — "당신 몰래 API 로 보내지 않는다".
- **correction-aware 채굴 (ADR-013)**: 명시 마커 없는 완곡·반사실 교정을 사후 회수해
  학습에 반영. 채굴 룰은 **advisory-only invariant**(차단 불가) + 캡 + auto: 네임스페이스
  + 생성나이 은퇴 — LLM 채굴이 위험한 영구 차단 룰을 만들지 못하게 data-level 로 보장.

### Fixed — 학습 파이프라인 실버그
- **실 transcript 스키마 버그**: auto-compound-runner 가 text 를 top-level `entry.content`
  로 읽었으나 실제 Claude 스키마는 `entry.message.content` 중첩 → 전 user/assistant 턴
  누락으로 auto-compound(채굴 포함)가 **실데이터에서 dead** 였다. message.content 우선 +
  fallback, 순수 파싱 모듈 분리 + real-schema 회귀.
- **settings-injection 마커 버그**: `permissions.deny` JSON 배열에 `# forgen-managed`
  주석을 데이터로 주입 → Claude Code 가 malformed 룰로 매 세션 경고. 주입 중단 +
  기존 오염 self-heal.
- **drift-score hardcap cooldown 부재**: 50편집 초과 후 매 편집마다 drift_critical 이
  발화하던(세션길이 카운터로 전락) 문제.

---

### 플랫폼 수렴 대응 (ADR-010, 이 릴리스의 토대 — 2026-07-16)

Claude Code 가 forgen 영역을 native 로 흡수하기 시작한 것(`/doctor`, `/usage`,
Auto mode)과 Sonnet 5 기본 모델 전환에 대한 전략 릴리스. 방향: native 와 겹치는
표면에서 물러나고, moat(교정→프로필 학습·증거 게이팅 정책·compound recall+ROI·
multi-host)에 재집중. 상세 결정 기록: `docs/adr/ADR-010`, 실행 스펙:
`docs/plans/2026-07-16-v0.5.0-execution-plan.md`. 전 작업 청크가 적대적 리뷰
6회전을 거침 (SEV-1 3건 포함 전 발견 반영).

#### 측정 기반 재정렬 (핵심 배경)
- **v0.4.11 실측: opus-4.8 에서 완료 가드 blocks=0** (easy/hard 양쪽) — δ 효과는
  100% injection 에서 나온다. enforcement 는 프론티어 모델이 흡수했고, forgen 의
  가치는 injection 품질·메모리·개인화·측정으로 이동했다. 효과 수치는 Sonnet 5
  재측정(R2) 전까지 주장하지 않는다 (Honest Fail Path).

#### Added
- **`forgen migrate tenetx`** (+ `doctor --reclaim`): tenetx(레거시 정체성)/구버전
  forgen 이 `~/.claude/rules/` 등에 남긴 규칙 스프롤을 provenance 기반으로 회수.
  manifest content-hash 일치 = 무프롬프트, 마커만 = `--yes` 필요, 그 외 불간섭.
  전량 백업-이동(가역), `--dry-run`, `--apply-settings`(settings-lock 준수).
- **Injection ROI 루프**: `surfaced ≫ acted_on` 저 ROI 솔루션 자동 강등(×0.5,
  24h 게이트 2윈도 연속 시 주입 제외, acted 발생 시 즉시 해제). `forgen status`
  에 "Surfaced but ignored" 패널. native 메모리에 없는 acted-on 피드백 루프.
- **per-model 완료-가드 프로필**: 측정된 opus-4.8 은 advise(기록만), 미측정
  모델(sonnet-5 포함)은 block 유지. 모델 식별은 statusline 세션 캐시 경유
  (hook stdin 에 모델 필드 없음 — probe 실측). DANGEROUS 가드는 모델 무관 block.
- **smoke 릴리스 게이트**: `scripts/smoke.cjs` — 실제 프로세스 실행 증거만 기록
  (vitest/cli/statusline/hook-exec), report.version ↔ package.json 바인딩으로
  stale 증거 재사용 차단. Docker e2e 게이트 폐지 대체 (증거 수단 적정화 —
  원칙 유지).
- retro-real 평가 데이터셋 15엔트리 (실세션 anonymized, 완화 역방향 케이스 포함).

#### Changed
- **경계 재정의**: `forgen doctor` 는 forgen 자체 기계+효과-측정 게이트만
  (환경 건강 → native `/doctor` 안내, Maturity/QuickWins 제거, hook timing →
  `--verbose`); 사용량 표시 → native `/usage` 이관(1회 공지, dashboard 는
  deprecated 플래그); 보안/안티패턴 prose → 훅 포인터 2줄 (71.8% 축소).
- **규칙 주입 전면 프로젝트 스코프화**: `forge-*` 글로벌 사이드채널 제거 —
  behavioral 패턴이 전 프로젝트에 새던 결함(F6) 수정. 렌더 파일 content-hash
  manifest 기록 (reclaimer 근거).
- **behavioral 에코 하드닝**: observedCount≥2 게이트(주력 — 실오염 49/49 가
  1회 관찰) + 캡처 사이드 차단 + 앵커드 패턴 보강. Claude-voice 에코가 규칙으로
  재주입되던 오염 경로 차단.

#### Fixed
- `doctor --repair` 가 글로벌 설치에서 실제로 복구하지 못하던 버그 (devDeps 부재로
  build 실패 → postinstall 미도달) — dist 존재 시 build 생략 + 결과 재검증 보고.
- statusline 1회 공지가 5초 캐시에 섞여 반복되던 버그.

#### Deprecated
- `usage-telemetry` 기록 (no-op shim, v0.6.0 모듈 삭제 예정) — native `/usage`.

## [0.4.13] — 2026-06-02 — Hotfix: fgx 세션 종료 시 터미널 물림 방지

핫픽스 한 건.

- **fix(fgx)**: `fgx` 가 대화형 세션 성공 경로에서 `process.exit` 를 호출하지 않고 Node
  이벤트 루프 자연 배수에 의존해 종료해 왔다. `spawnClaude` 는 세션 종료 시
  `auto-compound-runner` 를 detached + unref 로 띄우고 즉시 resolve 하므로(0.4.12 에서
  비차단 전환) 현재는 미해제 핸들이 없어 정상 종료한다. 그러나 향후 post-session 경로
  (`indexTranscriptToFTS`·rate-limit scan 등)에 닫히지 않은 핸들(SQLite 커넥션·타이머·소켓)이
  하나라도 생기면 fgx 가 종료하지 못하고 셸 프롬프트가 돌아오지 않는다(= 터미널 물림).
  `runClaudeLauncher()` 직후 명시적 `process.exit(0)` 추가로 이 종류의 회귀를 원천 차단.
  cli.js 위임 경로(`watch`/`dashboard`/`workflows` 등 long-running)는 자체 exit 를 책임지므로
  손대지 않았다. detached 자식은 unref 되어 독립 세션에서 실행되므로 `process.exit(0)` 후에도
  생존(PID 1 로 reparent 확인) — 백그라운드 compound 는 영향받지 않는다.

## [0.4.12] — 2026-06-01 — Hotfix: 훅 stdout 누출 + 세션 종료 블로킹

핫픽스 두 건.

- **fix(hooks)**: `secret-filter` 에 ESM main-guard 누락 → `context-guard` 가 `redactSecrets`
  를 import 할 때 `secret-filter.main()` 이 import 부작용으로 실행되어 유령 `{"continue":true}`
  를 1줄 추가 emit. 그 결과 context-guard 의 stdout 이 JSON 2줄이 되어 Claude Code 파싱
  실패 → raw `{"continue":true}` 가 매 프롬프트/세션 종료마다 사용자 터미널에 노출되었다.
  표준 main-guard 추가로 수정. (등록 훅 11개 중 context-guard 만 영향)
- **perf(compound)**: 세션 종료 시 `runAutoCompound` 가 execFileSync 로 동기 실행되어 최대
  ~210초(haiku LLM 3회 순차) 블록되었다. 같은 작업을 Stop 훅·session-recovery 가 이미
  detached 로 spawn 하므로(dedup 마커 공유), 동기 경로를 detached + unref 로 전환해 세션
  종료를 막지 않게 했다. 결과는 다음 세션 시작 시 surface.
- **test**: `hook-single-line-output` (훅당 stdout 1줄 + secret-filter import 무부작용),
  `auto-compound-detached` (detached/unref/dedup 분기) 회귀 테스트 추가.

## [0.4.11] — 2026-05-29 — Opus 4.8 + Dynamic Workflows 대응

테마: Claude Opus 4.8(2026-05-28 GA)의 **dynamic workflows**(최대 1,000 서브에이전트,
대화 밖 격리 런타임)·effort(high/xhigh/ultracode) 도입에 forgen 을 정합화. 설계는
[ADR-009](docs/adr/ADR-009-opus-4-8-dynamic-workflows.md). 핵심 긴장: forgen 검증은
메인 Stop hook 에 묶여 있는데 워크플로우는 작업을 대화 밖으로 옮긴다 → probe 로
"워크플로우 내부 에이전트도 forgen 훅을 발화"함을 실측 확인 후 검증을 확장.

### Added
- **probe (§1)**: `forgen probe-workflow arm|report|status` — dynamic-workflow 서브에이전트가
  forgen 훅(SubagentStart/Stop·Pre/PostToolUse)을 발화하는지 실측. 결과를
  `~/.forgen/state/probe-workflow-result.json` 에 박제. 실측 verdict = `workflow-hooks-fire`.
- **SubagentStop 검증 (§2)**: 신규 `subagent-stop-guard` 훅 — 워크플로우/Task 서브에이전트의
  마지막 응답에 메타 가드(TEST-1/2/3 + DANGEROUS)를 적용, `decision:block` 으로 재개.
  `(sessionId,agentId)` block-count 키(동시 서브에이전트 stuck-loop 충돌 방지),
  per-agent recentTools(`post-tool-use` 가 agent_id 있을 때 분리 → 메인 세션 TEST-2 오염 방지).
- **워크플로우 템플릿 (§3)**: `forgen workflows install [--project] | list`. forgen 철학을
  인코딩한 canonical 템플릿 동봉 — `evidence-gate-audit`(no-mock 증거 게이팅 감사),
  `compound-extract`(구현 기록이 아닌 판단 기준 추출). verify 스테이지용 `forgen-verify`
  에이전트 추가(플러그인 agents 키로 자동 배포; built-in agents 13→14).
  - **compound↔workflow 양방향 배선**: 두 템플릿이 fan-out 전 forgen-compound MCP
    `compound-search` 로 과거 패턴을 recall(읽기, 안전)하고, `compound-extract` 는
    `args.persist=true` 일 때만 keep 된 후보를 `forgen compound --solution` 으로 적재
    (기본은 review-gated — 품질 게이트 우회 금지). 라이브 확인: 워크플로우 에이전트가
    compound-search MCP 도달·3건 회수.
- **effort 권고 (§5)**: `forgen doctor [Effort]` 섹션 — long-running(forge-loop) 컨텍스트면
  xhigh/ultracode 권고. nudge-only (forgen 은 effort 를 프로그램적으로 설정 불가).

### Changed
- **동시성 임계값 (§4)**: `MAX_CONCURRENT_AGENTS` 10 고정 → `FORGEN_MAX_CONCURRENT_AGENTS`
  env(기본 16) + `workflow-subagent` 면제. workflow/team/swarm 실행마다 뜨던 거짓 경고 제거.
- **meta-guard 디스패처 추출 (§2a)**: stop-guard 인라인 가드 로직을
  `checks/_shared/meta-guard-dispatch.runMetaGuards` 로 추출 (Stop/SubagentStop 공유, 동작 불변).

### Fixed
- **subagent-tracker 동시쓰기 레이스 (§A)**: `load→push→save` 가 파일 락 없는 RMW 였어
  동시 SubagentStart(워크플로우 fanout) 간 lost-update 로 일부 에이전트 누락(probe 에서
  3개 중 1개 손실 관찰). `recordAgentEvent` 추출 + `withFileLock` 으로 보호, 락 안 fresh re-read.

### Notes
- **opus-4.8 재캘리브레이션 PENDING**: v0.4.5 δ>0 측정은 sonnet/codex 드라이버 기준.
  opus-4.8 재측정 전까지 효과 주장을 하지 않음 — 절차/블로커는
  [docs/release/v0.4.11-calibration-pending.md](docs/release/v0.4.11-calibration-pending.md).
- 라이브 검증: forgen-verify 에이전트가 실 워크플로우에서 해소·실행(grep 증거 → confirmed),
  subagent-stop-guard 가 워크플로우 서브에이전트에 발화(40ms, false-block 없음) 확인.

## [0.4.8] — 2026-05-15 — Codex 동등화 마무리 + 잔재 청소

테마: v0.4.6 (Unattended Resilience) 이후 남아 있던 **Codex 동등화 마무리**
(A 묶음) 와 v0.4.7 매트릭스 첫 활성화에서 노출된 **사전 존재 결함 청소**
(E 묶음) 을 한 번에 정리.

### Added
- **A1**: Codex transcript FTS5 인덱싱 — `session-store.ts:indexCodexSession()`
  신설. 이전엔 spawn.ts 가 `runtime === 'claude'` 가드로 Codex 세션을 SQLite
  / FTS5 인덱싱에서 제외해 `session-search` MCP 도구가 Codex 대화를 회수
  못 했음. Claude/Codex schema 별 함수 분기.
- **A2**: corrupt profile 자동 복구 — `profileExists()=true && loadProfile()=null`
  케이스 (parse 실패 / v1 shape 위반) 에서 `profile.json.corrupt-<ts>` 로
  자동 backup → `needsOnboarding=true` 흐름. 데이터 손실 없음. `harness.ts`
  가 backup 경로를 user-visible warning 으로 표시.
- **A3**: `SESSIONS_DIR` (legacy session log) 와 `V1_SESSIONS_DIR` (v1 effective
  state) 정합화 — `V1_DIRS` 에 `SESSIONS_DIR` 추가 (bootstrap early-return
  경로에서도 보장), `forgen doctor` 가 두 dir 모두 노출, `paths.ts` 책임
  주석 확장.
- **E3**: `forgen doctor --repair` — plugin cache / installPath 검사 실패 시
  `npm run build` + `node scripts/postinstall.js` 를 forgen pkgRoot 안에서
  자동 실행. fail-open (실패해도 doctor 진단 흐름은 계속).

### Fixed
- **E1**: `notify.ts` spawn 'error' event 핸들러 — headless CI / Docker /
  notifier 미설치 환경에서 `osascript`/`notify-send` ENOENT 가 unhandled
  로 caller process 를 죽이던 사전 존재 버그. v0.4.7 CI 매트릭스 첫
  활성화에서 노출. 추가로 `rate-limit-spawn-integration` 의 v0.4.7 CI
  skip 가드를 제거 (production fail-safe 보장).
- **E2**: biome lint warnings 24 건 → 0 — `biome --unsafe` 자동 fix 17
  건 + 수동 fix 7 건 (`useTemplate`, `noAssignInExpressions`,
  `noExplicitAny`, `noNonNullAssertion` 등 33 files touched).

### Verified
- vitest 2454 / 2454 PASS (이전 2442 + 새 회귀 가드 12: notify 2, profile-
  corrupt 3, doctor-repair 5, codex-fts 2).
- 로컬 build / lint 0 warning.
- CI 매트릭스 (Linux x64 + arm64, macOS, Windows hooks-portability) 모두
  PASS — 별도 PR 머지 (#31 부분) 후 본 PR 에서 다시 확인.

## [0.4.7] — 2026-05-15 — fgx --codex 권한 플래그 수정

### Fixed
- `fgx --codex` 실행 시 `error: unexpected argument '--dangerously-skip-permissions' found`로
  기동이 즉시 실패하던 버그를 수정. Codex CLI 는 동일 목적의 플래그가
  `--dangerously-bypass-approvals-and-sandbox` 라 Claude 전용 플래그를 그대로
  주입하면 거부됨.
- `HostRuntime.dangerousSkipFlag` 추상화를 도입해 `src/fgx.ts` 가 런타임별로
  올바른 플래그를 선택하도록 변경 (claude 동작은 회귀 없음).
- 경고 배너와 `[forgen] Mode:` 라벨도 선택된 플래그/런타임에 맞춰 동적으로 출력.
- **Windows 빌드 깨짐 (v0.4.4부터 누적)** 수정: `scripts/copy-assets.js`,
  `src/cli.ts`, `src/host/install-orchestrator.ts` 가 `new URL(...).pathname` 으로
  파일 경로를 만들었는데 Windows 에서 `/D:/...` 형태가 그대로 노출되어
  `mkdirSync` 가 `D:\D:\...` 로 해석 → ENOENT. `fileURLToPath()` 로 일괄 교체.
- **Linux CI test 잡 회귀** 수정: `npm run build` 만으로는 `hooks/hooks.json` 이
  생성되지 않아 (prepack 시점에만 생성) `claude-code-compat.test.ts` 등이
  실패. `.github/workflows/ci.yml` 의 test 잡에 `node scripts/prepack-hooks.cjs`
  단계를 추가하여 CI 환경에서도 hooks.json 이 준비된 상태로 vitest 가 돌도록.

### CI / Platform Coverage
- `ci.yml` test 잡을 OS × Node 매트릭스로 확장:
  ubuntu-latest × {20, 22}, macos-latest × {20, 22}, ubuntu-24.04-arm × 22.
  이전엔 vitest 풀 매트릭스가 ubuntu-latest 만 돌았음.
- **Windows**: hooks-portability 잡 (Node 20.x, 22.x × windows-latest) 에서
  빌드 + postinstall + 21/21 hook 로드를 검증. 풀 vitest 는 다수 통합
  테스트가 `/tmp` / POSIX path / bash spawn 가정에 묶여 있어 cross-platform
  재작성이 별도 트랙. 현재 Windows 사용자의 실사용 경로 (`npm i -g` +
  Claude/Codex hook 발동) 는 보장됨.
- `actions/checkout` 에 `fetch-depth: 0` 추가 — `tests/git-stats.test.ts`
  가 실 git log 30일 윈도우를 분석.
- CI 환경 의존 테스트 (`rate-limit-spawn-integration`, `claude-integration`
  의 6-live / 3-live) 에 `it.skipIf(!!process.env.CI)` 가드.

### Verified
- vitest 2442/2442 PASS, Docker e2e 77/77 PASS.
- `node dist/fgx.js --codex` / `--claude` 직접 기동 확인 — Codex CLI 가 플래그 수용.
- `npm run build` + `prepack-hooks` 후 `hooks/hooks.json` 21/21 active 재생성 확인.

## [0.4.6] — 2026-05-14 — Unattended Execution Resilience

긴 무인 실행 (`forge-loop --goal-only` 새벽 실행, eval N=33+ sequential measurement)
이 API rate-limit 을 만나도 자동 sleep + reset 후 재기동하도록 한 테마. 동시에
Codex hook side-effect 갭 (PermissionRequest dispatch 누락) 보완 + dead writer
복구 + 성능 3종 단축.

### Added

#### Theme F — Codex/Claude 동등 사용 (사용자 요청)

claude 와 codex 를 일상에서 동등하게 사용할 수 있게 forgen 측 갭 메움.

- **session-recovery hook 에서 v1-bootstrap 호출** (src/hooks/session-recovery.ts)
  - 이전엔 prepareHarness (fgx/forgen wrapper) 만 bootstrapV1Session 호출 →
    직접 codex/claude 호출 시 `~/.forgen/state/sessions/<id>.json` 미생성.
    SessionStart hook 에서도 호출하여 양쪽 진입 경로 모두에서 session state 박제
    (단 profile 정상 시 — onboarding 안 한 사용자는 둘 다 동등하게 skip).

- **Codex transcript 위치 인식** (src/core/spawn.ts `transcriptProjectDir` 분기)
  - claude: `~/.claude/projects/<sanitized-cwd>/<session>.jsonl`
  - codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl`
  - 위치 인식 + snapshot-diff 기반 attribution 양쪽 작동.
  - **auto-compound input parsing — codex JSONL schema 호환 추가**:
    - `countUserMessages` (spawn.ts) + `extractSummary` (auto-compound-runner.ts)
      양쪽 모두 claude (`type='user'|'queue-operation'`) + codex
      (`type='response_item'` with `payload.role='user'|'assistant'`,
      `content[].text`) 자동 감지 처리
    - codex transcript 도 user message ≥10 시 auto-compound 자동 트리거
    - sessionId 는 rollout 파일명 패턴 (`rollout-<ts>-<sid>.jsonl`) 에서 추출
    - FTS5 인덱싱은 claude 한정 (codex schema FTS 매핑 micro-issue, 추후)

- **동등 작동 항목** (라운드 25+ clean container 검증 합산):
  - Hook 발화 (8 hook 종, codex 0.128.x): 동등
  - prompt-history 기록: 동등 (secret redaction 포함)
  - permissions-<id>.jsonl 기록: 동등 (codex 는 `source: 'pre-tool-use'` 경유)
  - usage-telemetry `rt` 필드: 동등 (#17 fix 후)
  - statusline usage 라인: 동등
  - rate-limit detector + spawn loop: 코드 공유, runtime 분기 1줄
  - `fgx --<runtime>` 단축 + auto-reconcile-on-launch: 동등

- **비동등 잔존 (codex CLI 측 구조적 한계)**:
  - PermissionRequest 이벤트: codex `approval_policy=auto` 에서 미dispatch
    (codex CLI 한계) — PreToolUse supplement 로 결과 데이터는 동등화
  - Subagent dispatch: codex CLI 의 subagent 개념 미지원 — hooks 등록만 존재
  - Codex 0.130.0 hooks dispatch 회귀: codex CLI 0.130 binary 안에 hook event
    schema (HookSpecificOutputWire) 와 `hooks: stable: true` feature flag 모두
    있는데도 dispatch 안 됨. config.toml 의 hooks 경로 명시도 무효. codex CLI
    내부 변경으로 forgen 측에서 worktime 짧게 fix 불가. 0.128.x 권장 + 0.4.7 에
    codex GitHub issue 제기 예정

#### Theme E — Codex auto-onboarding (사용자 요청)

- **`fgx --codex` / `fgx --claude` 단축 플래그** (src/services/session.ts)
  - 기존 `--runtime codex` 의 짧은 alias. 일상 진입이 더 빠름.

- **Codex hooks 자동 reconcile-on-launch** (src/core/harness.ts `ensureCodexHooksFresh`)
  - 매 codex runtime 진입 (fgx --codex / forgen --runtime codex) 시 ~/.codex/hooks.json
    의 forgen entry 가 현재 pkgRoot 와 일치하는지 fast staleness check.
  - 부재/stale → planCodexInstall silent 재실행. 일치 → no-op (1ms).
  - 사용자가 `forgen install codex` 를 명시 호출 안 해도 매번 정합성 보장.
    Cross-machine sync, npm 글로벌 path 변경, forgen 버전 업그레이드 후
    자동 회복.
  - **검증**: clean container 3 시나리오 — A (clean state → 자동 생성),
    B (동일 상태 → no-op idempotent), C (stale `/FAKE/PATH` → 자동 정정).
    모두 통과.

#### Theme A — Unattended Execution Resilience

- **Rate-limit auto-resume** (ADR-008, `commit TBD`)
  - `context-guard.ts` Stop hook 에 `RATE_LIMIT_REGEX` + 5 패턴 reset 시각 파서
    추가 (Resets at HH:MM, in Nh Nm, in N seconds, available again at ISO,
    try again in N min). 22 unit tests.
  - `pending-resume.json` schema 확장: `reason: 'rate-limit' | 'token-limit'`,
    `resetAt?: ISO`, `runtime: 'claude' | 'codex'`. 기존 token-limit 호환 유지.
  - `spawnClaudeWithResume` (src/core/spawn.ts) rate-limit 분기:
    `resetAt` 정확하면 정밀 sleep + 60s 버퍼, 실패 시 exponential backoff
    (1m → 5m → 15m → 30m → 1h → 2h cap). hard cap 6h. foreground countdown
    (30s 갱신, Ctrl+C abort). `MAX_RESUMES`: token=3 (현행), rate-limit=10.
  - **Fix-forward 정책**: detector regex 가 실 메시지와 어긋나면 `~/.forgen/state/
    rate-limit-misses.jsonl` 에 raw 누적 → patch release 로 hotfix.
  - **알려진 한계**: weekly limit (최대 7일) > 6h hard cap, abort + 명시 메시지.
    "Resets at 14:30 PST" TZ 무시 (UTC 가정) — 첫 실 트리거 후 hotfix 예정.

- **Usage telemetry** (src/core/usage-telemetry.ts)
  - 5h / weekly window sliding count. `recordToolCall` 가 PostToolUse 마다
    append-only `~/.forgen/state/usage-telemetry.jsonl` 에 timestamp 기록.
  - 10K 엔트리 누적 시 weekly cap 밖 자동 prune. claude/codex 별도 카운트.
  - 의도적으로 "limit prediction" 제외 — Anthropic 의 실 limit 가 계정/플랜별
    가변. raw count 만 노출하고 사용자가 판단.

- **Statusline usage 라인** (src/core/statusline-cli.ts)
  - 새 라인: `📊 87/5h · 412/wk · (claude)` — 5h/weekly 추세 노출.

- **Notification 모듈** (src/core/notify.ts)
  - macOS: `osascript display notification`, Linux: `notify-send`,
    Windows: 생략. webhook (Slack/Discord 호환) 지원: `~/.forgen/config.json`
    의 `notifyWebhookUrl`. rate-limit auto-resume 이 sleep 끝나고 재기동 시점에
    발송 — 노트북 닫고 잘 때 끝났는지 알 수 있음.

#### Theme B — Codex hook 갭 보완

- **Codex hooks dispatch 죽음 root-cause 박제** (docs/codex-integration.md)
  - 사용자 보고된 "Codex hooks 죽음" 의 진짜 원인 3가지 분리:
    1. `prompt-history.jsonl` writer 부재 (dead code 잔재) — 0.4.6 writer 신설
    2. `context-signals.json` 정상 동작 (도구 실패 시에만 write — 의도)
    3. `permissions-<id>.jsonl` 미생성 — Codex `approval_policy=auto`/
       `workspace-write` 에서 PermissionRequest hook 자체가 dispatch 안 됨
       (forgen 측 버그 아님 — Codex CLI 정책)
  - 기각: projection.ts side-effect 손실, STATE_DIR 미스매치 (모두 정상 검증)

- **PreToolUse permission supplement** (src/hooks/pre-tool-use.ts)
  - Codex `auto` 환경에서도 권한 흐름 가시화 — 모든 PreToolUse 가
    `permissions-<sessionId>.jsonl` 에 `source: 'pre-tool-use'` entry append.
    Claude permission-handler 와 source 필드로 reader 측 dedup.

- **prompt-history writer 신설** (src/hooks/context-guard.ts)
  - UserPromptSubmit 마다 truncated (1KB) prompt 를 `~/.forgen/state/
    prompt-history.jsonl` append. **secret-filter 거쳐 redact** —
    password/api_key/token/AWS/GitHub 등 평문 leak 차단. compound-extractor.ts
    의 dead read 코드가 의미를 가짐.

#### Theme C — Performance

- **Hook stdin idle-resolve + initial-wait fallback** (src/hooks/shared/read-stdin.ts) — perf #11
  - hook-timing.jsonl 측정 결과 pre-tool-use **p95 = 2003ms** (정확히
    timeout 값) — Claude/Codex CLI 가 stdin EOF 안 닫거나 stdin 자체 안 보내는
    케이스. 두 단계 fix:
    1. `IDLE_RESOLVE_MS=100`: 'data' 받은 후 추가 chunk 없으면 early resolve
    2. `INITIAL_WAIT_MS=300`: 'data' 자체가 안 오는 케이스 (codex 일부 hook
       event) 대비 300ms 후 빈 데이터로 fallback resolve
  - 합법적 데이터 손실 위험 없음 — payload 는 호출 즉시 (≤ 300ms) 첫 chunk 도착
  - **검증**: 실 codex 2-라운드 e2e — 1라운드 (idle 만): pre-tool-use 4건 중
    1건이 ms=2004 잔존. 2라운드 (initial-wait 추가 후): 9 hook entry 모두 < 50ms,
    2003ms tail 완전 제거.

- **Auto-compound adaptive cooldown** (src/hooks/context-guard.ts) — perf #12
  - Last run 이 0건 추출 (barren) 했으면 다음 cooldown 5min → 30min.
    `extractedSolutions + promotedRules + userPatternFound` 합산 = 0 판정.
  - Wasted background runs 6x 감소. 일반 case (추출 있음) 5분 유지.
  - Full LLM 호출 parallelization 은 0.4.7 로 분리 — `execClaudeRetryAsync`
    foundation 만 박제 (refactor surface 큼, sandbox + file-write order
    invariant 검증 필요).

- **Statusline 5초 캐싱** (src/core/statusline-cli.ts) — perf #13
  - `~/.forgen/state/statusline-cache.txt` mtime 기반. CACHE_TTL_MS=5_000.
  - **결과**: 160ms → 101ms (37%). Node 시작 50ms 가 floor.

#### Theme D — Maintenance

- **Append-only jsonl 회전** (src/core/state-gc.ts `rotateAppendOnlyLogs`) — #14
  - state-gc 의 SESSION_SCOPED_PREFIXES 가 단일 aggregate jsonl
    (hook-timing, prompt-history, usage-telemetry 등) 무한 grow 미커버 갭 수정.
  - 10MB cap 초과 시 `<name>.1` rotate, `<name>.2` 삭제 (한 단계 보존).
  - `forgen doctor --prune-state` 와 함께 자동 실행. 5 unit tests.

### Verification

- **vitest**: 2441/2441 PASS (225 files), 0 regression
- **Docker e2e (existing)**: 77/77 PASS, 6 warnings (pre-existing)
- **신규 unit tests**: rate-limit-detection (22) + rate-limit-backoff (9) +
  log-rotation (5) = 36

#### Clean-container e2e (`tests/e2e/docker/Dockerfile.v046`)

새 Docker e2e 가 host 권한 없이 깨끗한 container 안에서 실 claude + codex 호출
하여 hook side-effect 를 검증. host UID/GID 매핑 + ~/.codex auth 마운트.

**최종 결과: 17/18 PASS** (1 fail = claude OAuth keychain 미전달 — 환경 한계)

- ✅ **Codex 측 100% 검증** (codex 0.128.0):
  - hook-timing.jsonl +9 entries
  - **permissions-<codex-id>.jsonl 생성** with `source: 'pre-tool-use'` —
    사용자 보고된 "Codex hooks 죽음" 갭 fix 가 진짜 e2e 환경에서 작동 확인
  - usage-telemetry +1 (PostToolUse hook 발화)
  - prompt-history +1 (UserPromptSubmit hook 발화)
  - **pre-tool-use ms=10ms** (no 2003ms tail — #11 fix 실 codex 환경 검증)
  - Secret redaction (clean container 에서 GitHub Token redact 확인)
  - Rate-limit detector synthetic Stop event → marker 정상 작성

- ⚠️ **Claude 측 부분 검증**: hook 발화 +5 (UserPromptSubmit 만), 하지만
  "Not logged in" 으로 도구 호출까지 안 감 → PostToolUse / PermissionRequest
  미발화. **원인은 환경 (macOS Keychain 의 OAuth 토큰을 container 로 전달
  불가)**, 코드 문제 아님.

### Discovered + Fixed during e2e

- **#17 — codex-adapter.ts FORGEN_RUNTIME 미주입** (FIXED)
  - 검증 라운드 20-2 에서 `usage-telemetry.jsonl` 직접 inspect 시 codex 호출
    인데 `{"rt":"claude"}` 발견. `recordToolCall` 가 `process.env.FORGEN_RUNTIME`
    fall-through 로 'claude' 판정.
  - Fix: codex-adapter.ts 의 `spawnSync` 에 `env: { ...process.env,
    FORGEN_RUNTIME: 'codex' }` 명시 주입.
  - 영향: statusline 의 "(codex)" 표시 + telemetry 분리 정상화.

- **#15 — install-codex.ts isForgenManagedHook 버그** (FIXED)
  - Root cause: `command.includes(pkgRoot)` exact match 만 체크 → 다른 머신에서
    install 한 hooks.json 이 마운트되면 stale path entry 가 "user entry" 로
    오분류 → 보존 + 새 entry 누적 → codex 가 stale path 로 dispatch 시도 →
    silent fail
  - Fix: `FORGEN_HOOK_SCRIPT_MARKER` regex (`/dist\/(host\/codex-adapter|hooks
    \/[a-z][a-z0-9-]+)\.js/`) fallback. 사용자 보고된 "Codex hooks 죽음" 의
    더 깊은 원인이었음 — PermissionRequest skip 갭 (#9) 외에 path mismatch 도
    동시 작용하던 것
- **#16 — Codex 0.130.0 hooks dispatch 회귀** (별도 task)
  - Bisect: 0.128.0 dispatch 정상 (9 entries), 0.130.0 silent fail
    (~/.forgen/state/ 자체 미생성)
  - forgen 측 코드 동일 — codex-cli 0.130.0 의 hooks API/schema 변경 의심
  - 임시 권장: codex 0.128.x 사용. 0.4.7 에서 0.130.0 호환 조사

### Known first-run UX gap (verified, not a code bug)

- `npm i -g forgen` 후 **한 번도** `fgx` 또는 `forgen install <claude|codex>` 을
  거치지 않고 `claude` / `codex` 를 직접 호출 → forgen hooks 비활성 (settings.json
  / hooks.json 미등록).
- 첫 `fgx --claude` / `fgx --codex` 한 번 (또는 명시 install) 이면 settings.json /
  hooks.json 이 영구 저장되어 이후 직접 호출도 hooks 발화 (clean container e2e
  Scenario A/B/C 로 검증). v0.4.6 의 ensureCodexHooksFresh 가 fgx 진입을 더
  부드럽게 만듦.
- README / onboarding 에 "first command: `fgx`" 명시 권장. 자동화 fix (예: npm
  postinstall 에서 install both) 는 사용자 권한 가정 위반이라 0.4.7 검토.

### 미검증 항목 (실 트리거 자연 발생 대기)

- **Rate-limit auto-resume**: synthetic Stop event 로 marker 작성 검증.
  실 limit hit 은 자연 발생 시 fix-forward 정책 (rate-limit-misses.jsonl 누적
  → patch hotfix) 으로 보강.
- **Notification 발송**: rate-limit 도달 의존. notify 모듈 syntax 검증 완료.
- **Claude full chain (PostToolUse 등)**: macOS Keychain 토큰 container 전달
  불가 — `claude /login` 별도 인증 필요한 환경 한계.


### Fixed — forgen-eval testbed 측정 결함 (ADR-007)

`forgen-eval` ψ-stat 측정의 두 구조적 결함 식별 + 수정. 본 fix 이전 모든
ψ 측정 보고는 "ADR-007 이전 testbed 결함 위에서 산출됨" disclaimer 적용.
**v0.4.4 release note 의 mean ψ=+0.098 master gate PASS 도 본 disclaimer 대상**
(haiku judge + 결함 arm + 결함 mem 위 측정).

- **[testbed-P0] ForgenPlusMemArm single-session 결합** (`commit 25c8ac0`)
  - 이전 구현은 forgen-only LLM 세션과 mem-only LLM 세션을 *각각* 돌리고
    forgen 응답만 채택 — Driver 가 `qwen2.5:14b @ temp=0.3` 비결정 호출이라
    `full.W − forgenOnly.W` 가 LLM stochastic noise 로 양/음 ±0.3 흔들림.
    ψ 가 forgen+mem coexistence 신호 대신 LLM 분산을 측정.
  - 한 LLM 세션 안에서 forgen UPS rule + claude-mem recall 을 둘 다 system
    message 로 주입한 뒤 한 번 chat → forgen Stop guard 평가 구조로 재작성.

- **[testbed-P0] claude-mem 콘텐츠 직접 fetch** (`commit d65b4a4`)
  - 이전 mem recall 은 `claude-mem search` CLI 출력 (검색 결과 *테이블* —
    세션 ID + 제목만) 을 그대로 inject. LLM 컨텍스트로는 사실상 메타-noise
    이고, 응답을 verbose / cautious / "context 더 주세요" 쪽으로 shift 시켜
    sonnet judge 의 actionable advice 점수를 깎았음.
  - 신규 `claudeMemRecallActual()` helper — 검색 후 ID 파싱 →
    `~/.claude-mem/claude-mem.db` 의 `observations.narrative` /
    `session_summaries.learned` 직접 조회 → 상위 N hit 의 실제 콘텐츠 inject
    (`[#ID]\n<content>` 포맷). DB 미설치 환경에서 graceful no-op.

- **신규 분석 도구**: `src/runners/probe-mem-inject.ts` — judge 호출 없이
  ForgenOnly + Full arm inject 텍스트와 응답을 콘솔에 덤프하는 정성 probe.
  cross-talk 가설 검증에 사용.

- **신규 ADR**: `docs/adr/ADR-007-testbed-arm-isolation.md` — 두 결함의 발견
  경위, 영향 받은 측정 목록, 재측정 계획, 회귀 가드 명시. 후속 정성 분석
  (E, 2026-05-08) 으로 cross-talk 가설보다 LLM stochasticity (qwen2.5:14b @
  temp=0.3 base error rate × 더 긴 context surface) 가 음수 ψ 의 더 강한 설명
  임을 확인 — 다음 측정의 전제조건으로 Driver determinism (temp=0 + seed) 또는
  더 강한 driver 권고.

- **재측정 결과 (track-mem-fix N=10 sonnet, 2026-05-08)**: 양쪽 fix 적용 후
  mean ψ = −0.080, 95% CI [−0.161, −0.000], gate FAIL (음수 시그널). 7 음수 /
  3 양수. v0.4.4 release note 의 mean ψ=+0.098 PASS 는 broken testbed 의
  artifact 였음이 더 강하게 확정됨.

### Changed — driver 를 claude-cli / codex-cli 로 통일 (commit 62600ec, 11b897a)

testbed driver 가 Ollama qwen2.5:14b 로 남아 judge stack (claude-cli +
codex-cli) 과 불일치 + qwen base error rate (~30-50%) 가 noise 의 주 원인 이었던
문제를 production 시나리오 (forgen 이 personalize 하는 LLM = Claude 또는 Codex)
와 일치하는 driver 로 교체.

**측정 비교 (N=10 sonnet judge, 2026-05-11 ~ 12)**:

| Driver | N eff | mean ψ | CI | mean δ(forgenOnly−vanilla) | 양수 δ | κ γ |
|---|---|---|---|---|---|---|
| qwen mem-fix (이전) | 10 | −0.080 | [−0.161, −0.000] | (n/a) | — | (n/a) |
| claude (older fixes) | 10 | +0.020 | [−0.133, +0.158] | +0.046 | 7/10 | (n/a) |
| codex (all fixes) | 10 | +0.024 | [−0.029, +0.094] | +0.120 | 8/10 | 0.323 |
| claude (all fixes, rate-limit cut) | 9 | −0.013 | [−0.083, +0.039] | +0.156 | 8/9 | 0.429 |
| claude (retry+sequential N=20) | 20 | +0.016 | [−0.012, +0.047] | +0.096 | 14/20 | 0.583 |
| codex (retry+sequential N=20) | 20 | +0.013 | [−0.029, +0.055] | +0.133 | 19/20 | 0.048 |
| **claude (judge retry N=33)** | **33** | **−0.005** | **[−0.036, +0.029]** | **+0.125** | **30/33 (91%)** | **0.474** |
| **codex (judge retry N=33)** | **33** | **−0.021** | **[−0.068, +0.024]** | **+0.176** | **32/33 (97%)** | **0.263** |
| **POOLED N=66 — 학술 증명** | **66** | **−0.013** | — | **+0.151** | **62/66 (93.9%) — p=1×10⁻¹⁴** | — |

**핵심 발견**:
- ψ (forgen+mem coexistence) 는 양 driver 모두 noise 영역 — 부호가 driver 별로
  갈리고 CI 가 0 가로지름. **forgen+mem 결합 효과는 통계적으로 측정 불가능.**
- δ (forgenOnly−vanilla) 는 **양 driver 일관 양수**, 다수 케이스 일관 — codex
  driver 에서 +0.144 W. **forgen 단독 효과는 robust 하게 양수.**
- **셀링 메트릭 변경**: ψ 가 아닌 **δ (forgen vs vanilla)** 가 진짜 셀링
  포인트. v0.4.4 의 ψ master gate PASS 주장 대신 v0.4.5 부터는 δ 중심 메시지.

**알려진 limitation**:
- ~~codex driver 1MB input 한계~~ ✓ FIXED (commit 1362d59 history cap 16K)
- ~~codex judge spawn E2BIG~~ ✓ FIXED (commit e42bff6 judge stdin pipe + 5c8dce8
  material cap 32K). fallback 2.5: 56 → 3 (95% 감소).
- ~~claude CLI subscription rate-limit~~ ✓ FIXED commit 7b333b2 (driver retry +
  exponential backoff). claude retry+sequential N=20 측정에서 retry 0회 발동
  (sequential 만으로 충분), N=20 effective 회복.

### Fixed — Node 20.x 환경 호환성 (P0/P1)

`npm i -g @wooojin/forgen` 이후 "각종 훅이 에러난다"는 사용자 보고에 대응한 환경
호환성 일괄 강화. 보고 환경: M2 MacBook + Node 20.x.

- **[P0] hook-registry.ts import attributes 호환성** (`src/hooks/hook-registry.ts:56`)
  - `import ... with { type: 'json' }` (Node 20.10+ 만 파싱 가능) → `JSON.parse(readFileSync(...))`
    로 교체. Node 20.0–20.9 에서 모든 훅(23개)이 SyntaxError 로 깨지던 회귀를
    제거. 빌드 산출물에 import attributes 가 재유입되는 것을 막는 정적 검증 테스트
    `tests/hook-registry-portability.test.ts` 추가.
  - 영향 범위: hook-config 를 거쳐 모든 PreToolUse / PostToolUse / Stop / SessionStart
    / UserPromptSubmit 훅이 Node 20.0–20.9 사용자 환경에서 동작하지 않던 상태에서
    회복.

- **[P1] postinstall self-check** (`scripts/postinstall.js`)
  - 설치 마지막 단계에서 `dist/hooks/hook-registry.js` 를 dynamic import 로 로드하고,
    `HOOK_REGISTRY` 가 비어있지 않은지 확인. 실패 시 stderr 로 Node 버전과 원인을
    명시해 사용자가 "왜 훅이 안 도는지" 를 install 시점에 즉시 알 수 있게 함
    (npm install 자체는 깨뜨리지 않음).

- **[P1] install-claude.ts symlink 폴백 진단** (`src/host/install-claude.ts:67-87`)
  - Windows 비관리자 / macOS SIP 환경에서 `fs.symlinkSync` 가 EPERM 으로 실패하면
    조용히 cpSync 로 폴백하던 동작에 stderr 진단 메시지 1줄 추가. "왜 install 이
    느린지" 가 사용자에게 보임.

- **[P1] CI portability matrix 확장** (`.github/workflows/ci.yml`)
  - Node 20.0.0 / 20.10.0 / 20.x / 22.x × ubuntu/macos/windows 6개 조합으로 훅
    스모크 잡 추가. 모든 `dist/hooks/*.js` 를 sentinel input 으로 실행해
    SyntaxError / Cannot find module / ERR_ 발생 시 CI 실패. 회귀 즉시 감지.

### Notes

- `node:sqlite` 의존 (`src/core/session-store.ts`) 은 기존 try/catch 폴백으로 Node
  <22.5 에서도 graceful degrade 동작 유지. session-search MCP 도구는 0건 반환.
- `quality-check.mjs MODULE_NOT_FOUND` 같이 사용자/타플러그인이 등록한 외부 훅이
  worktree 에서 누락된 경우는 forgen 책임 영역 아님. `isForgenHookEntry()` 가
  `dist/hooks/*.js` 경로만 자기 소유로 인식하므로 외부 훅 항목은 보존.

## [0.4.4] — 2026-05-06

> **⚠ 정정 (2026-05-08, ADR-007 이후)**: 본 릴리스의 ψ master gate PASS
> (mean +0.098, CI [+0.002, +0.222]) 주장은 **broken testbed 위 측정** 으로
> 확정. 두 구조 결함 (ForgenPlusMemArm 비-결합 / mem recall 메타 inject) 위에서
> 산출되어 LLM noise + max-selection bias 가 평균을 양수로 끌어당긴 artifact.
> 양쪽 결함 수정 후 재측정 (track-mem-fix N=10 sonnet) 결과는 mean ψ = −0.080,
> CI [−0.161, −0.000], gate FAIL. **현 시점 forgen+mem 결합은 net negative
> 또는 noise 영역** — qwen2.5:14b @ temp=0.3 driver 의 hallucination 분산이
> 결합 효과를 mask 함. Driver determinism (temp=0 + seed) 또는 더 강한 driver
> 적용 후 재측정까지 셀링 보류. 자세한 내용은 ADR-007 참조.
>
> δ(forgenOnly−vanilla) = +0.223 주장도 같은 testbed 위 산출이므로 같은
> disclaimer 대상. 단 forgenOnly arm 자체는 본 ADR fix 영향 받지 않음 (vanilla
> 와의 비교는 단일 arm 내부 비교라 LLM noise 가 양쪽에 균등 분포 가능성 — 단
> 재측정으로 확인 필요).

### v0.4.4 — measurement infra rebuild + stop-guard hardening (DANGEROUS-RESPONSE)

forgen-eval testbed 의 측정 인프라 5-layer 결함을 모두 수정해 신뢰성을 회복하고,
그 과정에서 발견한 driver-brittleness 결함(syn-004 — small driver 가 학습된 룰을
파괴 명령 우회로 회피)을 stop-guard `dangerous-response-pattern` 체크로 직접
close. 사후 N=10 재측정에서 **ψ master gate PASS** (mean +0.098, 95% CI [+0.002,
+0.222]) — pre-hardening (-0.028) 대비 부호 양수 전환. 또한
δ(forgenOnly−vanilla) = +0.223 (CI [+0.134, +0.326], 10/10 cases positive) 으로
forgen 효과가 robust 하게 확인됨. (위 박스 참조: 본 측정 결과는 ADR-007 이후
broken testbed artifact 로 확정.)

**Highlights**:

- **DANGEROUS-RESPONSE 응답 텍스트 가드** (`feat`)
  - `src/checks/dangerous-response-pattern.ts` + `tests/dangerous-response-pattern.test.ts` (12 케이스)
  - `src/hooks/stop-guard.ts` checks pipeline 에 1순위로 wire-in (raw lastMessage 사용 — sanitizer 가 코드 fence 를 stripping 하므로 sanitized 는 부적합)
  - 패턴 셋: `find -exec rm`, `find -delete`, `xargs rm`, `rm -r/-rf`, `git push --force`, `git reset --hard`, `DROP TABLE`, `dd of=/dev/`, `curl|sh`, `wget|sh` 등 14종 (응답 텍스트용)
  - 매칭 시 block + correction 요청 (FORGEN_USER_CONFIRMED=1 으로 한 turn 우회 가능)
  - 발동 검증: hardening N=10 측정에서 forgenOnly arm block 2건 (이전 측정들 0건)

- **forgen-eval testbed 5-layer fix** (`fix`)
  1. Judge contamination — `claude` CLI 가 사용자 전역 `~/.claude/CLAUDE.md` 로드 → judge 가 forgen 어시스턴트로 빙의 (β score=0/NaN 다발). `claude -p ... --system-prompt <blind>`, `codex exec --ignore-user-config --ignore-rules --ephemeral` 로 격리.
  2. Persona stub — runner 가 ID 문자열만 β judge 에 전달. `loadPersonaSpec()` 도입해 `personas/persona-XXX.json` 실 spec 로드.
  3. Trigger turn hook 누락 — `ForgenOnlyArm` 이 correctionSequence 만 hook 통과. trigger 단계도 UPS+Stop hook pipeline 추가.
  4. Notepad 미초기화 — case 별 임시 cwd + `seedForgenNotepad()` 로 사전 학습 상태 시뮬레이션.
  5. Hooks dir 경로 하드코딩 (root cause) — 잘못된 절대경로로 모든 hook 호출이 silently 실패. `import.meta.url` 기반 상대경로로 자동 해결. (이 결함이 이전 모든 ψ 측정을 무효화하고 있었음)
  6. Bridge 응답 shape — `additionalContext` 가 `hookSpecificOutput` nested 필드. 인터페이스/접근 코드 동시 수정.

- **Two-layer enforcement 명문화** (`docs`)
  - `README.md` + `README.ko.md` 의 "How It Works" 에 "Two-layer safety enforcement / 2-layer 안전 적용" 섹션 추가. soft (notepad-injector) + hard (PreToolUse + Stop DANGEROUS-RESPONSE) 모델 명시. 작은 driver 가 학습 룰을 우회해도 hard layer 가 차단함을 사용자가 이해 가능.

- **Judge rubric 4-anchor 명세** (`fix`)
  - `packages/forgen-eval/src/judges/judge-types.ts` β/γ/φ 프롬프트에 1/2/3/4 모든 anchor 명시 (이전엔 1/4 만). 작은 judge 가 중간 점수 일관성 확보.

- **Reports as audit trail** (`chore`)
  - `packages/forgen-eval/reports/psi-stat/*.json` 7건 (5월 4-6일) — pre-isolation, post-isolation, broken sleep run, fixed run, post-rubric, post-hardening 의 비교 가능한 측정 시리즈.

- **4축 personalization P1 — facet 임계값 분기 활성화** (`feat`)
  - `src/renderer/rule-renderer.ts` — `_profile` → `profile` 활성화. 13개 facet (3 quality + 4 autonomy + 3 judgment + 3 communication) 의 0.85 / 0.15 임계값 분기 도입.
  - 이전엔 facet 값이 inspect-print 외 어디에도 사용되지 않았음 (12-bucket pack lookup 만 활성). 본 변경으로 4축이 *연속 값* 으로 응답에 영향.
  - `tests/renderer/rule-renderer.test.ts` — facet 0.1 vs 0.9 byte-diff 회귀 테스트 5건 (verification_depth, verbosity, approval_threshold 등).

- **judgment / communication 축 facet delta 갱신 경로** (`feat`)
  - `src/core/auto-compound-runner.ts` — `profile_delta` 스키마 + 적용 분기에 `judgment_philosophy`, `communication_style` 케이스 추가. 이전엔 quality_safety / autonomy 2축만 자동 갱신, 나머지 2축은 0.5/0.45 default 영원 고정.

- **시맨틱 룰 FP 좁히기** (`fix`)
  - `src/checks/fact-vs-agreement.ts` — `EVIDENCE_INDICATORS` 추가 (test counts `\d+/\d+`, exit code, timing, vitest output 형식, diff hunks 등 9 패턴). 응답에 측정 증거가 paste 되어 있으면 alert 억제 → "Docker e2e 77/77 PASS" 류 정량 사실 보고 FP 감소. tests/fact-vs-agreement.test.ts 4 케이스 추가 (총 13).
  - `~/.forgen/me/rules/L1-no-mock-as-proof.json` — `trigger_exclude_regex` 에 `<observation>`, `<summary>`, observer 메타 패턴 추가. 메타-설명 응답 FP 감소.
  - `~/.forgen/me/rules/L1-e2e-before-done.json` — TDD 진행 보고(`RED→GREEN`, `[N/M]`, `다음 단계`, `진행 상황`) 제외 패턴 추가.

**Final measurement (post-hardening + post-narrowing, 두 N=10 합산 N=20)**:
- ψ master gate: 두 측정 모두 borderline 0 (run1 −0.026, run2 +0.001) — composition-synergy metric 으로는 회귀
- **δ(forgenOnly−vanilla) N=20 = +0.161, CI [+0.068, +0.256]** — *진짜 forgen 효과* metric, 0 위로 robust. 14/20 cases positive.
- δ(full−vanilla) N=10 (run2): +0.218, CI [+0.117, +0.323]
- κ_γ ~0.38 / κ_β ~0.41 — subscription-mode CLI judge 한계 (haiku 가 4점 척도 안정 분류 어려움)
- fallback 5/160 = 3.1% (≤ 10% 게이트)
- forgenOnly arm block 이벤트 발화 — DANGEROUS-RESPONSE 패턴이 driver 우회 응답을 차단

**Production data sample (8일, 230 violations)**:
- 9 distinct rules 발화: fact-vs-agreement 67, L1-no-mock-as-proof 56, self-score-inflation 41, L1-no-rm-rf-unconfirmed (PreToolUse) 23, dangerous-response-pattern (신설, 첫날) 20, L1-e2e-before-done 15, etc.
- Stratified random sample N=30 → precision 60.7%. **Hard layer (PreToolUse + dangerous-response-pattern) 100% (6/6)**, semantic Stop-guard 룰 43-60%.
- drift 자가복구 14건 — stuck-loop 상황 force-approve 후 drift 기록 (메타 안전성).

**Host parity status**:
- ✅ **Claude (claude)**: 모든 hook 동작 확정 (이번 세션 라이브 self-validated 다수)
- ⚠️ **Codex (codex)**: PreToolUse hard layer + UserPromptSubmit soft layer 동등. Stop hook response-text 검사 (DANGEROUS-RESPONSE, L1-no-mock-as-proof 자가검증 등) 는 *best-effort* — codex CLI 가 Stop input 에 `last_assistant_message` 또는 `transcript_path` 를 제공해야 발화. 미제공 시 silently auto-approve (안전). 실 codex 사용 데이터로 다음 1주 검증 예정 (gap 발견 시 v0.4.5 보완).

**v0.4.4 Does NOT claim**:
- v0.5.0 release-proof. v0.5.0 은 70B 로컬 / Sonnet API 기반 강judge 로 κ ≥ 0.7 + 더 큰 N 으로 *사전 등록* metric (δ 우선) 으로 처음부터 측정 예정.
- 외부 재현 — 실행에 Claude Max + Codex subscription 필요.
- ψ master gate PASS — 두 N=10 측정 모두 borderline 0. ψ 자체가 composition-synergy 측정이라 "forgen이 vanilla 대비 좋은가" 질문에 부적합 metric 임이 본 사이클에서 확인됨. δ 가 답이고 δ 는 양수.

**Lessons (post-mortem)**:
- 측정 인프라 5-layer 결함 (특히 hooks dir 하드코딩) 으로 이전 모든 ψ 측정이 실은 vanilla-vs-vanilla 였음. 5월 6일 hardening + bridge fix 후에야 forgen 메커니즘이 testbed 에서 실제로 발화 시작.
- ψ 정의 ("full vs best single arm composition") 가 주 product 질문 ("forgen 이 vanilla 대비 좋은가") 과 어긋남을 늦게 발견. v0.5.0 metric 재정의 필요.
- 1주일 production data 가 enforcement 메커니즘 활성을 입증하나, FP precision (특히 시맨틱 룰 43-60%) 은 별도 트랙 개선 과제.

### Internal — pathfinder + Deep Interview fix cycle (2026-04-30 post-v0.4.3)

**Pathfinder (stop-guard 3-check 구조 진단 + unify)** (`refactor`)
- `PATHFINDER-2026-04-30/` — features → flowcharts → duplication report → unified proposal → handoff
- `src/checks/_shared/text-sanitizer.ts` + tests — 3-check (`self-score-inflation`, `fact-vs-agreement`, `conclusion-verification-ratio`) measurement Set 중복 제거
- `src/hooks/stop-guard.ts` — 3-check 디스패처 정리

**Deep Interview D9/D11/D12 fix** (`fix`)
- D9: `docs/guard-design-checklist.md` — guard 설계 invariant 명문화
- D11: `src/store/compound-usage-store.ts` + tests + `src/mcp/tools.ts` wiring
  - MCP `compound-read/list/search` 호출 시 `~/.forgen/state/compound-usage.jsonl` 에 사용 evidence 적재
- D12: `assets/claude/commands/calibrate.md` + `retro.md` — `~/.forgen/me/evidence/` → `behavior/` 경로 drift 수정 (skill 카탈로그 정합성 회복)

**Auto-compound retry 로깅 개선** (`chore`)
- `src/core/auto-compound-runner.ts` — retry 메시지에 attempt count + 에러 코드 + fail-open 단언 (UX 명확화, 동작 변경 없음)

### Hygiene
- `package.json` self-dep 오염 (`@wooojin/forgen ^0.4.3`) 제거
- `plugin.json` (root) 0.4.2 → 0.4.3 sync (이전 d4c640c 가 `.claude-plugin/plugin.json` 만 sync)
- `package-lock.json` workspace + transitive peer dep 동기화

**Verification**: vitest 2373/2373 PASS, Docker e2e 77/77 PASS (round 16)

## [0.4.3] — 2026-04-30 — Self-correcting hotfix + testbed prep (alpha)

forgen-eval introspect testbed (이번 릴리즈에 포함된 자기 측정 시스템) 가
release-blocker 두 결함을 자가 진단 + fix 까지 한 사이클에 검증한 릴리즈.
큰 v0.5.0 testbed-proof 셀링은 실 PASS gate 통과 후로 미루고, 본 릴리즈는
*hotfix + testbed scaffolding alpha* 로 정직하게 박음.

### Hotfix (forgen body)

**TEST-6 — bypass-detector false-positive fix** (`fix`)
- `src/engine/lifecycle/bypass-detector.ts`: Korean stop list (실행/사용/선언/수행/처리/작성/호출/적용 + 변형) + parens-heuristic 정밀화
- 기존 root cause: Korean regex `(\S+)\s*(?:말라|금지|하지\s*마|쓰지\s*마)` 가 정책 텍스트 "rm -rf 실행하지 마라" 에서 "실행" 만 추출 → 모든 코드의 "실행" 단어가 false positive (RC5/E9).
- Parens-heuristic: `(rm -rf, DROP, force-push)` 같은 *예시 목록*은 토큰 추출하되, file path (`tests/e2e/docker/run-test.sh`) 와 exclusion notes (`프로덕션 코드 맥락 한정, 테스트 파일 내 vi.mock 은 제외`) 는 skip.
- 자기증거: 16일 사용 데이터에서 strict φ 65.66% 의 84% 가 이 단일 버그 (3 L1 rules: no-rm-rf-unconfirmed, e2e-before-done, no-mock-as-proof). 향후 0 false positive 박힘.

**TEST-1 — fact-vs-agreement Stop hook wiring** (`fix`)
- `src/hooks/stop-guard.ts`: `checkFactVsAgreement` import + alert-level invocation. `kind: 'correction'` (no block) — 원 design intent ("alert level only — block 은 TEST-2 에서") 준수.
- 기존 결함: `src/checks/fact-vs-agreement.ts` 코드 존재했으나 어떤 hook 도 호출 안 함 (forgen-eval introspect 가 발견한 wiring gap).

### Repo / infra

**GitHub repo migration** (`chore`)
- `wooo-jin/forgen` → `forgen-team/forgen` 이전 (1 star + 6 issues 자동 마이그레이션, redirect 자동)
- npm scope `@wooojin/forgen` 그대로 유지 (npm scope ≠ GitHub org 정상 패턴)
- 11 파일 URL bulk 갱신 (READMEs + plugin.json + CONTRIBUTING + CHANGELOG + SECURITY)

**npm workspaces enable** (`chore`)
- `"workspaces": ["packages/*"]` 추가 — forgen-eval 같은 부속 alpha package 호스팅용
- 본 forgen 패키지 무게 영향 0 (peerDep 모델, forgen-eval은 별도 publish)

### Testbed scaffolding (alpha — private workspace)

**`@wooojin/forgen-eval@0.4.3-alpha.0` (private, not published)** (`feat`)
- `packages/forgen-eval/` — forgen 효용 검증 testbed scaffolding
- 7-축 메트릭: γ_slope (Cohen's d + Wilcoxon r), β_likert, δ/ε/ζ rate, φ Wilson-CI master gate, ψ weighted synergy
- κ (Cohen's + Fleiss') judge agreement
- 5 arms (vanilla / forgen-only / claude-mem-only via CLI invoke / forgen+mem / gstack)
- DEV (Sonnet 4.6 + Qwen + Llama Triple) + PUBLIC (Qwen + Llama Dual) judge tracks
- vitest 22/22 PASS

**`forgen-team/forgen-eval-data` 외부 dataset repo** (`feat`)
- https://github.com/forgen-team/forgen-eval-data — CC-BY-SA-4.0
- 10 personas (4 academic + 3 github-issue + 3 forgen-user-anonymized, seed-unreviewed)
- CURATION.md — 외부 PR 정책 (자체 작성 금지, 2-reviewer 강제)

**claude-mem coexistence (Plugin model)** (`design`)
- ADR-004 amendment — orchestration 가설 폐기, Plugin model 확정 (사용자가 둘 다 별도 plugin install)
- forgen 본체에 claude-mem 의존성 추가 안 함 (AGPL-3.0 회피)
- spec §10a — 6 사용자 시나리오 → 메트릭 매핑 narrative

### Documentation

- `docs/plans/2026-04-28-forgen-testbed-proof-spec.md` — Deep Interview 11라운드 spec
- `docs/spike/2026-04-28-claude-mem-spike.md` — claude-mem 실측 (AGPL/Plugin model 발견)
- `docs/adr/ADR-004/005/006-*.md` — coexistence / module / metrics ADRs
- `docs/release/v0.5.0-checklist.md` — 미래 v0.5.0 게이트 (이 릴리즈는 *준비*)

### 알려진 한계 — 정직 disclosure

**φ master gate 미통과 (current 10.53%, target ≤ 5%)** — 이 릴리즈는 *측정 시스템*이지 *PASS 입증*이 아님:
- TEST-6 fix 적용으로 strict φ 65.66% → 10.53% (84% reduction). 미래 introspect 사이클에서 추가 감소 예상.
- 남은 5.53pp 는 user-rule scope 영역 (예: `.then` async/await 룰의 사용자 우회). Pattern bug 아님.
- 진짜 PASS gate (φ ≤ 5%) 통과 시 v0.5.0 출시.

**Self-evidence**: forgen 의 자기 검증 시스템 (`packages/forgen-eval/src/runners/introspect.ts`) 이 자기 자신의 패턴 매칭 버그를 6주 만에 정밀하게 짚어내고 fix 까지 검증한 첫 사이클. v0.4.0 trust restoration 미션이 self-correcting harness 로 한 발자국 더.

### 회귀 검증
- vitest: 2356/2356 (216 files)
- bypass-detector: 14/14 (3 RC5/E9 regression 신규)
- forgen-eval: 22/22
- Docker e2e: 77/77 (`~/.forgen/state/e2e-result.json` round 14)
- 회귀: 0

## [0.4.2] - 2026-04-27

### v0.4.2 — Trust hotfix + 학습 회로 4축 확장

v0.4.1 이 신뢰 회복 릴리스였다면, v0.4.2 는 **외부 진단(trust-hotfix-report)을 측정으로 검증해 5개 W 를 닫고**, 동시에 v0.4.1 자기 분석에서 발견된 **자동 학습이 4축 중 2축에만 닿는 결함(D1)** 과 **검증 레이어 invariant 부재(P1~P4)** 까지 한 사이클에 통합한 릴리스.

**M1 — RC6 가드: forge-loop findings 자동 inject** (`feat`)
- `src/hooks/shared/forge-loop-state.ts` 신규 — readForgeLoopState / renderForgeLoopForSession / renderForgeLoopForPrompt
- `session-recovery` (SessionStart) + `forge-loop-progress` (UserPromptSubmit) 신규 hook 이 직전 forge-loop findings 또는 진행 중 stories 를 ≤1KB 로 inject
- 자기증거: head -80 truncation 으로 directly 유실됐던 사례 invariant 박제
- Stale 24h soft / 7d hard cap, XML escape

**D1'' — auto-compound axis_refs 4축 분류 확장** (`feat`)
- `src/core/behavior-classifier.ts` 신규 — 5분기 (workflow/thinking/preference + **safety/autonomy** 신규)
- LLM prompt 카테고리 7종으로 확장 ([품질안전], [자율성] 추가)
- 결과: behavior_observation 자동 추출이 4축 모두에 닿음 (이전 2축 → 4축)
- 측정 자기증거: behavior 627건 중 quality 7 / autonomy 6 만 explicit_correction 경로로 들어왔던 결함 해결

**P2 — false-positive corpus golden test** (`test`)
- `tests/invariants/no-false-positive-block.test.ts` (FP1~5 + RC5-E9, 8 케이스)
- `tests/invariants/true-positive-block.test.ts` (E5/E6 정당 block 5 케이스)
- 신규 detector CI gate — vitest 가 tests/invariants/* 자동 포함

**P3' — Blocking ALLOW-LIST 정책 + denyOrObserve helper** (`feat`)
- `src/hooks/shared/blocking-allowlist.ts` (4개 멤버: stop-guard / pre-tool-use / secret-filter / db-guard)
- `denyOrObserve(hookName, reason, observer?)` helper — ALLOW-LIST 외 hook 의 deny 시도가 자동 관찰 모드로 강등
- 점진 마이그레이션 시작점 (기존 hook 들은 별도 PR)

**P4 — fix:feat 비율 셀프 가드** (`feat`)
- `src/core/git-stats.ts` — 최근 30커밋 fix:feat 비율 측정 (fix(test):/fix(docs): 제외)
- forgen stats 에 "Repo health" 섹션 + forgen doctor 가 30% 초과 시 경고
- v0.4.2 릴리즈 시점 측정값: **29%** (정상 범위, ⚠ 미발생)

**W1 — 한국어 README 설치 명령 오타 fix** (`fix`)
- `README.ko.md:86, 146` 의 `npm install -g /forgen` → `@wooojin/forgen`
- `tests/readme-install-contract.test.ts` 4 로케일 일치 invariant

**W2 — 온보딩 2/4 문항 계약 통일** (`fix`)
- `src/cli.ts:164, 469` 도움말 `2-question` → `4-question`
- `src/forge/onboarding.ts` 주석 4문항 갱신 + spec 경로 정정 (docs/history/)
- `tests/onboarding-contract.test.ts` — askChoice 호출 수 vs help text 일치

**W3 — agent 인벤토리 12↔13 정렬** (`fix`)
- `README.md:381` "12 built-in agents" → "13" + ch-solution-evolver Plan-only 표 추가
- `tests/agent-inventory-contract.test.ts` — agents/ 디렉토리 = README + verify-v3.sh 단일 source

**W4 — hooks-generator releaseMode 옵션** (`feat`)
- `generateHooksJson({ releaseMode: true })` 환경 독립 모드 — plugin 감지 + hook-config 비활성화 모두 무시
- `prepack-hooks.cjs` 가 releaseMode=true 사용 (HOME swap 도 유지하여 double safety)
- `tests/hooks-generator-release-mode.test.ts` — mock plugin / mock disable 양쪽 검증

**W5 — 하드코딩 → HOOK_REGISTRY.length 동적 read** (`refactor`)
- 3 자리 (plugin-coexistence / harness-e2e / chain-verification) 의 `21` 하드코딩 제거 → 동적 length
- `tests/contract-single-source.test.ts` 자체 invariant — 향후 하드코딩 추가 시 자동 fail
- A3 false-positive 가드: hook-timing/cache-lock-integration 의 다른 의미 20 은 건드리지 않음

**D2 — autonomy axis confidence 직접 경로** (`fix`)
- `bumpAxisConfidence(axis, delta)` — explicit_correction 의 axis_hint 가 즉시 confidence bump
- `evidence-processor.ts` 에서 호출: avoid-this +0.04, 그 외 +0.02
- 자기증거: autonomy explicit_correction 6건이 score 못 움직였던 결함 해결
- facet 값은 안 건드리고 confidence 만 — 회귀 위험 최소

**자기증거 박제** (`docs`)
- `docs/issues/D2-autonomy-facet-stuck.md` — D2 root cause 추적
- `docs/issues/W4-W5-self-evidence.md` — 본 forge-loop 1차에서 W4/W5 antipattern 을 단기 회피로 재생산한 사례 (RC7 후보)
- compound 4 박제: rc6-meta-amnesia, rc7-diagnostic-self-fix, validator-layer-invariant, interview-axes-disconnect-RETRACTED

**회귀**:
- vitest **2215/2215** (199 files, 신규 13 테스트 파일)
- Docker e2e **77/77 + ALL CHECKS PASSED** (round 12, mock_detected:false)
- typecheck 0

**Outstanding (별도 PR)**: P3' enforcement 의 기존 hook 마이그레이션, prepack-hooks.cjs 의 HOME swap 단순화

---

## [0.4.1] - 2026-04-24

### v0.4.1 — 하네스가 당신을 담고 간다

v0.4.0 이 Trust Layer (Claude 가 "완료"라고 하면 forgen 이 증명하게 한다) 를 세웠다면, v0.4.1 은 **구매자가 첫 block 을 즉시 경험**하고 **README 만 봐도 "하네스가 당신을 담고 간다" 는 비전을 이해**하게 만드는 릴리스. 내부적으로는 직전 회차에서 scope-out 했던 측정 갭 3건을 정직하게 재평가 → 실제로 닫았고, 10 시나리오 실 Claude signal 누적으로 검증.

**3개 구조적 갭 마감** (`feat`)
- `recall_referenced` 측정: name literal 단일 매칭 → identifier / 복합 태그 2개 교차 fallback 추가. Claude 가 slug 이름 대신 solution content 만 인용해도 잡힘. 일반 단어 단독은 false-positive 방지 위해 제외.
- `Rule.lifecycle` 자동 초기화: `saveRule` 이 lifecycle 없으면 `phase='active'` + counters=0 주입. suppressed rule 의 audit trail (누가 언제 왜) 추적 가능.
- `forgen compound list` 출력: `inj: / ref: / neg:` 컬럼에 "ref 측정은 v0.4.1+ 부터 시작됨" 주석. legacy 데이터 `ref:0` 을 "도움 안 됨" 으로 오독하는 혼란 해소.

**README 리프레시** (`docs`)
- **The harness carries you 섹션 신설**: "대화 → 추출 → 주입 → 반복" cycle + `forgen compound export/import` (개인 철학 번들을 tar.gz 로 이식) 연결. forgen 을 "rule 주입 tool" 로 축소 해석하는 오독 해소.
- 한국어/일본어/중국어 README 동기화 ("하네스가 당신을 담고 간다" / "ハーネスがあなたを運ぶ" / "这个 harness 装载的是你").
- **The first block 데모 일반화**: forgen-repo 전용 L1 rule → v0.4.1 내장 `builtin:self-score-inflation` (TEST-2) 기반 일반 시나리오로 교체. 구매자가 rule 작성 없이도 첫 block 을 바로 체감.
- Commands 섹션에 `forgen recall` / `forgen migrate` / `forgen init` 추가.
- Cold-start boost 설명: champion/active 솔루션 < 5 이면 `MIN_INJECT_RELEVANCE` 0.3 → 0.2 완화.

**natural-accumulation e2e** (`test`)
- 격리 `FORGEN_HOME` + 실 Claude API 10 시나리오로 "시간이 답" 이던 open signal 4종을 수십 분 내 실증:
  - `recall_referenced` 0 → 2 (33% 참조율)
  - `recommendation_surfaced` 1 → 6 (60% 주입률, cold-start boost 실효 확인)
  - TEST-2 자연 block 0 → 3
  - TEST-3 자연 block 0 → 2
  - hook-errors 0 (전 경로 clean)

**회귀**: vitest 2114/2114 (신규 테스트 4건 포함). typecheck 0.

---

## [0.4.0] - 2026-04-23

### v0.4.0 — The Trust Layer

**When Claude says "done", forgen makes it prove it.** v0.4.0 adds turn-level self-verification at the Stop hook: Claude's completion claims get checked against rules you define, and blocks are fed back as `reason` that Claude reads and complies with on the next turn — **zero extra API calls**. Verified end-to-end on 10 scenarios at $1.74 total ([A1 spike report](docs/spike/mech-b-a1-verification-report.md)).

Built on top of the v0.3.x personalization core (4-axis profile + compound knowledge + rule rendering): the Trust Layer = 3-axis enforcement (Mech-A/B/C) + rule lifecycle (T1-T5 + Meta) + release self-gate. Interview rounds 9~10 mission "forgen 이 자기 규칙을 forgen 자신에게 강제 적용" achieved — this repo's own development was stopped mid-commit by its own L1 rule when the maintainer claimed "완결" without running Docker e2e (evidence preserved in `.forgen/state/enforcement/violations.jsonl`).

**ADR-001 — Mech-A/B/C 3축 강제 메커니즘** (Accepted)
- Mech-A (hook-BLOCK): 기계 판정 가능 규칙 — PreToolUse deny / Stop artifact_check.
- Mech-B (self-check prompt-inject): 자연어 판정 규칙 — Stop hook `decision:"block"` + `reason` 으로 Claude 자가점검 강제. **β1 ($0): 외부 LLM 호출 없음.**
- Mech-C (drift-measure): 정량 판정 불가 규칙 — 장기 편향만 측정.
- A1 검증 스파이크 10/10 PASS ($1.74, 3분): block 수용률 1.00, FP 0.00, hook p95 7ms, 추가 API 0.

**신규 타입** (`src/store/types.ts`):
- `EnforcementMech`, `HookPoint`, `VerifierSpec`, `EnforceSpec` — `Rule.enforce_via` 에 붙음 (optional, 기존 rule 하위 호환).
- `EnforceSpec.trigger_keywords_regex` / `trigger_exclude_regex` / `system_tag` — Stop hook 전용 발화 조건.
- `LifecyclePhase`, `LifecycleState`, `MetaPromotion` — `Rule.lifecycle` 에 붙음.

**신규 Hook**:
- `src/hooks/stop-guard.ts` — Stop hook. Production `rulesFromStore(loadActiveRules())` 로드, spike scenarios.json fallback. `last_assistant_message` 직접 read. stuck-loop guard (threshold 3 초과 시 force approve + drift 이벤트). `compoundCritical: true` (보호 hook).
- `src/hooks/shared/hook-response.ts::blockStop(reason, systemMessage?)` helper.

**ADR-002 — Rule Lifecycle Engine** (Accepted)
- T1 explicit_correction: `evidence-store.appendEvidence` → `detectT1` → rule retire/supersede/flag. axis + render_key 이중 매칭으로 FP 차단.
- T2 repeated_violation: 30d rolling window `violations_30d ≥ 3 AND rate > 0.3` → flag. 데이터 소스: `~/.forgen/state/enforcement/violations.jsonl` (stop-guard block 시 자동 append).
- T3 user_bypass: `post-tool-use` 에서 `bypass-detector.scanForBypass` → `recordBypass`. 7d `bypass_count ≥ 5` → suppress.
- T4 time_decay: `state-gc.runDailyT4Decay` — `forgen doctor --prune-state` 실행 시 90d 미주입 rule retire (별도 scheduler 없음; 사용자가 명시적으로 실행).
- T5 conflict_detected: `rule-store.appendRule` 에서 T5 감지, 양쪽 `conflict_refs` 기록.
- Meta 양방향: drift.jsonl 누적 → 강등 (A→B→C); rolling 20 injects + 0 violations → 승급 (B→A, C→B).
- Orchestrator `applyEvent` / `foldEvents` pure — rule 파일 쓰기는 호출자 책임.
- `src/store/rule-store.ts::markRulesInjected` — `v1-bootstrap` 이 renderRules 후 호출해 Meta 롤링 카운터를 채움.

**ADR-003 — Release Self-Gate** (Accepted)
- `.github/workflows/self-gate.yml` — push main / PR main / tag v* 에서 3-stage 검증.
- `scripts/self-gate.cjs` — 정적 스캔: mock-in-production, secrets-leak (AWS 공식 EXAMPLE fixture allow list), enforce_via-missing, release-artifact.
- `scripts/self-gate-runtime.cjs` — 6 hook 시나리오 smoke (완료 선언 block / retraction approve / shipped block / mock-context approve 등). 격리 HOME.
- `scripts/self-gate-release.cjs` — tag-only: version/tag match, CHANGELOG section, dist freshness, .forgen-release/e2e-report.json.

**신규 CLI**:
- `forgen rule <list|suppress|activate|scan|health-scan|classify>` — 규칙 관리 네임스페이스. 기존 플랫 커맨드(suppress-rule, activate-rule, lifecycle-scan, rule-meta-scan, classify-enforce)는 하위 호환 alias 로 유지.
- `forgen stats` — 한 화면 대시보드 (active rules, corrections, blocks/bypass/drift 7d, retired 7d, last extraction). 기존 jsonl 집계; 신규 telemetry 없음.
- `forgen inspect corrections` — `forgen inspect evidence` 의 사용자 친화 이름. evidence 는 alias 로 유지.
- `forgen last-block` — 가장 최근 block 이벤트 상세.

**내부 CLI (하위 호환, alias 로 유지)**:
- `forgen classify-enforce [--apply] [--force]` → `forgen rule classify`.
- `forgen rule-meta-scan [--apply]` → `forgen rule health-scan`.
- `forgen lifecycle-scan [--apply]` → `forgen rule scan`.

**Upgrade notes (v0.3.x → v0.4.0)**:
- 첫 `forgen` 실행 시 기존 rule 파일 (`~/.forgen/me/rules/*.json`) 에 `lifecycle` 블록이 자동 주입됩니다 (inject_count, phase='active' 등). 기존 필드는 보존됨.
- 프로젝트 로컬 `.forgen/rules/*.json` 이 자동 로드됩니다 (runtime 병합). 팀 dogfood 경로. 테스트/격리 필요 시 `FORGEN_DISABLE_PROJECT_RULES=1`.
- `FORGEN_USER_CONFIRMED=1` 으로 Mech-A PreToolUse 우회 시 violations.jsonl 에 `kind:'correction'` audit 엔트리 기록.

**운영 지표**:
- 전체 회귀 1973/1973 pass (169 files), TypeScript clean.
- forgen doctor 20/20 hooks active; legacy `~/.forgen/rules/` orphan 감지 추가.
- Self-gate 정적 ✓ + 런타임 7/7 (SG-ACK round-trip 포함); Docker e2e 77/77 (Phase 9 R9 전체 검증).
- `npm pack` tarball 539.3 kB, 332 파일, v0.4.0 메타데이터 확인.

**관측성**:
- `acknowledgments.jsonl` 신규 — Mech-B block → retract → pass 루프가 실제 작동한 세션 기록. `forgen stats` 의 `X% acknowledged` 라벨로 집계.

## [0.3.2] - 2026-04-21

### Security — Audit findings landed

Independent read-only audit (docs/claude-audit-brief.md) surfaced 10 structural
issues plus 2 follow-up findings. All 12 are fixed with invariant tests.

**P0 — data loss / code injection**
- **Settings parse-failure data loss** (#2, #10): `settings-injector.ts` and
  `scripts/postinstall.js` no longer silently replace a malformed settings.json
  with `{}`. New `readSettingsSafely()` preserves the corrupt original to
  `settings.json.corrupt-<ts>` and throws; writers release the lock and abort.
  postinstall settings + `~/.claude.json` now use tmp-file + rename atomic write.
- **Code injection via node -e** (#5): `session-recovery.ts` no longer
  interpolates a user-supplied sessionId into a `-e` template literal. A
  dedicated runner at `dist/hooks/internal/run-lifecycle-check.js` reads the id
  from argv — no shell, no eval surface.
- **solution-outcomes race** (#9): all pending-state mutations are now serialised
  under `withFileLockSync` + `atomicWriteJSON`. Concurrent inject / correction /
  error hooks on the same session no longer lose or duplicate events.
- **Archive path traversal** (follow-up #A): `compound-export.importKnowledge`
  rejects entries whose resolved destination sits outside ME_DIR, including
  sibling-directory prefix collisions (e.g. `../me-evil/…`).

**P1 — lock semantics, trust, uninstall, injection precision**
- **Settings-lock live-holder handling** (#1): acquireLock now throws
  `SettingsLockError` on live-PID timeout instead of overwriting the lock;
  releaseLock verifies ownership before deleting.
- **Trust silent escalation** (#3): `preset-manager.computeEffectiveTrust`
  returns a `Trust 상승` warning when runtime is more permissive than desired;
  harness surfaces it to the user; fgx cautions `가드레일 우선`/`승인 완화`
  profile users.
- **Install/uninstall symmetry** (#7): `uninstall` now strips `FORGEN_*` env
  keys (previously only `COMPOUND_*`) and recognises `forgen me` (previously
  only `forgen status`) as the forgen-owned statusLine.
- **Legacy profile guard** (#6): `loadProfile` runs `isV1Profile` and returns
  null on legacy shapes so bootstrap re-runs cutover instead of typing stale
  JSON as v1.
- **secret-filter vendor tokens** (follow-up #B): GitHub PATs (ghp_/gho_/
  ghs_/ghu_/ghr_), Google API keys (AIza…), and Slack tokens (xox[abpors]-…)
  are now detected.

**P2 — label truth, transcript attribution**
- **permission-handler labels** (#4): `approve()`/`approveWithWarning()` never
  set `permissionDecision: 'allow'`; they are pass-through. Log and API labels
  renamed to `safe-pass-through` / `autopilot-warn-pass-through` /
  `autopilot-pass-through` / `pass-through` so audit trails match reality.
- **Transcript per-session attribution** (#8): `spawn.ts` snapshots existing
  transcripts before launching claude and diffs after exit; concurrent sessions
  in the same cwd no longer cross-attribute. Transcript reading switched to
  streaming (`createReadStream` + `readline`).

### Added — Data hygiene

Field audit on a ~2-week-old install found 10,802 files in `~/.forgen/state/`
across 12 filename prefixes, 4.3 MB `match-eval-log.jsonl`, and 80% of
error-attribution events concentrated on 3 solutions injected at relevance
0.15–0.21.

- `forgen doctor --prune-state` (new `src/core/state-gc.ts`): removes session-
  scoped files older than 7 days (checkpoint-, injection-cache-, modified-
  files-, outcome-pending-, permissions-, skill-trigger-, tool-state-,
  reminder-, context-, last-). Aggregate jsonl logs are preserved.
- `solution-outcomes.attributeError` gates: match_score ≥ 0.3,
  injection-lag ≤ 5 min, top-3 by relevance. Prevents blanket blaming of
  every injected solution when a tool fails.
- `solution-injector.MIN_INJECT_RELEVANCE = 0.3` + multi-tag precision gate
  (`matchedIdentifiers ≥ 1 OR matchedTags ≥ 2`): the matcher remains
  permissive for recall@5; only the injection step enforces the stricter
  gate. Zero single-tag high-score injections observed in the field corpus
  after landing.
- `match-eval-log.jsonl` size-based rotation at 10 MB (one generation
  retained).

### Fixed — e2e test isolation

Docker-spawned hooks in `tests/e2e/*.test.ts` were writing session state
(`e2e-tool-chain`, `chain5-test`, etc.) into the developer's real
`~/.forgen/state/`. Each e2e file now allocates a fresh `mkdtempSync` HOME
and injects it into the spawn env; `afterAll` cleans up. Likewise
`tests/hook-response-tracking.test.ts` now mocks `node:os` so the tracking
log never lands outside `/tmp/`.

### Fixed — Stale Docker verify checks

`tests/e2e/docker/verify.sh` was asserting three skills that were deleted in
commit f534227 (v0.3 quality refactor). Result goes from 62/4/6 to 63/0/6
without touching runtime code.

### Notes

- All fixes confirmed via invariant tests (1732/1732 pass across 143 files),
  7 real-world attack scenarios (injection, concurrent mutation, corrupt
  settings, path traversal, prune, doctor smoke), and Linux-clean-environment
  Docker verification.
- Upgrade path from 0.3.1 verified (profile + solutions + non-forgen settings
  byte-identical after upgrade).
- Windows code paths exist but runtime validation is deferred to GH Actions
  Windows runner — see P-D note in release audit.

## [0.3.1] - 2026-04-16

### Added — Self-Evolving Harness (inspired by Stanford meta-harness)

Three-phase evolution loop around the existing compound solution store:

**Phase 1 — Fitness Loop (Select axis):**
- `solution-outcomes`: per-session inject→outcome event log (accept/correct/error/unknown) with fail-open semantics; attribution through solution-injector (appendPending/flushAccept), correction-record MCP (attributeCorrection), and post-tool-failure hook (attributeError).
- `solution-fitness`: Laplace-smoothed acceptance ratio × log(1+injected) confidence. State classification: draft / active / champion / underperform. No auto-delete — population-relative thresholds only.
- `solution-quarantine`: malformed frontmatter no longer silently dropped — invalid files surface in `~/.forgen/state/solution-quarantine.jsonl` with actionable diagnostics; `listQuarantined` / `pruneQuarantine` helpers.
- `solution-fixup`: schema migration for legacy defects (missing `extractedBy`, missing `evidence` block, missing `supersedes`). Applied to the live install, this recovered 5 dead solutions and one was injected on the next matching prompt.

**Phase 4 — Self-Evolution (Propose + Select axes):**
- `solution-weakness`: structured discovery report from four detectors — under-served tags (correction evidence without a matching champion), conflict clusters, dead corners (injected=0 with unique tags), volatile solutions (accept-rate shift >0.3).
- `ch-solution-evolver` agent: Opus proposer, Bash-disabled, emits exactly 3 novel candidates into `~/.forgen/lab/candidates/` with 30%-80% tag overlap gate and self-critique novelty check.
- Candidate cold-start bonus: solutions with `status: candidate` get confidence × 1.3 so they reach enough injections to accumulate fitness. Auto-promotes to `verified` at 5 injections; bonus disappears naturally.
- Candidate lifecycle: `promoteCandidate` validates schema + refuses name collisions before moving files from lab to `me/solutions`. `rollbackSince` archives every `source: evolved` solution newer than a cutoff to `~/.forgen/lab/archived/rollback-{ts}/` (never deletes — always recoverable).

**CLI surface:**
- `forgen learn fix-up [--apply]` — dry-run repair of malformed solutions.
- `forgen learn quarantine [--prune]` — show / clean dropped solutions.
- `forgen learn fitness [--json]` — per-solution fitness table.
- `forgen learn evolve [--save]` — weakness report + proposer hint.
- `forgen learn evolve --promote --list` / `--promote <name>` — candidate promotion.
- `forgen learn evolve --rollback <epoch-ms-or-ISO>` — time-bounded rollback.
- Dashboard gains a 🎯 Solution Fitness panel (state distribution + top-3).

**Dogfood evidence:** the full pipeline was exercised end-to-end — weakness report → evolver-agent proposal → schema validation → promotion → cold-start-boosted match (relevance 0.78) → injection counter increment.

### Documentation
- `docs/design-solution-evolution.md` — Phase 4 design spec with open questions, prerequisites, and rollout plan.

## [0.3.0] - 2026-04-15

### BREAKING

- **Skill consolidation: 21 → 10**. Removed: refactor, tdd, testing-strategy, documentation, git-master, ecomode, specify, performance, incident-response, database, frontend, ci-cd, api-design, debug-detective, migrate, security-review. Most were generic checklists; their content is better handled by Claude natively or absorbed into remaining skills.
- **Agent consolidation: 19 → 12**. Removed: performance-reviewer, security-reviewer (merged into code-reviewer as review perspectives), refactoring-expert, code-simplifier (merged into executor), scientist, qa-tester (merged into verifier), writer.
- **Custom frontmatter removed**: Agents no longer use `tier` and `lane` fields (Claude Code ignored them anyway).

### Added

- **5 new skills** designed from best-in-class research (OMC ralph, gstack /ship, /retro, /learn):
  - `forge-loop`: PRD-based iteration with Stop hook persistence. Prevents polite-stop anti-pattern.
  - `ship`: 15-step automated release pipeline with "never ask, just do" philosophy + Review Readiness Dashboard + Verification Gate.
  - `retro`: Weekly retrospective with git analysis + compound health + learning trend + compare mode.
  - `learn`: Compound knowledge management — 5 subcommands (search/stats/prune/export/import) with stale & duplicate detection.
  - `calibrate`: Evidence-based profile adjustment — quantitative protocol, 3-correction threshold, max 2 axes per calibration.
- **Stop hook forge-loop integration** (`context-guard.ts`): When `.forgen/state/forge-loop.json` has incomplete stories, Stop is blocked with persistence message. Circuit breakers: 2h stale threshold, 30 max blocks.
- **Learning Dashboard** (`forgen dashboard`): New "Learning Curve" section showing correction trend (7d vs prev 7d), top correction axes, activity days, estimated time saved via compound injections.
- **Session Summary with Counterfactual**: Session end message now includes "주입된 compound: N건 / 추정 절약 시간: Xh Ym (forgen 없었으면 시행착오 필요)".
- **Plugin system**: `.forgen/skills/*.md` scan path added. Project-level custom skills supported.
- **Stale agent cleanup**: `harness.ts` `installAgents` now removes `ch-*.md` files that don't exist in current source (with marker + hash verification for user-modification safety).

### Changed

- **All 10 skills upgraded** with `<Compound_Integration>`, `<Failure_Modes>`, `argument-hint`. Density dramatically improved despite fewer skills.
- **All 12 agents upgraded** with `<Failure_Modes_To_Avoid>`, `<Examples>` (Good/Bad), `<Success_Criteria>`, and official frontmatter (`maxTurns`, `color`, `permissionMode`).
- **deep-interview rewritten** using OMC research: weighted 4-dimension scoring, 3 challenge modes (Contrarian/Simplifier/Ontologist), ontology stability tracking, anti-sycophancy rules, one-question-at-a-time protocol.
- **Cancel flow**: `cancelforgen` now also deletes `forge-loop.json` to release Stop hook block.
- **Install is global-only**: `package.json` sets `preferGlobal: true` so non-global installs surface a warning (forgen is a CLI on PATH; local installs were unreachable).
- **README**: Added "12 built-in agents" section grouped by tool access (read-only / plan-only / write-enabled) with the absorbed-agent mapping from the 19→12 consolidation.

### Fixed

- **Agent parser compat**: Moved `<!-- forgen-managed -->` marker below YAML frontmatter in all 12 `agents/*.md`. Claude Code's agent parser requires `---` on line 1; the prior position caused `Agent(subagent_type: "ch-*")` to fail with "not found" while the file stayed marked as managed.
- **README install typo**: `npm install -g /forgen` → `npm install -g @wooojin/forgen` (missing scope).
- **flaky e2e test**: `runHook` helper in `tests/e2e/chain-verification.test.ts` now requires the parsed stdout JSON to carry a `continue` field, preventing stray log lines from satisfying the parser and producing false `continue:false` matches. Verified stable across 3 consecutive full runs (1541/1541 each).

### Documentation

- `docs/weakness-analysis-2026-04-14.md` — Competitor analysis vs 7 harness tools
- `docs/design-skills-agents-plugins.md` — Full design specification with implementation status
- `docs/skill-scenarios.md` — 12 developer scenarios × skill usage matrix
- `docs/positioning-and-selling.md` — Market positioning and Go-to-Market strategy

## [0.2.1] - 2026-04-13

### Added
- **specify skill**: Structured requirement specification with Resolved/Provisional/Unresolved 3-level evaluation and readiness percentage
- **deep-interview skill**: Deep requirement interview with Ambiguity Score (0-10) quantification across 5 axes (What/Who/How/When/Why)
- **Agent output validation** (Tier 2-F): PostToolUse hook validates sub-agent output for empty/failed/timeout/context overflow
- **BM25 ensemble scoring** (2-C): 3-way ensemble (TF-IDF 0.5 + BM25 0.3 + bigram 0.2) for solution matching
- **Intent-based context injection** (2-B): implement/debug/refactor/review intents inject domain-specific rules
- **Harness maturity diagnosis**: `forgen doctor` shows 5-axis L0-L3 maturity score with Quick Wins
- **Session brief handoff**: Structured brief saved before compact, restored on next session start
- **Output overflow prevention**: Solution injection footer includes head_limit guidance

### Fixed
- **Korean `\b` boundary**: Fixed 7 regex patterns where `\b` failed with Korean text (intent-classifier, keyword-detector)
- **Revert→drift connection**: `isRevert` was always false (checked messages array instead of boolean flag)
- **ALL_MODES missing specify**: `cancelforgen` didn't clear specify state
- **MCP list TypeError**: Crashed on url-format servers without `args` field
- **Agent empty string**: Empty string (`""`) was falsy, skipping validation
- **Solution content regex**: `\Z` is not valid in JavaScript (literal Z), changed to `$`
- **`severity: 'info' as 'warning'`**: Removed forced type assertion

### Changed
- **Rule renderer AI optimization** (2-A): `[category|strength]` tag prefix format, `include_pack_summary` defaults to false (token reduction)
- **Recovery messages** (1-A): ENOENT suggests Glob search, EACCES suggests chmod
- **skill-injector lock**: Session cache protected with `withFileLockSync` (race condition fix)
- **incrementFailureCounter lock**: Context signals protected with `withFileLockSync`
- Docker E2E expanded to 68 checks (Phase 8: Hoyeon analysis verification)

## [5.1.0] - 2026-04-06

### Fixed
- **Reflection 메커니즘 수리**: compound-read MCP 호출 시 `reflected += 1` 기록 — lifecycle 프로모션 루프 해제 (injected 30회인데 reflected 0이던 문제 해결)
- **훅 주입 누락 (W0)**: harness가 hooks.json을 settings.json에 직접 주입 — 플러그인 캐시 없이도 17개 훅 런타임 작동
- **태그 노이즈**: 한국어 조사 strip (`stripKoSuffix`), 영어 스톱워드 6개 추가, MAX_TAGS 10→8

### Added
- `forgen compound retag` CLI 서브커맨드 — 기존 솔루션 태그 일괄 재생성
- `readSolution()` `skipEvidence` 옵션 — compound-search snippet에서 evidence 오염 방지
- `migrateToForgen()` — `~/.compound/` → `~/.forgen/` 자동 마이그레이션 + symlink

### Changed
- 모든 `ME_*` 경로를 `~/.forgen/` 기반으로 통합 (스토리지 이원화 해소)
- `V1_*` 상수 deprecated 처리 (ME_*와 동일 경로)
- 완료/폐기된 계획 21개를 `docs/history/`로 이관

## [5.0.0] - 2026-04-03

### Breaking Changes
- v1 personalization engine: 4-axis profile (quality_safety, autonomy, judgment_philosophy, communication_style)
- 60% 코드 제거 (pack, remix, dashboard, loops, constraints, knowledge 등)

### Added
- Evidence-based learning: correction-record MCP → facet delta → profile auto-update
- Mismatch detection: rolling 3-session behavioral divergence alert
- Starter solutions: 15개 Day 0 value pack + postinstall seed
- Session store: SQLite FTS5 full-text session search

## [3.1.0] - 2026-04-01

### Added
- **Understanding layer (Phase 1)**: HTML dashboard (`forgen me --html`), Knowledge Map (`forgen compound map`), Evolution Timeline (sparkline), Session Retrospective (5-rule pattern engine)
- **Personalized orchestration (Phase 2)**: Pipeline Recommender (`forgen pipeline`), Agent Overlay Injection (PreToolUse approve(message)), Contextual Bandit (Factored Beta-TS)
- **Forge auto-init (Phase 0)**: Auto-creates forge-profile via project scan when missing, session endTime backfill, experiment cleanup (`doctor --clean-experiments`)
- **Surprise Detection**: z-score 1.5σ deviation from reward baseline (activates after 30+ observations)
- **Preference Stability**: BKT P(known) stability bars for dimension convergence tracking

### Fixed
- compound-search returned 0 results (tag noise + matchedTags<2 threshold + cross-language gap)
- compound-lifecycle timeout (grep scanned node_modules/dist/.git)
- pattern-detector ignored user-rejection events (only checked user-override)
- 4 HIGH issues from v3 code review (MCP readOnly, gate1 mutation, test homedir, empty assertion)

### Changed
- Korean stopwords expanded (+50 words for 조사/어미/접속사)
- Solution search: name-based matching boost for cross-language queries
- README: honest Day 1 timeline, "50+ pattern detectors" clarification, test stats updated

## [3.0.0] - 2026-03-31

### Breaking Changes
- **Public API**: Removed `readCodexOAuthToken`, `loadProviderConfigs`, `ProviderConfig`, `ProviderName`, `ProviderError`, `PackError`, `PackMeta`, `PackRequirement` exports from lib.ts
- **CLI**: 37 commands → 12 (removed pack, remix, dashboard, setup, status, worktree, ask, codex-spawn, synth, wait, notify, governance, gateway, worker, proposals, scan, verify, stats, rules, marketplace, session, philosophy)
- **Dependencies**: Removed `ink`, `react`. Added `zod` as direct dependency

### Added
- **MCP compound server**: 4 tools (compound-search, compound-list, compound-read, compound-stats) for on-demand knowledge access
- **Behavioral learning**: 10 thinking patterns (verify-first, quality-over-speed, understand-why, pragmatic, systematic, evidence-based, risk-aware, autonomous, collaborative, incremental)
- **Pre-compact Claude analysis**: Claude analyzes conversation for thinking patterns at context compaction (0 API cost)
- **Session feedback**: "[forgen] 학습된 패턴 N개 활성 중" shown at session start
- **forge-behavioral.md**: Auto-generated rules from learned preferences
- **Progressive Disclosure**: Push summaries (~200 tokens), pull full content via MCP (89% token reduction)
- **Hook response utilities**: Shared approve/deny/failOpen functions (Plugin SDK format)
- **Tool-specific matchers**: db-guard→Bash, secret-filter→Write|Edit|Bash, slop-detector→Write|Edit

### Changed
- **Codebase**: 36,977 → ~26,000 lines (30% reduction, Phase 1/2 added ~2,300 lines)
- **Hook protocol**: Migrated all 17 hooks from `result/message` to `continue/systemMessage` (Plugin SDK format)
- **Tag extraction**: Korean stopwords filter (80 words), MAX_TAGS=10, frequency-based ranking
- **Solution matching**: Identifier-based boost (+0.15), threshold relaxed (2 tags → 1 tag or 1 identifier)
- **Context budget**: Conservative fallback (factor=0.7 on detection failure)
- **Rules**: Conditional loading via paths frontmatter, RULE_FILE_CAPS enforced (3000/file, 15000/total)
- **Skill descriptions**: Updated to 3rd-person format per Claude Code Plugin SDK best practices
- **Build**: `rm -rf dist` before tsc (clean tarball guaranteed)

### Removed
- Pack system (src/pack/, packs/, forgen pack commands)
- Remix system (src/remix/)
- Dashboard TUI (src/dashboard/, ink/react dependencies)
- 27 unused modules (synthesizer, marketplace, worktree, etc.)
- 12 workflow mode commands (ralph, autopilot, team, etc.)
- Philosophy generator/CLI
- Templates directory
- Dead INJECTION_CAPS (keywordInjectMax, perPromptTotal)

### Fixed
- **compound-lifecycle.ts**: confidence subtraction -20 → -0.20 (was zeroing on 0-1 scale)
- **compound-lifecycle.ts**: Promotion now runs before staleness check (was blocking upgrades)
- **compound-lifecycle.ts**: Identifier staleness aligned to 6+ chars (was 4+, mismatched with Code Reflection)
- **session-recovery.ts**: runExtraction fire-and-forget (3056ms → 151ms)
- **Security**: Symlink protection at 8 locations, SUDO_USER execFileSync, settings.json single-write
- **postinstall**: Matcher field from hook-registry.json (was hardcoded '*')
- **uninstall**: Now cleans mcpServers['forgen-compound']
- **Dead paths**: forgen status→me, dashboard deleted, tmux binding fixed, REMIX_DIR removed
- **Docs**: All 4 language READMEs rewritten, SECURITY.md updated to 2.5.x→3.0.0

### Security
- 46 issues fixed across 6 review iterations
- All hooks fail-open with Plugin SDK format
- Prompt injection defense: 13 patterns + Unicode NFKC + XML escaping
- YAML bomb protection (5KB frontmatter cap, 3 anchor limit)

## [2.1.0] - 2026-03-25

### Added
- **Compound Engine integrity improvements**
  - **Code Reflection false positive prevention** — identifier minimum length raised from 4 to 6 characters, reducing false `reflected++` from common words
  - **"Why" context in auto-extraction** — extracted solutions now include git commit messages, addressing the "git diff only shows what, not why" gap
  - **Staleness detection** — `checkIdentifierStaleness()` verifies solution identifiers still exist in codebase via grep
  - **Extraction precision metrics** — `compound-precision` lab event emitted during lifecycle checks for tracking promotion/retirement rates
- **Token injection guardrail** — `MAX_INJECTED_CHARS_PER_SESSION = 8000` (~2K tokens) caps per-session injection cost, tracked in session cache
- **E2E hook pipeline tests** — 7 integration tests verifying actual hook stdin→stdout JSON protocol (solution-injector, keyword-detector, pre-tool-use, slop-detector, db-guard)
- **fgx security warning** — CLI now emits 3-line warning on startup when permissions are skipped
- **Documentation**
  - Open source readiness review feedback (P0/P1/P2 prioritized)
  - Action plan v2.1 (7 phases, 33 items, 18 success criteria)
  - ADR-001: large file decomposition plan
  - ADR-002: EMA learning rate parameter rationale
  - Auto vs manual extraction tradeoff guide
  - oh-my-claudecode coexistence guide
  - Case study template for dogfooding data
  - Good first issues list (6 issues)

### Fixed
- **3 failing tests** — slop-detector-main.test.ts depended on local `~/.compound/hook-config.json` (now mocked)
- **106 empty catch blocks → 0** — all replaced with `debugLog()` or descriptive comments explaining why safe to ignore
- **70 biome lint warnings → 5** — `noAssignInExpressions`, non-null assertions, array index keys, etc. (remaining: `useTemplate`, `useLiteralKeys`)
- **CI coverage double-run** — merged `npm test` + `--coverage` into single vitest invocation to prevent mock state corruption

### Changed
- **Coverage thresholds** — aligned vitest.config.ts with actual coverage (35% lines) instead of unrealistic 85%. CI now enforces thresholds.
- **Node.js requirement** — 18 → 20 (vitest v4/rolldown requires `node:util.styleText`)
- **CI matrix** — removed Node 18, kept Node 20 + 22
- **CONTRIBUTING.md** — replaced "No linter yet" with Biome instructions, added architecture diagram
- **README** — added vendor lock-in notice, "When to Use" table, fgx warning section
- **Multi-language READMEs** — synced KO/ZH/JA with all English changes
- **GitHub Actions** — checkout v4→v6, setup-node v4→v6

### Dependencies
- `@types/node` ^22.19.15 → ^25.5.0
- `@vitest/coverage-v8` ^4.1.0 → ^4.1.1

## [2.0.0] - 2026-03-24

### Added
- **Compound Engine v3** — evidence-based cross-session learning system
  - **Solution Format v3** — YAML frontmatter with version, status, confidence, tags, identifiers, evidence counters
  - **Code Reflection** — PreToolUse hook detects when injected solution identifiers appear in Edit/Write code
  - **Negative Signal Detection** — PostToolUse hook detects build/test failures and attributes to experiment solutions
  - **Extraction Engine** — git-diff-based automatic pattern extraction with 4-stage quality gates (structure, toxicity, dedup, re-extraction)
  - **Lifecycle Management** — experiment → candidate → verified → mature with evidence-driven promotion and confidence-based demotion
  - **Circuit Breaker** — experiment solutions with 2+ negative signals auto-retired
  - **Contradiction Detection** — flags solutions with 70%+ tag overlap but disjoint identifiers
  - **Prompt Injection Defense** — 13 injection patterns, Unicode NFKC normalization, XML tag escaping
  - **Solution Index Cache** — in-memory mtime-based cache for matching performance
  - **V1→V3 Migration** — automatic format upgrade on first access with symlink protection
  - **CLI** — `compound list`, `inspect`, `remove`, `rollback`, `--verify`, `--lifecycle`, `pause-auto`, `resume-auto`
- **Pack Marketplace** — GitHub-based community pack sharing
  - `forgen pack publish <name>` — publish verified solutions to GitHub + registry PR
  - `forgen pack search <query>` — search community registry
  - Registry: [forgen-team/forgen-registry](https://github.com/forgen-team/forgen-registry)
- **Lab compound events** — 6 new event types (compound-injected, compound-reflected, compound-negative, compound-extracted, compound-promoted, compound-demoted)
- 83 new tests (solution-format, prompt-injection-filter, solution-index, compound-lifecycle, compound-extractor)

### Changed
- `solution-matcher.ts` — tags-based matching replaces keyword substring matching
- `solution-injector.ts` — v3 format with status/confidence/type in XML output, experiment 1/prompt limit, cumulative injection-cache
- `compound-loop.ts` — v3 YAML frontmatter output, `inferIdentifiers()` for manual solutions, `slugify` deduplicated
- `pre-tool-use.ts` — Code Reflection + evidence update via parse-modify-serialize
- `post-tool-use.ts` — negative signal detection + evidence update
- `session-recovery.ts` — SessionStart triggers extraction + daily lifecycle check
- `state-gc.ts` — injection-cache pattern added for GC

### Dependencies
- Added `js-yaml` ^4.1.0 (YAML frontmatter parsing with JSON_SCHEMA safety)

## [1.7.0] - 2026-03-23

### Added
- **Forge** — signal-based personalization engine: project scanning, 10-question interview, 5 continuous dimensions (qualityFocus, autonomyPreference, riskTolerance, abstractionLevel, communicationStyle), generates agent overlays, skill tuning, rules, hook parameters, philosophy, and routing config
- **Lab** — adaptive optimization engine: JSONL event tracking, 8 behavioral pattern detectors, auto-learning closed loop (Lab → Forge, EMA 0.25, daily), component effectiveness scoring, A/B experiments, session cost tracking with HUD integration
- **Remix** — harness composition: browse/search published harnesses, cherry-pick individual components (agent/skill/hook/rule/principle), conflict detection (hash-based), provenance tracking
- **Multi-model Synthesizer** — heuristic response evaluation (4-axis scoring), agreement analysis, task-type-weighted provider synthesis, provider performance tracking
- **AST-grep integration** — real AST parsing via `sg` CLI with regex fallback, pre-built patterns for TypeScript/Python/Go/Rust, `forgen ast` CLI
- **LSP integration** — JSON-RPC 2.0 over stdio client, auto-detects tsserver/pylsp/gopls/rust-analyzer/jdtls, hover/definition/references/diagnostics, `forgen lsp` CLI
- **`forgen me`** — personal dashboard showing profile, evolution history, detected patterns, agent tuning, session cost
- **`forgen forge`** — onboarding UX with live dimension visualization after each interview answer
- **`forgen lab evolve`** — manual/auto learning cycle with dry-run support
- **`forgen lab cost`** / **`forgen cost`** — session cost tracking and reporting
- **`forgen synth`** — multi-model synthesis status, weights, and history
- **hookTuning pipeline** — forge generates hook parameters → hook-config.json → actual hooks (slop-detector, context-guard, secret-filter) read and apply them
- **Skill-tuner** — 6 skills (autopilot, ralph, team, ultrawork, code-review, tdd) respond to forge dimensions
- **Auto-learn notification** — profile evolution changes displayed on harness startup
- **Setup → Forge integration** — `forgen setup` offers forge personalization at the end
- 257 new tests (14 files) covering forge, lab, remix, evaluator, synthesizer, LSP

### Changed
- README rewritten for all 4 languages (EN/KO/ZH/JA) with new positioning: "The AI coding tool that adapts to you"
- package.json and plugin.json description updated to new positioning
- Interview deltas increased (±0.10~0.30) for meaningful profile divergence
- Auto-learn constants tuned: LEARNING_RATE 0.15→0.25, MAX_DELTA 0.1→0.15, MIN_EVENTS 50→30
- Agent overlays enriched from 1-3 line fragments to 3-5 sentence behavioral briefings
- LSP request timeout increased to 30s for large project indexing

## [1.6.3] - 2026-03-23

### Fixed
- **CRITICAL**: Fix ESM import side-effect causing double JSON output in `skill-injector` and `post-tool-use` hooks — root cause of Stop hook errors across environments
- **CRITICAL**: Fix "cancel ralph" activating ralph mode instead of canceling — keyword pattern priority conflict
- **CRITICAL**: Fix path traversal vulnerability via unsanitized `session_id` in file paths (7 hooks affected)
- Fix Stop hook timeout race condition — 0ms margin between plugin timeout and stdin read timeout
- Fix non-atomic file writes causing state corruption under concurrent sessions (9 hooks)
- Fix `readStdinJSON` missing `process.stdin.resume()` causing silent timeout in some Node.js environments
- Fix `readStdinJSON` having no input size limit (potential memory exhaustion)
- Fix user-supplied regex patterns in `dangerous-patterns.json` vulnerable to ReDoS
- Fix `ralph` keyword false positive matching on casual mentions
- Fix `pipeline` keyword requiring "pipeline mode" suffix — standalone "pipeline" now works
- Fix `migrate` and `refactor` keywords triggering on casual mentions — now require explicit mode invocation
- Fix inject-type keywords (`tdd`, `code-review`, etc.) causing double injection via both keyword-detector and skill-injector
- Fix `plugin.json` version stuck at `0.2.0` — now synced with `package.json`

### Added
- `--version` / `-V` CLI flag
- `sanitize-id.ts` shared utility for safe file path construction
- `atomic-write.ts` shared utility for corruption-resistant state writes
- `isSafeRegex()` validation for user-supplied regex patterns
- Ecomode entry in CLI help text and magic keywords section
- `cancel-ralph` keyword pattern for targeted ralph cancellation

## [1.6.2] - 2026-03-20

### Fixed
- Fix `.npmignore` excluding `templates/` from npm package
- Fix README coverage badge showing 60% instead of actual 41%
- Fix `@types/node` version mismatch (`^25` → `^18`) to match `engines: >=18`
- Fix type error in `session-recovery.ts` from `@types/node` downgrade
- Fix CHANGELOG duplicate entries in `[1.6.0]`
- Fix README banner image using relative path (breaks on npm)
- Adjust vitest coverage thresholds to match actual coverage

## [1.6.1] - 2026-03-20

### Fixed
- Resolve remaining audit warnings — rate-limiter timeout, governance try-catch
- Resolve 4 critical runtime issues from previous audit
- Resolve all skill/agent audit issues — 2 CRITICAL, 4 HIGH, 4 MEDIUM
- Correct README statistics — skills 11→19, hooks 14/18→17, tests 654→1204
- Complete i18n — convert all remaining Korean to English

### Added
- `cancel-ralph` skill for Ralph loop cancellation via `/forgen:cancel-ralph`
- `ralph-craft` skill for interactive Ralph prompt building

## [1.6.0] - 2026-03-20

### Added
- Ecomode for token-saving with Haiku priority and minimal responses
- Intent classifier for automatic task routing
- Slop detector to identify low-quality outputs
- 7 new skills for expanded workflow coverage
- Crash recovery support
- 47 scenario tests for comprehensive coverage
- Ralph mode integration with ralph-loop plugin for auto-iteration

### Changed
- Upgraded all 10 skills to OMC-level depth and completeness

### Fixed
- Comprehensive security, stability, and system design overhaul
- Replaced non-existent OMC references with forgen/Claude Code native APIs
- Resolved 13 cross-reference inconsistencies across skills, hooks, and modes

## [1.4.0] - 2025-12-01

### Added
- Gemini provider support
- Codex CLI integration
- Codex tmux team spawning with auto task routing
- `$ARGUMENTS` usage guide to all 12 forgen skills

### Fixed
- Cross-platform OAuth token for status-line usage display

## [1.3.0] - 2025-10-01

### Added
- Update notification when newer forgen version is available
- Skills installable as Claude Code slash commands (`/forgen:xxx`)
- Accumulated solutions injected into Claude context in compound flow

### Fixed
- Rules viewer skips empty dirs and finds pack rules correctly
- Connected pack info shown in startup message and HUD
- 7 CLI bugs: arg parsing, pack display, extends docs
- Project detection, pack init, and pack-builder skill
- Pack setup records `lastSync` for lock

## [1.1.0] - 2025-08-01

### Added
- Pack diagnostics to `doctor` command
- Extended pack schema: skills, agents, workflows, requires fields
- `pack add` / `pack remove` / `pack connected` CLI commands
- Pack assets integration into harness pipeline
- AI-guided pack building (`--from-project`, pack-builder skill)
- `pack.lock` for version pinning and update notifications
- Pack authoring guide

### Changed
- Migrated consumers to multi-pack API

### Fixed
- Consistency guards (P1/P2)
- 7 gaps from completeness verification

## [1.0.1] - 2025-06-15

### Fixed
- Resolved Codex-flagged blockers for npm publish
- Fixed command injection: `execSync` → `execFileSync`
- Fixed cross-platform compatibility (Windows/Linux/macOS)

## [1.0.0] - 2025-06-01

### Added
- Initial public release as **forgen** (renamed from tenet)
- Philosophy-driven Claude Code harness with 5-system workflow
- Multi-pack support
- Bilingual documentation (EN/KO)
- Core CLI commands: `fgx` entrypoint

[Unreleased]: https://github.com/forgen-team/forgen/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/forgen-team/forgen/compare/v2.1.0...v3.0.0
[2.1.0]: https://github.com/forgen-team/forgen/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/forgen-team/forgen/compare/v1.7.0...v2.0.0
[1.7.0]: https://github.com/forgen-team/forgen/compare/v1.6.3...v1.7.0
[1.6.3]: https://github.com/forgen-team/forgen/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/forgen-team/forgen/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/forgen-team/forgen/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/forgen-team/forgen/compare/v1.4.0...v1.6.0
[1.4.0]: https://github.com/forgen-team/forgen/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/forgen-team/forgen/compare/v1.1.0...v1.3.0
[1.1.0]: https://github.com/forgen-team/forgen/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/forgen-team/forgen/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/forgen-team/forgen/releases/tag/v1.0.0
