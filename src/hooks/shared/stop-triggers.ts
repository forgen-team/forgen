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

/** mock trigger 의 exclude — 테스트 맥락은 정상. */
export const MOCK_EXCLUDE_RE = '(테스트|test|vi\\.mock|jest\\.mock|spec\\.)';

// ── critic-review 룰 전용 트리거 (2026-07-22) ─────────────────────────────────

/** "리뷰/검토 생략" 시그널 (한/영). 외래어(스킵/패스)·구어(안 하고) 포함 — 리뷰 SEV-3 (a). */
const REVIEW_SKIP = '(리뷰|검토)[^.!?\\n]{0,8}(생략|건너뛰|없이|스킵|패스|안\\s*하고)|skip(?:ping|s)?\\s+(?:the\\s+)?review';
/** "다음으로 넘어감" 진행 시그널 (활용형 커버). */
const MOVE_ON = '넘어가|넘어갑|넘어갔|넘어감|넘어갈|다음\\s*(작업|기능|단계|스텝|것|이터레이션)|move\\s+on|next\\s+(step|task|feature)|proceed';

/**
 * "리뷰 생략" AND "다음으로 넘어감" 이 함께 있을 때만 발화하는 결합 트리거.
 * 두 lookahead 로 conjunction — 한쪽만 있는 경고/질문/신중 응답은 미발화(FP 0).
 */
export const SKIP_REVIEW_TRIGGER_RE = `(?=[\\s\\S]*?(?:${REVIEW_SKIP}))(?=[\\s\\S]*?(?:${MOVE_ON}))`;

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
