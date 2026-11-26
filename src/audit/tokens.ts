/**
 * 토큰 로컬 근사 (docs/plans/2026-11-25-v1.0-plan.md §2.3): ASCII 4자 ≈ 1토큰, 그 밖의 글자 1자 ≈ 0.9토큰.
 * 토큰 세기 API 는 쓰지 않는다. 계수 보정(대화 기록 usage 와 맞춤)은 다음 덩어리에서 한다.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) < 128) ascii++;
    else other++;
  }
  return Math.round(ascii / 4 + other * 0.9);
}
