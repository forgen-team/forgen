/**
 * Shared Stop hook default trigger regexes.
 *
 * R6-F2 (2026-04-22): stop-guard 와 enforce-classifier 에 리터럴 중복되던 정규식을
 * 단일 소스로 통합. 한쪽만 고치면 다른 쪽이 drift 하는 sibling-bug 패턴 차단.
 *
 * 설계 결정:
 *   - trigger 는 명시적 완료 선언 동사/어미만 — "완료" 단독 매칭 금지 (retraction 오매칭 방지).
 *   - exclude 는 retraction/negation/meta 언급 광범위 차단.
 *   - A1 spike 결과로 검증됨 (10/10 scenarios pass, FP 0%).
 */

/** Stop hook 에서 rule trigger 가 명시되지 않을 때의 기본 완료 선언 매칭. */
export const DEFAULT_STOP_TRIGGER_RE = '(완료했|완성됐|완성되|완성했|done\\.|ready\\.|shipped\\.|LGTM|finished\\.)';

/** Stop hook 기본 exclude — retraction/negation/meta 맥락 제외. */
export const DEFAULT_STOP_EXCLUDE_RE = '(취소|철회|없음|없습니다|않았|하지\\s*않|아닙니다|not\\s*yet|no\\s*longer|retract|withdraw|아직\\s*(안|아))';

/** mock/stub/fake 감지 — R-B2 전용 pattern (자가검증 주장 차단). */
export const MOCK_TRIGGER_RE = '(mock|stub|fake)';

/** mock trigger 의 exclude — 테스트 맥락은 정상. */
export const MOCK_EXCLUDE_RE = '(테스트|test|vi\\.mock|jest\\.mock|spec\\.)';
