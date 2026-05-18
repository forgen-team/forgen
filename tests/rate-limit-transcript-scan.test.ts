/**
 * Plan B-1: scanTranscriptForRateLimit helper 단위 테스트.
 *
 * transcript JSONL 을 임시 파일로 작성하고 helper 를 직접 호출하여
 * rate-limit 감지 여부 + resetAt 추출 정확성을 검증.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanTranscriptForRateLimit } from '../src/core/spawn.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-transcript-scan-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTranscript(lines: unknown[]): string {
  const p = path.join(tmpDir, 'session.jsonl');
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

describe('scanTranscriptForRateLimit', () => {
  it('rate-limit 메시지 포함 transcript → matched: true, resetAt 추출', async () => {
    const filePath = writeTranscript([
      { type: 'user', content: 'hello' },
      { type: 'assistant', content: "You're out of extra usage · resets 4:20pm" },
    ]);
    const result = await scanTranscriptForRateLimit(filePath);
    expect(result.matched).toBe(true);
    // resetAt 은 ISO string (파서 패턴 5)
    expect(result.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:20:00\.000Z$/);
  });

  it('rate-limit 메시지 없는 transcript → matched: false', async () => {
    const filePath = writeTranscript([
      { type: 'user', content: 'how are you?' },
      { type: 'assistant', content: 'I am doing well.' },
    ]);
    const result = await scanTranscriptForRateLimit(filePath);
    expect(result.matched).toBe(false);
    expect(result.resetAt).toBeNull();
  });

  it('빈 transcript → matched: false', async () => {
    const filePath = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(filePath, '');
    const result = await scanTranscriptForRateLimit(filePath);
    expect(result.matched).toBe(false);
  });

  it('transcript 파일 없음 → matched: false (throw 없음)', async () => {
    const filePath = path.join(tmpDir, 'nonexistent.jsonl');
    const result = await scanTranscriptForRateLimit(filePath);
    expect(result.matched).toBe(false);
  });

  it('malformed JSON 라인 포함 → silently skip, 나머지 검사', async () => {
    const filePath = path.join(tmpDir, 'mixed.jsonl');
    fs.writeFileSync(
      filePath,
      [
        'not-valid-json',
        JSON.stringify({ type: 'assistant', content: 'out of extra usage · resets 2:00pm' }),
      ].join('\n') + '\n',
    );
    const result = await scanTranscriptForRateLimit(filePath);
    expect(result.matched).toBe(true);
  });

  it('tailLines=2 로 마지막 2줄만 검사 — rate-limit 이 앞에만 있으면 missed', async () => {
    const filePath = writeTranscript([
      { type: 'assistant', content: 'out of extra usage' }, // 앞쪽
      { type: 'user', content: 'normal message 1' },
      { type: 'user', content: 'normal message 2' },
      { type: 'user', content: 'normal message 3' },
    ]);
    // tailLines=2 면 마지막 2줄만 검사 → rate-limit 라인은 포함 안 됨
    const result = await scanTranscriptForRateLimit(filePath, 2);
    expect(result.matched).toBe(false);
  });

  it('content 가 배열인 Claude block format 도 추출', async () => {
    const filePath = writeTranscript([
      {
        type: 'assistant',
        content: [
          { type: 'text', text: "You're out of extra usage · resets 11:30pm" },
        ],
      },
    ]);
    const result = await scanTranscriptForRateLimit(filePath);
    expect(result.matched).toBe(true);
    // 23:30 UTC
    expect(result.resetAt).toMatch(/T23:30:00\.000Z$/);
  });

  it('resetAt 없는 rate-limit 메시지 → matched: true, resetAt: null', async () => {
    const filePath = writeTranscript([
      { type: 'assistant', content: 'rate limit exceeded, please wait.' },
    ]);
    const result = await scanTranscriptForRateLimit(filePath);
    expect(result.matched).toBe(true);
    expect(result.resetAt).toBeNull();
  });
});
