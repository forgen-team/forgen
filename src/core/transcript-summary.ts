/**
 * Transcript → 요약 텍스트 (순수, IO 없음 — 테스트 가능).
 *
 * auto-compound-runner 의 extractSummary 에서 분리(2026-08-04). 분리 이유: 실 Claude
 * transcript 스키마 버그(text 가 `entry.message.content` 에 있는데 top-level `entry.content`
 * 만 읽어 전 user/assistant 턴 누락 → auto-compound 가 실데이터에서 dead)를 회귀 테스트로
 * 고정하기 위함. 러너 본문은 process.argv 실행부와 묶여 있어 직접 unit-test 불가였다.
 *
 * 스키마:
 *   Claude: {type:'user'|'assistant', message:{role, content: string | [{type:'text',text}]}}
 *           (일부 queue-operation 등은 top-level `content` 에 저장 → fallback)
 *   Codex:  {type:'response_item', payload:{role, content:[{type:'input_text', text}]}}
 */

export function extractText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((x): x is { type: 'text'; text?: unknown } =>
        typeof x === 'object' && x !== null && (x as { type?: unknown }).type === 'text')
      .map((x) => (typeof x.text === 'string' ? x.text : ''))
      .join('\n');
  }
  return '';
}

/** Codex content array → flat string. content: [{type:'input_text', text}] */
export function extractCodexText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === 'object' && 'text' in item && typeof (item as { text: unknown }).text === 'string') {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join('\n');
}

interface TranscriptEntry {
  type?: string;
  content?: unknown;
  message?: { role?: string; content?: unknown };
  payload?: { role?: string; content?: unknown };
}

/** JSONL 원문 → `[User]/[Assistant]` 요약. maxChars 초과 시 조기 종료. */
export function summarizeTranscript(rawText: string, maxChars = 8000): string {
  const lines = rawText.split('\n').filter(Boolean);
  const messages: string[] = [];
  let totalChars = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as TranscriptEntry;
      // Claude schema — text 는 message.content 우선(실버그 수정), top-level 은 fallback.
      if (entry.type === 'user' || entry.type === 'queue-operation') {
        const text = extractText(entry.message?.content ?? entry.content);
        if (text) { messages.push(`[User] ${text.slice(0, 500)}`); totalChars += text.length; }
      } else if (entry.type === 'assistant') {
        const text = extractText(entry.message?.content ?? entry.content);
        if (text) { messages.push(`[Assistant] ${text.slice(0, 500)}`); totalChars += text.length; }
      }
      // Codex schema
      else if (entry.type === 'response_item' && entry.payload?.role === 'user') {
        const text = extractCodexText(entry.payload.content);
        if (text) { messages.push(`[User] ${text.slice(0, 500)}`); totalChars += text.length; }
      } else if (entry.type === 'response_item' && entry.payload?.role === 'assistant') {
        const text = extractCodexText(entry.payload.content);
        if (text) { messages.push(`[Assistant] ${text.slice(0, 500)}`); totalChars += text.length; }
      }
    } catch { /* skip malformed line */ }
    if (totalChars > maxChars) break;
  }

  return messages.join('\n\n');
}
