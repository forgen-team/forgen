/**
 * 룰 문장 "같은 문장" 판정용 정규화 (2026-11 재설계 D4).
 *
 * 생성 시 중복 판정, `forgen rule dedupe`, `forgen status --health` 가 모두 이 함수 하나를 쓴다.
 * 의미가 달라질 수 있는 것(숫자, 부정어, 문장 중간의 문장부호)은 건드리지 않는다 —
 * 공백 차이와 끝의 마침표·느낌표·물음표만 같은 문장으로 본다.
 */
export function normalizePolicy(policy: string): string {
  return policy
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?。．！？\s]+$/u, '')
    .trim();
}
