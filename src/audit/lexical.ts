/**
 * 어휘 후보 고르기 — 모델 판정 전에 비교 대상을 줄이는 결정적 1차 거름(docs/plans/2026-11-25-v1.0-plan.md 부록 B.1-4).
 * 글자 2-gram(공백 제거·소문자) 집합의 코사인. 판정이 아니라 후보 순위에만 쓴다 — 같은 뜻인지는 judge.ts 가 정한다.
 */

export function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

export function bigramSim(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (big.has(g)) n++;
  return n / Math.sqrt(a.size * b.size);
}

/** 점수 내림차순 상위 k(점수 0 은 버림). 같은 점수는 key 순으로 — 같은 입력이면 같은 후보. */
export function topK<T>(query: Set<string>, items: T[], k: number, gramsOf: (x: T) => Set<string>, keyOf: (x: T) => string): Array<{ item: T; score: number }> {
  if (k <= 0) return [];
  const scored: Array<{ item: T; score: number; key: string }> = [];
  for (const item of items) {
    const score = bigramSim(query, gramsOf(item));
    if (score > 0) scored.push({ item, score, key: keyOf(item) });
  }
  scored.sort((x, y) => y.score - x.score || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return scored.slice(0, k).map(({ item, score }) => ({ item, score: Math.round(score * 1000) / 1000 }));
}
