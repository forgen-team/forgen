# forgen 기능 채택 심층 분석 (Track B) — 2026-07-21

> 작성: feature-scout. oss-comparison-2026-07-20.md보다 한 단계 아래(명령어/UX/
> 메커니즘 단위)로 파고든 채택 계획용 분석. 기능 주장은 repo README/SKILL.md 직접
> fetch 근거. 미검증 항목 명시.

## A. 프로젝트별 기능 인벤토리 (핵심)

### OMC — github.com/Yeachan-Heo/oh-my-claudecode (CC 전용, 37.9k★)
- 슬래시: `/setup` `/team`(plan→prd→exec→verify→fix) `/autopilot` `/ralph`(verify/fix 지속)
  `/ultrawork`(`/ulw`) `/deep-interview` `/ask [provider]`(claude/codex/gemini/grok/cursor)
  `/ccg`(3모델 자문→종합) `/skill`(list/add/remove/edit/search) `/skillify`(세션→패턴추출)
  `/omc-doctor` `hud setup` `:autoresearch`.
- CLI: `omc team N:codex`(tmux 멀티프로바이더) `omc wait`(레이트리밋 자동재개) `omc hud`
  **`omc session friction report`** `omc config-stop-callback`(Telegram/Discord/Slack).
- 오케스트레이션: Team/Autopilot/Ralph/Ultrawork/UltraQA/Pipeline.
- DX: 라이브 **HUD**, **friction report**, 에이전트×모델 호환 매트릭스(premium/balanced/budget).
- sticky: Teams-first 오케스트레이션. **학습/개인화 없음**(omc.jsonc 수동).

### OMO — github.com/code-yeongyu/oh-my-openagent (멀티하네스, 66k★)
- 슬래시: `ultrawork`/`ulw` **`/goal`**(세션지속 목표, idle마다 continuation 재주입,
  completion audit이 done 할 때까지) `/start-work`(Prometheus 인터뷰) `/init-deep`(계층 AGENTS.md).
- 에이전트: Sisyphus/Hephaestus/Prometheus/Oracle/Librarian/Explore/Multimodal(모델별 매핑).
- 훅: **54+ 라이프사이클 훅**(Team 61), `disabled_hooks`. **Todo Enforcer**(idle→강제복귀).
- 컨텍스트경제: **Skill-Embedded MCP**(작업후 사라짐), ast-grep(25언어).
- 기타: Session tools+**Session Recovery**, **Hashline edits**(LINE#ID, stale-line 0), Category routing.
- sticky: 하네스 엔지니어링. **학습·개인화·측정 부재.**

### ECC — github.com/affaan-m/ECC (7 하네스, 231k★, 최대 위협)
- Continuous Learning v2: `/instinct-status` **`/instinct-import|export`** **`/evolve`**(클러스터→승급)
  `/learn-eval` **`/prune`**(30d TTL).
- instinct 라이프사이클: 신뢰도 4티어 **0.3/0.5/0.7/0.9**. 강화=반복관측+미교정+타소스동의,
  감쇠=명시교정+장기미관측+반증. 주입임계 0.7, 세션당 상한 **6**, SessionStart **8000자 캡**.
  글로벌 승급="동일 instinct 2+프로젝트 & avg신뢰도 ≥0.8". pending TTL 30일. v2.1 프로젝트 스코핑.
- 워크플로: `/plan` `/code-review` `/build-fix` `/refactor-clean` `/quality-gate`
  `/security-scan`(AgentShield 102룰) `/test-coverage` `/multi-*` 언어별 리뷰.
- 훅: beforeShellExecution/afterFileEdit/beforeSubmitPrompt/beforeTabFileRead,
  `ECC_HOOK_PROFILE=minimal|standard|strict`. GateGuard(observer-loop 5층).
- 규모: 67 에이전트, 278 스킬.
- sticky: **forgen 학습루프를 신뢰도+승급+프루닝+크로스유저 공유로 전부 재현.**

### 보조
- **claude-mem**(87.9k★): MCP `search→timeline→get_observations` 3층 progressive disclosure
  (**~10x 토큰절감**). SQLite FTS5+Chroma. **`<private>` 태그**. 회상·압축만.
- **claude-flow**(65.2k★): SONA/ReasoningBank 자기학습, HNSW, AIDefence, 라우팅 89%.
  **벤치는 전부 인프라 속도 — 코딩 tool-lift 아님.**
- **SuperClaude**(23.6k★, 저조): 30슬래시, 20페르소나, 7 adaptive mode. enforcement 약, 측정 미미.

## B. 기능 갭 매트릭스 (★=채택가치 높음)

| 능력 | forgen | OMC | OMO | ECC | 가치 |
|---|---|---|---|---|---|
| 교정→개인화 학습 | ✅4축 | ❌ | ❌ | ✅instinct | 유지(강점) |
| 신뢰도 라이프사이클 | ✅ | ❌ | ❌ | ✅0.3~0.9 | 대등 |
| **패턴단위 팀 공유** | ⚠️tarball | ❌ | ❌ | ✅import/export | **★높음** |
| **토큰효율 3층 회상** | ❌full주입 | ⚠️ | ⚠️Skill-MCP | ⚠️8000캡 | **★높음** |
| 벡터/의미 메모리 | ❌TF-IDF | ❌ | ❌ | ❌ | 중($0 제약) |
| 결정적 secret/db 가드 | ✅2층 | ⚠️ | ⚠️ | ✅ | 유지 |
| **효과측정 δ/honest-null** | ✅유일 | ❌ | ❌ | ⚠️사용자코드용 | 유지(유일 wedge) |
| **completion/idle 완료가드** | ⚠️frontier미발화 | ✅Ralph | ✅Todo/`/goal` | ⚠️ | **★중~높음(재포지셔닝)** |
| 멀티에이전트 오케스트레이션 | ⚠️기본형 | ✅Team | ✅11 | ✅multi-* | 낮음(중복회피) |
| **HUD/status/friction DX** | ❌ | ✅ | ⚠️ | ❌ | **★높음** |
| 프로젝트 스코핑 | ⚠️budget | ⚠️ | ✅AGENTS | ✅scope | 중 |
| instinct→skill 승급 | ⚠️solution | ✅skillify | ❌ | ✅evolve | 중 |
| 멀티하네스 | ⚠️2 | ❌ | ✅4 | ✅7 | 중(실측 꼴찌) |

## C. 채택 후보 Top 8 (정직-개인화+회상 기준)

1. **패턴단위 신뢰도-동반 export/import** (ECC) — tarball→패턴별 신뢰도 단위. 팀 셀링 직결.
   신뢰도는 이미 실측치 → 조작위험 0. **난이도 S~M.** ★
2. **토큰효율 3층 회상** (claude-mem) — full 주입→압축인덱스 먼저, full은 선택분만.
   ROI 루프와 시너지, context-diet 정합. **난이도 M.** ★
3. **HUD/status line + friction report** (OMC) — 회상건수·교정건수·ROI강등을 실측 카운터로
   상태줄 노출 → invisible 가치 가시화. 전부 비조작. **난이도 S~M.** ★
4. **완료가드 재포지셔닝: idle→goal 재주입** (OMO/OMC) — blocks=0 Stop훅을 "차단"에서
   "audit 통과까지 목표 재주입"으로 피벗 → 약해지는 자산 살림. **난이도 M.**
5. **TTL 프루닝 + 신뢰도 감쇠** (ECC) — 시간기반 감쇠+pending TTL. 오래된 룰 위생. **난이도 S.**
6. **프로젝트 스코핑 + 세션 주입 상한** (ECC) — project/global 태그 + 상한. budget 안정. **난이도 S.**
7. **교정 클러스터링→룰 승급 제안** (ECC evolve/OMC skillify) — 반복 교정을 명명 룰로 클러스터.
   **반드시 human-confirm.** **난이도 M~L.**
8. **`<private>` 캡처 제외 태그** (claude-mem) — 민감내용 캡처 제외. **난이도 S.**

## D. Anti-adopt (포지셔닝 위반 — 금지)

1. **claude-flow식 neural 벤치 마케팅** — 인프라 속도 숫자를 코딩 lift처럼 내면 honest-null 훼손.
2. **헤비 멀티에이전트 오케스트레이션(Team/Ralph/54+훅)** — OMC/OMO 텃밭, 배포규모 못 이김, wedge 희석.
3. **SuperClaude식 20페르소나/7모드 스프롤** — 측정없는 표면확장, honest-null과 배치.
+ 주의: ECC 자동 글로벌 승급(2+프로젝트&≥0.8)은 evidence audit + human-confirm 조건에서만.

**미검증**: OMC 19에이전트 개별명, OMO 54+훅 개별명, ECC /evolve 클러스터링 내부.
