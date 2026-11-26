/** `forgen --help` 한국어판(0.9.1 #10) — 설정 locale 이 ko 일 때. 영어판은 cli.ts printHelp. 두 판은 같은 명령을 같은 순서로 담는다. */
export function helpKo(version: string): string {
  return `
  Forgen v${version}
  Claude 를 쓸수록 나를 더 잘 아는 AI.

  쓰는 법:
    forgen                          Claude 를 forgen 과 함께 실행(기본)
    forgen "요청"                   요청과 함께 시작
    forgen --resume                 지난 세션 이어서
    forgen --runtime claude|codex   실행할 런타임 고르기

  명령:
    forgen forge [--onboarding|--profile|--reset]
                                    개인화 입구(처음이면 질문 4개 온보딩)
    forgen inspect [profile|rules|corrections|session]
                                    지금 상태 보기(evidence → corrections 별칭)
    forgen rule <list|suppress|activate|scan|health-scan|classify>
                                    룰 관리 — 보기·끄기·켜기·점검·분류 (자세히: forgen rule help)
    forgen status [보기]            한 화면 상태 — 보기:
                                      --compound  축적 지식 상태 + 최근 불러온 것
                                      --profile   4축 프로필 + 최근 교정
                                      --rules     켜진 룰
                                      --blocks [N] 최근 차단: 룰·이유·고치는 법
                                      --overview  자세한 대시보드(훅·이력·곡선)
                                      --live      실시간 훅 이벤트
                                      --turn      이번 턴에 해당하는 룰과 그 근거 교정
                                      --health    룰 건강: 교정→룰→세션에 넣음→점검, 검토 대기, 날짜별 표(--json)
    forgen audit [--folder p] [--json] [--timing] [--no-model]
                                    내 Claude 기억 점검(읽기만): 잘림·토큰·같은 문장·없는 것을 가리킴·섞임 + 모델: 같은 뜻·부딪힘
                                    → 첫 화면에 가장 중요한 발견 · ~/.forgen/audit/<시각>/audit.html
    forgen audit tokens [--folder p]  폴더별 세션 시작 토큰(아무것도 쓰지 않음)
    forgen audit recurrence [--since d] [--until d] [--lookback 30d] [--limit N] [--no-model]
                                    지난 대화 기록에서 같은 교정을 다시 한 횟수(내 컴퓨터의 claude CLI 판정, 저장)
    forgen audit review [--kind dup|conflict|mix] [--import f] · forgen audit score   모델 판정 25개를 직접 확인 → 일치율
    forgen fix --list | <id> [--apply] | --kind <종류|all> --apply | --undo <id|all> | --report
                                    처방(합치기·지우기·옮기기·범위·짧게·MEMORY.md·기억 추가·겹침·끄기), 백업 → ~/.forgen/backups/fix-<시각>/
    forgen audit baseline [--freeze [--force]]  같은 말 다시 하기 기준값 고정(직전 6주 + 12주) → ~/.forgen/audit/baseline.json
    forgen workflows install|list   forgen 워크플로 틀을 .claude/workflows/ 에 설치
    forgen changelog                지난 릴리스 태그 뒤 커밋 요약
    forgen compound                 축적 지식 관리
    forgen init                     프로젝트 초기화(+ 시작 솔루션)
    forgen config hooks             훅 관리
    forgen mcp                      MCP 서버 관리
    forgen skill promote|list       스킬 관리(promote 는 표준 SKILL.md, --install → ~/.claude/skills)
    forgen project add <key> <folder...> [--alias old]   폴더 여러 개(저장소 아니어도)를 한 프로젝트로 묶기
    forgen eval recall-sample [--n 100] | recall-label | recall-score   솔루션 문턱용 내 요청 표본(내 컴퓨터에서만)
    forgen project list|remove <key>|which [folder]      프로젝트 보기·지우기·이 폴더가 어느 프로젝트인지
    forgen way [--all|--json]       내 일하는 방식 한 화면: 내가 말한 룰 vs 추론한 룰, 강제 vs 안내
    forgen way export --target <agents-md|claude-rules|skill|system-prompt|gemini|cursor|workflow|json>
                                    [--project k] [--budget n] [--out dir] [--force]  (--out 없으면 화면에만)
    forgen way import <file.json> [--apply]       고친 내용을 룰로 되돌려 넣기(기본은 미리보기)
    forgen way collect-memory [--dir path] [--apply]   Claude 메모 feedback_*.md 를 룰 후보로 읽기
    forgen way draft <skill|workflow> "<주제>" [--project k] [--out dir] [--no-llm]
                                    관련 룰·솔루션·교정을 모아 SKILL.md 나 워크플로 체크리스트 초안(격리된 Haiku 호출, --out 없으면 미리보기)
    forgen notepad show|add|clear   세션 메모장
    forgen doctor [--quick|--prune-state|--repair]   시스템 진단(훅·MCP·상태줄을 실제로 돌려 봄, 실패면 exit 1)
    forgen uninstall                forgen 지우기
    forgen install [claude|codex|opencode|both]   Claude Code·Codex·OpenCode 에 forgen 등록(훅·MCP·상태줄)
    forgen statusline [install]     Claude Code 상태줄, install 은 settings.json 에 등록
    forgen block <id> --ok|--fp     차단 기록 판정(맞음 / 잘못 막음)
    forgen learn fix-up|quarantine|fitness   솔루션 정리
    forgen maintenance --backfill   관측 기록 채우기
    forgen dev <probe-workflow|migrate|regress-map>   개발·정비 도구

  룰 줄임 명령(\`forgen rule <sub>\` 과 같음, 스크립트용으로 남김):
    forgen classify-enforce         = rule classify
    forgen rule-meta-scan           = rule health-scan
    forgen lifecycle-scan           = rule scan
    forgen suppress-rule <id>       = rule suppress
    forgen activate-rule <id>       = rule activate

  편집기 연결(편집기·플러그인이 부름, 직접 쓰지 않음):
    forgen opencode-guard           OpenCode 도구 호출마다 점검
    forgen opencode-context         OpenCode 대화 압축 때 넣을 맥락

  기본 실행:
    Claude(또는 Codex)를 개인화·자동 축적·안전 훅으로 감싸 실행합니다.
`;
}
