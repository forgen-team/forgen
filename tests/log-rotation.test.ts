/**
 * 0.4.6 #14 — append-only jsonl 회전 회귀 가드.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { rotateAppendOnlyLogs } from '../src/core/state-gc.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-rotate-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('rotateAppendOnlyLogs', () => {
  it('cap 미만 파일은 회전하지 않음', () => {
    const f = path.join(tmp, 'hook-timing.jsonl');
    fs.writeFileSync(f, 'small data\n');
    const r = rotateAppendOnlyLogs({ stateDir: tmp, maxBytes: 10_000 });
    expect(r.rotated).toBe(0);
    expect(fs.existsSync(f)).toBe(true);
    expect(fs.existsSync(`${f}.1`)).toBe(false);
  });

  it('cap 초과 파일은 .1 로 회전 + 새 빈 파일', () => {
    const f = path.join(tmp, 'hook-timing.jsonl');
    fs.writeFileSync(f, 'X'.repeat(20_000));
    const r = rotateAppendOnlyLogs({ stateDir: tmp, maxBytes: 10_000 });
    expect(r.rotated).toBe(1);
    expect(fs.statSync(f).size).toBe(0);
    expect(fs.existsSync(`${f}.1`)).toBe(true);
    expect(fs.statSync(`${f}.1`).size).toBe(20_000);
  });

  it('이미 .1 있으면 .2 로 밀어내고 .2 는 삭제', () => {
    const f = path.join(tmp, 'hook-timing.jsonl');
    fs.writeFileSync(f, 'X'.repeat(20_000));
    fs.writeFileSync(`${f}.1`, 'previous-rotation');
    fs.writeFileSync(`${f}.2`, 'oldest-rotation');
    const r = rotateAppendOnlyLogs({ stateDir: tmp, maxBytes: 10_000 });
    expect(r.rotated).toBe(1);
    expect(fs.statSync(`${f}.1`).size).toBe(20_000);
    expect(fs.readFileSync(`${f}.2`, 'utf-8')).toBe('previous-rotation');
  });

  it('알 수 없는 파일명은 무시 (whitelist)', () => {
    const f = path.join(tmp, 'random.jsonl');
    fs.writeFileSync(f, 'X'.repeat(20_000));
    const r = rotateAppendOnlyLogs({ stateDir: tmp, maxBytes: 10_000 });
    expect(r.scanned).toBe(0);
    expect(r.rotated).toBe(0);
  });

  it('0.4.6 신설 jsonl 들 (prompt-history, usage-telemetry, rate-limit-misses) 도 회전 대상', () => {
    for (const name of ['prompt-history.jsonl', 'usage-telemetry.jsonl', 'rate-limit-misses.jsonl']) {
      fs.writeFileSync(path.join(tmp, name), 'X'.repeat(20_000));
    }
    const r = rotateAppendOnlyLogs({ stateDir: tmp, maxBytes: 10_000 });
    expect(r.rotated).toBe(3);
  });
});
