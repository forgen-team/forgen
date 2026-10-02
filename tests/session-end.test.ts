/**
 * ADR-015 C-G6 — SessionEnd hook 순수 판정
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { COUNT_SCAN_BYTES, MIN_USER_MESSAGES, countSessionUserMessages, countUserMessagesBounded, shouldRunSessionEndCompound } from '../src/hooks/session-end.js';

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

describe('session-end countSessionUserMessages — host 별 카운터 선택 (ADR-016 D2)', () => {
  it('runtime=codex 면 rollout 의 실제 프롬프트 수(event_msg/user_message)로, 아니면 Claude 스키마로 센다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-session-end-codex-'));
    const p = path.join(dir, 'rollout-2026-10-02T03-19-17-01a0fa9f-935c-77c1-929f-58c6f496b18c.jsonl');
    const lines = [JSON.stringify({ type: 'session_meta', payload: { id: 'x' } })];
    for (let i = 0; i < 11; i += 1) {
      lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: `p${i}` } }));
      lines.push(JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'y'.repeat(60_000) } }));
    }
    fs.writeFileSync(p, `${lines.join('\n')}\n`);
    // Claude 용 카운터는 Codex 스키마를 세지 못한다 (그래서 전용 카운터가 필요)
    expect(await countSessionUserMessages(p, 'claude')).toBe(0);
    expect(await countSessionUserMessages(p, undefined)).toBe(0);
    const n = await countSessionUserMessages(p, 'codex');
    expect(n).toBe(11); // 200KB 창을 넘는 뒤쪽 프롬프트까지 센다
    expect(shouldRunSessionEndCompound({ session_id: 's', transcript_path: p, cwd: dir, reason: 'other' }, n)).toBe(true);

    // 기본값은 FORGEN_RUNTIME (codex-adapter 가 주입)
    const prev = process.env.FORGEN_RUNTIME;
    try {
      process.env.FORGEN_RUNTIME = 'codex';
      expect(await countSessionUserMessages(p)).toBe(11);
    } finally {
      if (prev === undefined) delete process.env.FORGEN_RUNTIME; else process.env.FORGEN_RUNTIME = prev;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
