/**
 * 사용자 메시지가 어시스턴트 행동에 대한 교정일 가능성 점수 (순수, 결정론).
 *
 * 쓰임: transcript 요약에서 교정 메시지와 그 앞뒤를 우선 보존한다(D3). 추출 프롬프트가 다루는
 * 교정 유형(명시 마커 / 반사실 / 완곡 / 부정·반박)과 같은 기준. 0 = 교정 신호 없음.
 * 감사 기준선(2026-11-04)이 쓴 정규식을 포함하는 상위 집합이다.
 */

const STRONG = [
  /하지\s*마/, /하지\s*말/, /말고(?![가-힣])/, /그게\s*아니라/, /아니\s*그게/, /틀렸/, /잘못/, /앞으로/, /절대/, /금지/,
  /\bdon'?t\b/i, /\bdo not\b/i, /\bnever\b/i, /\bstop (doing|adding|using)\b/i, /\binstead of\b/i,
  /\bthat'?s (not|wrong)\b/i, /\bwrong\b/i, /\bnot what i\b/i,
];
const MEDIUM = [
  /아니(야|요|고|,|\.|\s)/, /아니/, /왜\s/, /않았/, /안\s*했/, /안\s*돼/, /하지\s*않/, /했어야/, /해야지/, /굳이/, /필요\s*(없|하지)/,
  /다시/, /항상/, /\balways\b/i, /\bactually\b/i, /\bshould(n'?t| not| have)\b/i, /\bwhy did\b/i, /^\s*no[,.\s]/i,
];

export function correctionScore(text: string): number {
  if (!text) return 0;
  const head = text.slice(0, 600);
  let s = 0;
  for (const re of STRONG) if (re.test(head)) { s = 3; break; }
  if (s === 0) for (const re of MEDIUM) if (re.test(head)) { s = 2; break; }
  return s;
}

export function isCorrectionCandidate(text: string): boolean {
  return correctionScore(text) > 0;
}
