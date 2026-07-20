# forgen 경쟁 지형 분석 (OSS Claude Code 컴패니언) — 2026-07-20

> 작성: oss-scout (팀 리서치). 검증 방법: 스타/활동도는 `gh api repos/...` 실측 (2026-07-20),
> 기능은 각 repo README/docs 직접 fetch. 이차 블로그 미사용.

**이름 확인**:
- **OMC** = `Yeachan-Heo/oh-my-claudecode`. 주의: `TechDufus/oh-my-claude`(ultrawork), `zephyrpersonal/oh-my-claude-code` 등 동명 포크 다수 — 원조는 Yeachan-Heo.
- **OMO** = `code-yeongyu/oh-my-opencode` → **`code-yeongyu/oh-my-openagent`로 리네임/리다이렉트**. **멀티-하네스 피벗 확정** ("omo/lazycodex … For your Codex, for your OpenCode").
- **ECC** = `affaan-m/everything-claude-code` → **`affaan-m/ECC`로 리네임**.
- 추가 3종: **claude-mem**(thedotmack), **claude-flow**(ruvnet, → `ruflo` 리네임), **SuperClaude**(SuperClaude-Org).

---

## 1. 비교 매트릭스 (프로젝트 × 축 A–H)

| | A. 세션메모리 | B. 학습루프 | C. Enforcement | D. 개인화 | E. 효과측정 | F. 컨텍스트경제 | G. 멀티하네스 | H. 품질신호 |
|---|---|---|---|---|---|---|---|---|
| **forgen** | SQLite FTS5 + solution store, TF-IDF/BM25/bigram 앙상블 주입 | **correction→4축 profile + solution 승급/자동은퇴(circuit breaker)** | **2층 하드가드**(PreToolUse 패턴블록 + Stop 응답텍스트블록, 모델의도 무관) + per-model 프로필 | **correction→4축 facet 미세조정 + 3세션 mismatch 감지** | **δ 자기효과 측정**(forgen-eval, judged 4-arm, CI/sign-test) | **ROI 강등**(surfaced≫acted_on→격리) + 4000자 budget | **CC + Codex (2)** | 1531 테스트, self-gate CI, **honest-fail-path 릴리스** |
| **OMC** | `.omc/` 상태디렉토리(플랜/핸드오프/리서치), 프로젝트 커밋 가능 | `/skillify` 품질게이트 패턴추출→자동 컨텍스트 로드 | verify/fix 루프("no silent partials"), Ralph 지속모드 | `omc.jsonc` **수동 설정**(학습 아님) | 토큰 사용량 analytics + friction report | 토큰 분석·리포트 | **CC 전용** | 활발(2026-07-19 push), 릴리스노트 규율 |
| **OMO** | Session tools(list/read/search), Session Recovery, Goal 지속 | **문서상 없음** (로드맵=코어 TS 분리·멀티하네스) | **54+ 라이프사이클 훅**(팀모드 61), **Todo Enforcer**(idle→강제복귀=완료가드) | **문서상 없음** | Prometheus Planner completion audit(체계적 벤치 없음) | **Skill-Embedded MCP**(작업후 사라짐→컨텍스트 청결) | **OpenCode/Codex/Pi/CC (멀티, 피벗중)** | README에 테스트/CI 미기재, 877 open issues |
| **ECC** | `session-data/` + `skills/learned/`, SessionStart 훅 자동주입 | **Continuous Learning v2 = instinct 신뢰도스코어**: `/instinct-status/import/export`, `/evolve`(instinct→skill 승급), `/learn-eval`, `/prune`(30d TTL) | **GateGuard**(rm/force-checkout 블록), secret탐지(sk-/ghp_/AKIA), `.env` 읽기차단, **AgentShield 102룰** | voice profile, instinct 신뢰도(임계 0.7), PM 자동감지, `ECC_HOOK_PROFILE` | eval-harness/verification-loop/quality-gate, 80% 커버리지 강제 | SessionStart 8000자 캡, **instinct 주입 max 6**, MCP<10개 권고 | **CC/Cursor/Codex/OpenCode/Copilot/Zed/Antigravity (7)** | **997 테스트, 주간 릴리스**, MIT |
| **claude-mem** | **SQLite FTS5 + Chroma 벡터**, 3층 검색(search→timeline→get_observations) | **압축·의미요약만**(룰추출/교정캡처 없음) | **훅=컨텍스트 주입 전용, 블록 안함**(5 라이프사이클) | **없음** | **없음**(~10x 토큰절감만) | **3층 progressive disclosure ~10x 절감**, `<private>` 태그 | CC/OpenCode/Antigravity/OpenClaw/Desktop (5) | core-dev/community-edge 브랜치, 버그리포트 자동화 |
| **claude-flow** | **AgentDB HNSW 벡터** + RVF save/restore, RAG(hybrid/graph-hop) | **SONA neural / ReasoningBank / trajectory learning = 자기학습** | 27훅, **AIDefence**(prompt-injection/PII 14종) | 네임스페이스 개인 메모리("내 색은 indigo 기억") | **89% 라우팅정확도, 벡터속도 벤치**(단 코딩/SWE 벤치 없음) | Cost-Tracker(예산/알림), agent별 토큰예산 | **CC + Codex + 5 LLM 프로바이더 failover** | 8.1M DL 주장, `ruflo verify`(서명검증), 804 open issues |
| **SuperClaude** | Case-Based Learning(Serena MCP), `/load` `/save` | ReflexionMemory 에러학습(부분), **체계적 교정캡처 없음** | **약함 — directive만, 하드게이트 없음** | **20 에이전트 / cognitive persona / 7 adaptive mode** | 미미(source credibility 0-1만) | MCP 30-50% 토큰절감 | Python/npm/TS(v5 예정) | GH Actions 배지, **활동 저조(2026-06-13 마지막 push)** |

---

## 2. 프로젝트별 요약 + 스타/활동도 (gh api, 2026-07-20)

- **OMC — 37,898★, MIT, 활발**(2026-07-19 push, open issues 1). "Teams-first 멀티에이전트 오케스트레이션". 19 에이전트/39 스킬, Team(canonical)/Ultrawork/Ralph/UltraQA. `/skillify` 패턴추출은 있으나 교정→개인화 학습은 없음. 개인화는 `omc.jsonc` 수동. **CC 전용.** forgen과 정면충돌 아님(보완 관계 성립).
- **OMO — 66,181★, NOASSERTION 라이선스, 매우 활발**(2026-07-19 push, **877 open issues**). oh-my-opencode→**oh-my-openagent 멀티하네스 피벗 확정**(OpenCode Ultimate판 + Codex Light판). 강점은 54+훅·Todo Enforcer·Skill-Embedded MCP. **학습루프·개인화·효과측정 전부 문서상 부재** — 오케스트레이션/하네스 엔지니어링 특화.
- **ECC — 231,241★, MIT, 주간 릴리스**(2026-07-19 push, 997 테스트). "에이전트 하네스 성능 최적화 시스템". **가장 위협적**: Continuous Learning v2가 신뢰도스코어 instinct + `/evolve` 승급 + import/export 공유 + 30d 프루닝으로 **forgen의 학습루프를 사실상 전부 재현 + 크로스유저 공유까지**. 7개 하네스, AgentShield 102룰, 80% 커버리지. 거대 배포력.
- **claude-mem — 87,873★, Apache-2.0, 활발**(2026-07-19 push). 세션 메모리 특화의 정점. SQLite FTS5+Chroma 벡터, 3층 토큰효율 검색(~10x 절감). **압축·회상만 하고 룰추출/교정/개인화/효과측정은 안 함** — forgen이 권장 페어링으로 걸어둔 상보 관계 여전히 유효.
- **claude-flow(ruflo) — 65,203★, MIT, 활발**(2026-07-19 push, 804 open issues). "에이전트 메타-하네스". HNSW 벡터메모리 + SONA/ReasoningBank 자기학습 + AIDefence. **벤치 숫자를 공개**(89% 라우팅, 벡터속도) — 단 코딩/SWE-bench 아닌 인프라 성능. 규모 크나 issue 부채 큼.
- **SuperClaude — 23,578★, MIT, 활동 저조**(마지막 push 2026-06-13, 5주+ 정체). cognitive persona/7 adaptive mode가 특징이나 enforcement 약하고 학습 체계 미미. 상대적 후퇴 중.

---

## 3. forgen이 지는 지점

1. **배포/채택 규모 — 압도적 열세.** 경쟁자 23k~231k★. ECC(231k)·claude-mem(88k)는 이미 카테고리 디폴트. "쓸수록 낫다"가 사실이어도 사용자가 없으면 축적 데이터가 안 쌓임.
2. **ECC가 forgen 학습루프를 추월.** instinct 신뢰도스코어(=forgen trust lifecycle)에 더해 **`/instinct-import/export` 크로스유저 공유**를 이미 출시. forgen의 export는 tarball 통짜이고 패턴별 신뢰도 공유는 없음. ECC는 `/evolve`(승급)+`/prune`(30d)까지 갖춰 라이프사이클도 대등. **주간 릴리스 + 997 테스트**로 실행속도도 우위.
3. **멀티하네스 최약체.** forgen=CC+Codex(2). ECC=7, claude-mem=5, OMO=4, claude-flow=CC+Codex+5프로바이더. ADR-010이 multi-host를 moat로 잡았지만 실제 커버리지는 꼴찌.
4. **메모리 검색 성숙도.** claude-mem 3층 토큰효율 검색(~10x)·Chroma 벡터, claude-flow HNSW가 forgen TF-IDF/BM25/bigram보다 코퍼스 성장 시 recall 우위.
5. **오케스트레이션.** OMC/OMO/claude-flow 멀티에이전트가 forgen `/forge-loop`(기본형)보다 월등. OMO Todo Enforcer는 idle→강제복귀까지.
6. **"아무도 숫자 안 낸다"가 부분적으로 반증됨.** claude-flow는 벤치 숫자 공개(89% 등), ECC는 커버리지 강제. forgen 주장은 "코딩 결과물에 대한 tool-lift를 judged eval로 재는 곳은 없다"로 **정밀화 필수**.

## 4. forgen이 이기는 지점 (실측 근거 있는 차별점만)

1. **자기효과 δ 측정 — 유일.** judged 4-arm, δ=+0.151 W, 95%CI[+0.118,+0.184], sign-test p=1.04e-14. 경쟁자 중 "이 도구가 코딩을 실제로 돕는가"를 재는 곳 없음 — ECC eval-harness는 사용자 코드용, claude-flow 벤치는 인프라 속도용. (단 이 수치는 Sonnet-4.6/Codex 시대 측정 — Opus 4.8은 δ 100% injection, Sonnet 5 미측정. R2 전까지 무주장이 정직.)
2. **Honest-fail-path 릴리스 규율 — 유일.** ψ 게이트 PASS 주장 철회, 미측정 모델 효과 무주장. 경쟁자 전부 상승 마케팅.
3. **결정론적 2층 하드가드.** PreToolUse 패턴블록 + Stop 응답텍스트 가드가 모델 의도 무관 발화. ECC GateGuard가 가장 근접하나 forgen은 응답텍스트 가드 + **측정기반 per-model 프로필**(opus-4.8=advise, 미측정=block)까지 — 이 캘리브레이션은 유일.
4. **acted-on ROI 루프.** surfaced≫acted_on 솔루션 자동강등→격리. 경쟁자·native 메모리에 없는 루프.
5. **correction→4축 profile + 3세션 mismatch 감지.** ECC instinct/OMC config보다 원칙적인 개인화 모델(pack+facet, 충돌해소 session>personal>pack).

## 5. 채택 후보 갭 Top 5

| # | 기능 | 배울 곳 | 예상 난이도 | 근거 |
|---|---|---|---|---|
| 1 | **패턴별 신뢰도 동반 크로스유저/팀 공유** (통짜 tarball → `import/export` 단위 + confidence) | **ECC** `/instinct-import/export` | 중 | 팀 셀링(secondary 오디언스)에 직결 |
| 2 | **토큰효율 3층 검색** (search→timeline→full, ~10x) | **claude-mem** | 중 | forgen은 매칭 솔루션 full 주입 → budget 압박. ROI 루프와 시너지 |
| 3 | **벡터/의미 메모리** (Chroma/HNSW) TF-IDF 보완 | **claude-mem / claude-flow** | 중상 | 코퍼스 성장 시 recall. 단 로컬·$0 제약 유지 필요 |
| 4 | **멀티하네스 확장** 최소 opencode + Cursor 어댑터 | **ECC** DRY 어댑터 패턴 / **claude-mem** `--ide` 플래그 | 상 | moat로 선언했으나 실측 꼴찌 |
| 5 | **forge-loop 견고화** idle/todo enforcer로 완료가드 | **OMO** Todo Enforcer / **OMC** Ralph | 중 | Stop훅 자산과 결합 용이 |

## 6. 포지셔닝 리스크 업데이트

- **ECC 학습루프 수렴 = 심각·확정.** 셀링을 넘어 **출시 완료**: 신뢰도스코어 instinct + 승급 + 프루닝 + 크로스유저 공유. 231k★·주간릴리스로 "학습+everything" 사분면 압도 점유. → ADR-010의 "학습을 **증명**한다"(δ·acted-on·honest-fail) 피벗이 **유일한 방어선**임을 확인.
- **"아무도 숫자를 안 낸다" 주장 정밀화 필수.** "코딩 결과물에 대한 도구 기여도(tool-lift)를 judged eval로 재는 곳은 없다"로 좁혀야 논파 안 됨.
- **enforcement 수렴.** ECC GateGuard·claude-flow AIDefence·OMO Todo Enforcer 보유. 잔존 moat는 **결정론적 secret/db 가드 + 측정기반 per-model 캘리브레이션**이지 완료-블로킹이 아님.
- **claude-mem 페어링 여전히 유효.** 개인화·학습·측정 전무 → "claude-mem 사용자에게 forgen을 add-on으로" 진입이 현실적 GTM.

**한 줄 결론**: 학습·enforcement·메모리·오케스트레이션 4개 축 전부 수렴/추월당했고, 방어 가능한 유일 wedge는 **"학습이 실제로 돕는지 δ로 측정 + 정직한 실패공시 + acted-on ROI + 결정론적 가드"** — ADR-010 피벗 방향이 옳다. 리스크는 그 wedge마저 배포력(231k★ vs npm)과 미측정(Sonnet 5) 때문에 시간 싸움이라는 점.

**Repo URL**: OMC github.com/Yeachan-Heo/oh-my-claudecode · OMO github.com/code-yeongyu/oh-my-openagent · ECC github.com/affaan-m/ECC · claude-mem github.com/thedotmack/claude-mem · claude-flow github.com/ruvnet/claude-flow · SuperClaude github.com/SuperClaude-Org/SuperClaude_Framework
