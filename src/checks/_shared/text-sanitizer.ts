/**
 * Forgen — text-sanitizer (Pathfinder D4 + D5 흡수).
 *
 * stop-guard 진입 시 lastMessage 에 한 번 적용. 두 가지 면제:
 *
 *   D4 — Structured-output 면제:
 *     observer hook / skill 산출물(<observation>...</observation>,
 *     <summary>...</summary> 등)은 *과거 사실 기록* 이지 자기 평가가 아님.
 *     본문 안의 "verified", "신뢰도 95/100" 같은 어휘에 가드가 발화하면 FP.
 *
 *   D5 — Self-paradox 면제:
 *     regex 트리거 어휘(예: 4/10, verified)를 *인용해서* 설명만 해도 본인
 *     매칭. 메타 대화/디버깅에서 가드가 무력화됨. 코드/직인용 본문은 가드
 *     판정 대상이 아니므로 stripping.
 *
 * 결정 (PATHFINDER-2026-04-30/03-unified-proposal.md):
 *  - 자연 산문 속 진짜 점수 인플레이션은 살아남아야 함 (TP 보존)
 *  - 짧은 인용("...") 만 제거; 긴 인용은 사용자 인용일 수 있어 보존
 *  - idempotent: 두 번 적용해도 결과 동일
 */

const STRUCTURED_TAGS = [
  'observation',
  'summary',
  'request',
  'investigated',
  'completed',
  'next-steps',
  'next_steps',
  'title',
  'subtitle',
  'learned',
  'discovery',
] as const;

const SHORT_QUOTE_MAX = 20;

export function sanitizeForGuard(raw: string): string {
  if (!raw) return raw;
  let s = raw;

  // 1) structured-output 블록 (open + close 쌍) 제거
  for (const tag of STRUCTURED_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    s = s.replace(re, '');
  }
  // self-closing 또는 dangling open tag 도 제거 (열렸지만 닫힘 누락 케이스)
  for (const tag of STRUCTURED_TAGS) {
    const reSelf = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    s = s.replace(reSelf, '');
    const reClose = new RegExp(`<\\/${tag}>`, 'gi');
    s = s.replace(reClose, '');
  }

  // 2) fenced code block (```...```) 제거 — 진짜 점수가 들어갈 자리 아님
  s = s.replace(/```[\s\S]*?```/g, '');

  // 3) inline backtick 코드 (`...`) 제거
  s = s.replace(/`[^`\n]*`/g, '');

  // 4) 짧은 직인용 ("...") 제거 — 길이 SHORT_QUOTE_MAX 이하만.
  //    긴 인용은 사용자 발언/실제 사실 인용이므로 가드 판정 대상에 남김.
  const shortQuoteRe = new RegExp(`"[^"\\n]{0,${SHORT_QUOTE_MAX}}"`, 'g');
  s = s.replace(shortQuoteRe, '');

  return s;
}
