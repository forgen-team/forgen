/**
 * 0.8.0 K1: 자동 추출 교훈의 근거 인용 검사.
 * 인용이 추출 입력(대화 요약)에 실제로 있어야 저장한다. 공백·문장부호·따옴표 차이는 무시한다.
 * "지어내지 않았다"만 보장하고 "맞다"는 보장하지 않는다(assistant 인용은 어시스턴트 자신의 결론일 수 있다).
 */
const QUOTE_MIN_CHARS = 12;

function normalizeForQuote(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s"'`“”‘’.,!?…·:;()[\]{}<>\-–—_*~、。「」『』【】〈〉《》]+/g, '');
}

export function quoteInSummary(quote: string, summary: string): boolean {
  const q = normalizeForQuote(quote);
  return q.length >= QUOTE_MIN_CHARS && normalizeForQuote(summary).includes(q);
}
