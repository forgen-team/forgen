/**
 * 근거 인용(0.9.1 #13): 사용자 교정 한 마디를 화면에 붙일 때 — 앞 n자, 한 줄로, 비밀처럼 보이는 것은 가린다.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, // API 키(sk-…)
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub 토큰
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack 토큰
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS 키
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /((?:password|passwd|pwd|secret|token|api[_-]?key|비밀번호|암호)\s*[:=]\s*)\S+/gi, // 키=값
  /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g, // 긴 무작위 문자열
  /[\w.+-]+@[\w-]+\.[\w.]+/g, // 이메일
];

export function maskSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, pre?: string) => (typeof pre === 'string' && m.startsWith(pre) ? `${pre}••••` : '••••'));
  return out;
}

/** 한 줄 인용: 공백을 접고, 비밀을 가리고, 앞 n자. */
export function maskQuote(s: string, n = 80): string {
  const t = maskSecrets(String(s ?? '').replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
