import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readLastAssistantFromTranscript } from '../src/hooks/subagent-stop-guard.js';

function writeTranscript(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-transcript-'));
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n'));
  return p;
}

describe('subagent-stop-guard: readLastAssistantFromTranscript (ADR-009 §2b)', () => {
  it('returns null for missing path', () => {
    expect(readLastAssistantFromTranscript(undefined)).toBe(null);
    expect(readLastAssistantFromTranscript('/no/such/file.jsonl')).toBe(null);
  });

  it('returns the last assistant message (string content)', () => {
    const p = writeTranscript([
      { role: 'user', content: 'do x' },
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'more' },
      { role: 'assistant', content: 'final answer' },
    ]);
    expect(readLastAssistantFromTranscript(p)).toBe('final answer');
  });

  it('joins array content text blocks', () => {
    const p = writeTranscript([
      { role: 'assistant', content: [{ type: 'text', text: 'part-a' }, { type: 'text', text: 'part-b' }] },
    ]);
    expect(readLastAssistantFromTranscript(p)).toBe('part-a\npart-b');
  });

  it('skips malformed lines and trailing non-assistant turns', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-transcript-'));
    const p = path.join(dir, 't.jsonl');
    fs.writeFileSync(p, [
      JSON.stringify({ role: 'assistant', content: 'kept' }),
      '{ this is not valid json',
      JSON.stringify({ role: 'user', content: 'last is user' }),
    ].join('\n'));
    expect(readLastAssistantFromTranscript(p)).toBe('kept');
  });

  it('returns null when no assistant turn exists', () => {
    const p = writeTranscript([{ role: 'user', content: 'only user' }]);
    expect(readLastAssistantFromTranscript(p)).toBe(null);
  });
});
