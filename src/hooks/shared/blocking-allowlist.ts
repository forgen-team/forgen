/**
 * Blocking ALLOW-LIST — P3' (2026-04-27)
 *
 * 사용자 작업을 차단(block)할 권한을 가진 hook 의 명시적 화이트리스트.
 * 목록 외 hook 의 부정적 판정은 "관찰 신호"(log only) 로만 처리되어야 한다.
 *
 * RC5 (retro-v040): 분산된 detector 가 각자 block 결정을 내리면서 false-positive
 * 가 메인 로직 흐름까지 차단하는 회귀 패턴 발생. ALLOW-LIST 명시화로 차단 권한
 * 의 source-of-truth 를 단일화.
 *
 * v0.4.2 정책:
 *   - 본 모듈은 ALLOW-LIST 정의 + 검증 helper 만. 자동 강등(observe-only fallback)
 *     은 follow-up — 각 hook 이 점진적으로 canBlock(name) 체크하고 false 면 log
 *     로만 출력하도록 마이그레이션.
 *   - 신규 hook 추가 시 차단 권한이 필요하면 본 ALLOW-LIST 에 추가 + 본 파일의
 *     사유 문서화 의무. 본 commit diff 가 review 필수 항목.
 *
 * 멤버 사유:
 *   - stop-guard: Stop hook — false-completion 메타 가드 (자가 검증 강제)
 *   - pre-tool-use: Bash dangerous-pattern + 수동 confirm 가드
 *   - secret-filter: Write/Edit 결과의 .env / API key 노출 차단
 *   - db-guard: Bash 의 destructive DB 명령 (DROP/TRUNCATE/DELETE) 차단
 */

export const BLOCKING_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'stop-guard',
  'pre-tool-use',
  'secret-filter',
  'db-guard',
]);

/** hook 이 block 결정을 출력할 권한이 있는지. */
export function canBlock(hookName: string): boolean {
  return BLOCKING_ALLOWLIST.has(hookName);
}

/** ALLOW-LIST 에 추가하려는 hook 이 정책 문서화를 요구하는지 (lint helper). */
export function requiresPolicyDoc(hookName: string): boolean {
  return !BLOCKING_ALLOWLIST.has(hookName);
}
