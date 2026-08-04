import { describe, it, expect } from 'vitest';
import { summarizeTranscript, extractText, extractCodexText } from '../src/core/transcript-summary.js';

const j = (o: unknown) => JSON.stringify(o);

describe('summarizeTranscript — 실 Claude 스키마 회귀 (2026-08-04 버그)', () => {
  it('실버그: message.content(문자열)를 읽는다 — 이전엔 top-level content 만 읽어 전 턴 누락', () => {
    // 실제 Claude Code transcript 형태: text 가 message.content 에 중첩.
    const raw = [
      j({ type: 'user', message: { role: 'user', content: '이 결제 모듈 대충 최소한으로만 만들어줘' } }),
      j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '최소 구현했습니다' }] } }),
      j({ type: 'user', message: { role: 'user', content: '앞으로 이런 건 대충 닫지 말고 깊게 구현해줘' } }),
    ].join('\n');
    const out = summarizeTranscript(raw);
    expect(out).toContain('[User] 이 결제 모듈');
    expect(out).toContain('[Assistant] 최소 구현');
    expect(out).toContain('[User] 앞으로 이런 건');
    expect(out.length).toBeGreaterThan(40);
  });

  it('message.content 가 text 블록 배열이어도 추출', () => {
    const raw = j({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '한글 커밋 써줘' }, { type: 'tool_result', content: 'x' }] } });
    expect(summarizeTranscript(raw)).toContain('[User] 한글 커밋 써줘');
  });

  it('top-level content fallback 보존 (queue-operation 등)', () => {
    const raw = j({ type: 'queue-operation', content: '대기 중인 프롬프트' });
    expect(summarizeTranscript(raw)).toContain('[User] 대기 중인 프롬프트');
  });

  it('Codex 스키마도 여전히 동작', () => {
    const raw = j({ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '코덱스 유저턴' }] } });
    expect(summarizeTranscript(raw)).toContain('[User] 코덱스 유저턴');
  });

  it('빈/비정형 라인은 skip, 유효 턴 없으면 빈 문자열', () => {
    const raw = ['', 'not json', j({ type: 'summary' })].join('\n');
    expect(summarizeTranscript(raw)).toBe('');
  });

  it('maxChars 초과 시 조기 종료', () => {
    const long = 'a'.repeat(600);
    const raw = Array.from({ length: 30 }, () => j({ type: 'user', message: { role: 'user', content: long } })).join('\n');
    // 각 턴 500자 cap, maxChars=8000 → ~16턴 후 종료
    const out = summarizeTranscript(raw, 8000);
    expect(out.length).toBeLessThan(30 * 520);
  });

  it('extractText/extractCodexText 유닛', () => {
    expect(extractText('str')).toBe('str');
    expect(extractText([{ type: 'text', text: 'a' }, { type: 'tool_result' }])).toBe('a');
    expect(extractText(null)).toBe('');
    expect(extractCodexText([{ type: 'input_text', text: 'c' }])).toBe('c');
  });
});
