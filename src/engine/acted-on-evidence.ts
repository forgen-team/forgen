/**
 * acted_on 신호의 증거 기준 (D6). "솔루션이 실제로 행동에 쓰였다"고 말하려면 우연히 겹친 단어로는 부족하다.
 *
 * 예전 판정은 솔루션 태그 중 **하나라도** 텍스트에 부분 문자열로 들어 있으면 acted_on 이었다. 사용자의 다음 프롬프트
 * (prompt-keyword)가 같은 주제를 이어 말하기만 해도 걸려, 실데이터에서 오탐 솔루션 하나에 16건이 쌓였다. 이 기준은:
 *  - 식별자(함수·파일 이름 리터럴, 4자 이상)가 들어 있으면 증거,
 *  - 아니면 **흔하지 않은 태그가 서로 다른 2개 이상** 들어 있어야 증거 (흔한 태그·3자 미만은 세지 않는다).
 * 영문 태그는 단어 경계로, 한글 태그는 부분 문자열로 찾는다.
 */
import { COMMON_TAGS } from './scoring-algorithms.js';

export const MIN_DISTINCT_TAG_HITS = 2;

/** camelCase 경계에 `_` 를 넣어(testDouble → test_double) snake_case·kebab-case 와 같은 모양으로 맞춘다. */
function splitCamel(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** `test-double`·`test_double`·`testDouble`·`test double` 은 같은 태그다. 영문은 단어 경계(`_` 도 경계), 한글은 부분 문자열. */
function tagInText(tag: string, text: string): boolean {
  const t = tag.toLowerCase();
  if (/^[a-z0-9_ -]+$/.test(t)) {
    const parts = t.split(/[-_ ]+/).filter(Boolean);
    if (parts.length === 0) return false;
    return new RegExp(`(^|[^a-z0-9])${parts.join('[-_ ]?')}($|[^a-z0-9])`).test(splitCamel(text));
  }
  return text.toLowerCase().includes(t);
}

/** 한글 등 비ASCII 태그는 2자(캐시·배포)부터, 영문은 3자부터 센다. */
function taggable(t: string): boolean {
  return /[^\x00-\x7f]/.test(t) ? t.length >= 2 : t.length >= 3;
}

export function actedOnEvidence(
  sol: { tags: readonly string[]; identifiers: readonly string[] },
  text: string,
): { ok: boolean; hits: string[] } {
  const lower = text.toLowerCase();
  const idHits = sol.identifiers.filter((id) => id.length >= 4 && lower.includes(id.toLowerCase()));
  if (idHits.length > 0) return { ok: true, hits: idHits };
  const tagHits = [...new Set(sol.tags)].filter((t) => taggable(t) && !COMMON_TAGS.has(t.toLowerCase()) && tagInText(t, text));
  return { ok: tagHits.length >= MIN_DISTINCT_TAG_HITS, hits: tagHits };
}
