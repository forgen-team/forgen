/**
 * PostToolUse 의 tool_response 는 도구마다 문자열이거나 객체다 (Bash: {stdout, stderr, interrupted, …},
 * Write: {filePath, content, …}). 객체를 템플릿 문자열에 넣으면 `[object Object]` 가 되어 비밀 탐지가
 * 통째로 우회됐다(H3). 모든 문자열 리프를 줄바꿈으로 이어 붙여 스캔 가능한 텍스트로 만든다.
 */
export function stringifyToolResponse(resp: unknown, maxChars = 2_000_000): string {
  const parts: string[] = [];
  let total = 0;
  const visit = (v: unknown, depth: number): void => {
    if (total > maxChars || depth > 6 || v === null || v === undefined) return;
    if (typeof v === 'string') { parts.push(v); total += v.length; return; }
    if (typeof v === 'number' || typeof v === 'boolean') return;
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    if (typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) visit(x, depth + 1);
  };
  visit(resp, 0);
  return parts.join('\n');
}
