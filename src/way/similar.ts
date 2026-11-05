/** 문자 bigram Dice 유사도. 한국어·영어 공통, 외부 의존 없음. */
function grams(s: string): Map<string, number> {
  const t = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
  return m;
}

export function similarity(a: string, b: string): number {
  const ga = grams(a); const gb = grams(b);
  let inter = 0; let na = 0; let nb = 0;
  for (const v of ga.values()) na += v;
  for (const v of gb.values()) nb += v;
  if (!na || !nb) return 0;
  for (const [k, v] of ga) inter += Math.min(v, gb.get(k) ?? 0);
  return (2 * inter) / (na + nb);
}

export function isDuplicate(text: string, others: string[], threshold = 0.6): string | null {
  for (const o of others) if (similarity(text, o) >= threshold) return o;
  return null;
}
