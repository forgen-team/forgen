/**
 * Shared Stop hook default trigger regexes.
 *
 * R6-F2 (2026-04-22): stop-guard 와 enforce-classifier 에 리터럴 중복되던 정규식을
 * 단일 소스로 통합. 한쪽만 고치면 다른 쪽이 drift 하는 sibling-bug 패턴 차단.
 *
 * 설계 결정:
 *   - DEFAULT trigger 는 명시적 완료 선언 동사/어미만 — "완료" 단독 매칭 금지 (retraction 오매칭 방지).
 *   - exclude 는 retraction/negation/meta 언급 광범위 차단.
 *   - A1 spike 결과로 검증됨 (10/10 scenarios pass, FP 0%).
 *
 * 2026-07-22 (강제층 실측 갭 — critic-review 룰 한정 수정, 리뷰 SEV-2 반영):
 *   완료 키워드 없이 "리뷰 생략하고 다음으로 넘어감" 하는 응답이 완료-키워드 트리거를
 *   우회해 critic-룰(청크마다 리뷰) 강제가 새던 갭. 이를 닫되:
 *   - skip-signal 은 DEFAULT 에 섞지 않고 **critic-review 룰 전용** CRITIC_STOP_TRIGGER 로 분리
 *     (e2e·mock-as-proof 등 다른 완료룰 오염 방지, 리뷰 SEV-2 #3).
 *   - "리뷰 생략" AND "다음으로 넘어감" **결합(conjunction)** 으로만 발화 → 경고/질문/신중
 *     응답 FP 제거 (리뷰 SEV-2 #1).
 *   - exclude 에 부정/금지/질문형(말고·안 했·should not·될까요…) 보강 (리뷰 SEV-2 #2).
 *   - 기존 baked 룰(b0aabac3)은 `forgen rule migrate-triggers` 로 재-bake 해야 적용 (리뷰 SEV-2 #4).
 */

/** Stop hook 기본 완료 선언 매칭 (완료 동사/어미만 — skip-signal 미포함). */
export const DEFAULT_STOP_TRIGGER_RE = '(완료했|완성됐|완성되|완성했|done\\.|ready\\.|shipped\\.|LGTM|finished\\.)';

/** Stop hook 기본 exclude — retraction/negation/meta 맥락 제외. */
export const DEFAULT_STOP_EXCLUDE_RE = '(취소|철회|없음|없습니다|않았|하지\\s*않|아닙니다|not\\s*yet|no\\s*longer|retract|withdraw|아직\\s*(안|아))';

/** mock/stub/fake 감지 — R-B2 전용 pattern (자가검증 주장 차단). */
export const MOCK_TRIGGER_RE = '(mock|stub|fake)';

/**
 * mock trigger 의 exclude — 테스트 맥락은 정상. 2026-10-07: 문장 단위 판정으로 바뀌며 추가 —
 * mock 을 **벗어나는** 서술(해소·제거·대체·라이브로 재검증·실제 실행·아님)은 위반 주장이 아니다(실측 오탐 예시 근거).
 */
export const MOCK_EXCLUDE_RE =
  '(테스트|test|vi\\.mock|jest\\.mock|spec\\.|해소|제거|걷어|대체|교체|대신|라이브|live|실제\\s?(실행|데이터|환경)|실\\s?(데이터|영상|환경)|아니|않|없이|없습니다|금지|룰|규칙|instead|real\\s|^\\s*\\|)';
// ↑ `^\s*\|`: 마크다운 표 행 — 문장 단위 판정에서 행 하나가 한 문장이라, 룰 이름을 표 칸에 적은 것만으로 걸리던 오탐(v0.6.7 실사용).

// ── critic-review 룰 전용 트리거 (2026-07-22) ─────────────────────────────────

/** "리뷰/검토 생략" 시그널 (한/영). 외래어(스킵/패스)·구어(안 하고) 포함 — 리뷰 SEV-3 (a). */
const REVIEW_SKIP = '(리뷰|검토)[^.!?\\n]{0,8}(생략|건너뛰|없이|스킵|패스|안\\s*하고)|skip(?:ping|s)?\\s+(?:the\\s+)?review';
/** "다음으로 넘어감" 진행 시그널 (활용형 커버). */
const MOVE_ON = '넘어가|넘어갑|넘어갔|넘어감|넘어갈|다음\\s*(작업|기능|단계|스텝|것|이터레이션)|move\\s+on|next\\s+(step|task|feature)|proceed';

/**
 * "리뷰 생략" AND "다음으로 넘어감" 이 함께 있을 때만 발화하는 결합 트리거.
 * 두 lookahead 로 conjunction — 한쪽만 있는 경고/질문/신중 응답은 미발화(FP 0).
 */
// 2026-10-07: `^` 고정 — 없으면 엔진이 모든 시작 위치에서 lookahead 를 다시 훑어 O(n²)(40k자 1s). m 플래그 없이 쓰므로 메시지 시작 1회만.
export const SKIP_REVIEW_TRIGGER_RE = `^(?=[\\s\\S]*?(?:${REVIEW_SKIP}))(?=[\\s\\S]*?(?:${MOVE_ON}))`;

/**
 * critic-review 룰 트리거 = 완료 선언 OR 리뷰생략-넘어감.
 * (완료 시점 + skip 시점 양쪽에서 critic 강제. e2e/mock 룰엔 부여 안 함 — DEFAULT 만 사용.)
 */
export const CRITIC_STOP_TRIGGER_RE = `(${DEFAULT_STOP_TRIGGER_RE}|${SKIP_REVIEW_TRIGGER_RE})`;

/**
 * critic 트리거 exclude — 기본 retraction + 부정/금지/질문형 + 숙고형 보강.
 * 주의: bare `안\s*하` 는 넣지 않는다 — "리뷰 안 하고 넘어감"(실제 skip TP)을 죽이므로.
 * retraction 은 과거형 `안\s*했`(안 했다)만 배제. 숙고형(할지|여부|고민…)은 skip 단언이
 * 아니라 결정 전 단계라 배제 (리뷰 SEV-3 (a)).
 */
export const CRITIC_STOP_EXCLUDE_RE =
  '(?:' + DEFAULT_STOP_EXCLUDE_RE +
  '|말고|마세요|말라|안\\s*했|안\\s*해|안\\s*할|안\\s*돼|안\\s*됩|하세요|반드시|위험|should\\s*not|shouldn|don.?t|될까요|까요\\?|할지|갈지|여부|고민|결정하)';

// ── 2026-10-07 룰별 발동 조건 분리 (30일 대화 2,216턴 실측 근거) ─────────────────────────
// 실측: 모든 완료 룰이 같은 완료 어휘에 반응해 (a) 실제 답변("끝났습니다")엔 거의 안 걸리고(1.4%)
// (b) 걸릴 땐 룰 4개가 동시에 걸렸으며 (c) mock 룰은 단어만 있어도 발동해 무한 반복(7회)했다.
// 각 룰은 그 룰이 지키려는 **행동의 주장**에만 반응한다.

/** 완료 선언 — 기존 + 실제 한국어 완료 보고 어휘(끝냈/끝났습니다/마쳤/마무리했/완료됐…). */
export const COMPLETION_TRIGGER_V2_RE =
  '(완료했|완료됐|완료되었|완료입니다|완성됐|완성되|완성했|끝냈|끝났습니다|마쳤|마무리했|done\\.|ready\\.|shipped\\.|LGTM|finished\\.)';

/** 작업 청크 종료(커밋·머지·배포) — critic 룰 전용. */
const SHIP_VERBS = '커밋했|머지했|배포했|배포가 끝|푸시했|발행했|릴리스했|merged|committed|pushed|released|shipped';
/**
 * 청크 경계 증거 — 커밋 해시(숫자와 a-f 를 모두 포함, 단어 경계) 또는 커밋·PR 언급·배포 동사·리뷰 생략.
 * critic 룰은 이것이 메시지에 있을 때만 판정한다(상태 보고·대기 알림 제외). 트리거 lookahead 가 아니라
 * verifier 의 only_if 로 선형 검사(critic SEV-2: lookahead 결합은 30k자에서 2.8s).
 * 'feedback'(숫자 없음)·'20261007'(a-f 없음) 은 해시가 아니다.
 */
export const CHUNK_EVIDENCE_RE =
  `(\\b(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\\b|커밋|commit|PR\\s?#?\\d+|${SHIP_VERBS}|${REVIEW_SKIP})`;

/** critic 룰: 완료 선언 OR 커밋·머지·배포 OR (리뷰 생략 AND 넘어감). */
export const CRITIC_TRIGGER_V2_RE = `(${COMPLETION_TRIGGER_V2_RE}|${SHIP_VERBS}|${SKIP_REVIEW_TRIGGER_RE})`;

/** mock 룰: 단어가 아니라 "그걸로 검증/통과했다"는 **주장**. 순서 양방향, 한 문장(40자) 안. */
export const MOCK_CLAIM_TRIGGER_RE =
  '((mock|stub|fake|목\\s?객체|스텁)[^.!?\\n]{0,40}(검증|통과|확인했|확인됐|테스트\\s?(했|됐|완료)|verified|passed|green)|(검증|통과|verified|passed)[^.!?\\n]{0,40}(mock|stub|fake|목\\s?객체|스텁))';

/** 격리 검증 룰: 실 데이터·프로덕션·live 에 대고 **돌렸다**는 주장. */
export const LIVE_RUN_TRIGGER_RE =
  '((실\\s?(데이터|환경|홈|쿼터|세션)|프로덕션|운영\\s?환경|live|라이브|~\\/\\.forgen|~\\/\\.claude)[^.!?\\n]{0,40}(돌렸|실행했|적용했|검증했|반영했|ran|executed|applied))';

/**
 * 구현 먼저 금지 룰: **합의 없이 바로 구현했다**는 보고 — "바로/먼저/일단 구현했", "구현부터 했".
 * 일반 구현 보고("구현했습니다")까지 걸면 30일 실측 5.8% 턴에서 자기 신고 루프가 돌아 노이즈만 늘었다.
 * 결정 문서·합의 언급이 메시지에 있으면 준수로 본다(부정 lookahead).
 */
export const IMPL_REPORT_TRIGGER_RE =
  '^(?![\\s\\S]*(결정\\s?문서|docs\\/decisions|ADR-\\d|합의(한|된|했|를\\s?거)|decision\\s+doc))[\\s\\S]*?((바로|먼저|곧바로|일단|우선)\\s?(구현|코드\\s?(를\\s?)?(수정|작성|변경))(했|해\\s?(뒀|놨|버렸))|구현부터\\s?(했|진행했|시작했))';

/** 기능을 빼는/보류하는 제안 어휘 — 주제 룰 결합용. */
// 명사로 쓰이는 '보류'(라벨 값)·'삭제'(기능 설명)는 실측 오탐이라 제외하고, 제안·결정 활용형만 본다.
export const DROP_PROPOSAL_RE = '빼(자|는\\s?게|고|기로|면|겠|도\\s?될|야)|뺄|제외(하자|하고|하는\\s?게|할|하면|합니다|했|하기로)|드롭|미루(자|는\\s?게|고|기로)|drop|remove|defer';

/** 주제 룰: 룰이 명시한 기능 이름(topics) 중 하나 AND 빼기 제안. */
export function topicDropTrigger(topics: string[]): string {
  const esc = topics.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'));
  // 같은 문장(60자 안)에서 기능 이름과 빼기 제안이 함께 나올 때만 — 메시지 전체 결합은 실측에서 무관한 응답을 잡았다.
  const t = `(?:${esc.join('|')})`;
  return `(${t}[^.!?\\n]{0,60}(?:${DROP_PROPOSAL_RE})|(?:${DROP_PROPOSAL_RE})[^.!?\\n]{0,60}${t})`;
}
