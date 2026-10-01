/**
 * ADR-015 C-G6 — SessionEnd hook 순수 판정
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { COUNT_SCAN_BYTES, MIN_USER_MESSAGES, countUserMessagesBounded, shouldRunSessionEndCompound } from '../src/hooks/session-end.js';

describe('session-end shouldRunSessionEndCompound', () => {
  it('transcript_path 없으면 false', () => {
    expect(shouldRunSessionEndCompound(null, 100)).toBe(false);
    expect(shouldRunSessionEndCompound({ session_id: 's' }, 100)).toBe(false);
    expect(shouldRunSessionEndCompound({ transcript_path: '' }, 100)).toBe(false);
  });

  it('user 메시지 수가 임계값 미만이면 false, 이상이면 true', () => {
    const input = { session_id: 's', transcript_path: '/tmp/t.jsonl', cwd: '/tmp', reason: 'other' };
    expect(shouldRunSessionEndCompound(input, MIN_USER_MESSAGES - 1)).toBe(false);
    expect(shouldRunSessionEndCompound(input, MIN_USER_MESSAGES)).toBe(true);
  });
});

describe('session-end countUserMessagesBounded', () => {
  it('앞 COUNT_SCAN_BYTES 만 읽어 user/queue-operation 라인을 센다 (대용량 transcript 에서도 O(200KB))', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-session-end-'));
    const p = path.join(dir, 't.jsonl');
    const user = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(50) } });
    const asst = JSON.stringify({ type: 'assistant', message: { content: 'y'.repeat(50) } });
    // 앞부분 12 user + 뒤에 거대한 꼬리
    const head = Array.from({ length: 12 }, () => `${user}\n${asst}`).join('\n');
    const tail = Array.from({ length: 20000 }, () => user).join('\n');
    fs.writeFileSync(p, `${head}\n${tail}\n`);
    expect(fs.statSync(p).size).toBeGreaterThan(COUNT_SCAN_BYTES);
    const t0 = Date.now();
    const n = countUserMessagesBounded(p);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(n).toBeGreaterThanOrEqual(12);
    expect(n).toBeLessThan(20012); // 전체를 읽지 않았다
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
