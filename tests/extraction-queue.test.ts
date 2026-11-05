import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// FORGEN_HOME 은 import 시점에 고정되므로 모듈을 새 홈으로 다시 로드한다.
async function load() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xq-'));
  process.env.FORGEN_HOME = home;
  const { vi } = await import('vitest');
  vi.resetModules();
  const q = await import('../src/core/extraction-queue.js');
  return { q, home };
}

describe('extraction-queue (D4 재시도 / D3 커서)', () => {
  let ctx: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => { ctx = await load(); });

  it('커서와 runSize 는 서로를 덮어쓰지 않는다', () => {
    ctx.q.setCursor('s1', 100);
    ctx.q.markRun('s1', 500);
    expect(ctx.q.getCursor('s1')).toBe(100);
    // 마지막 처리 이후 안 자랐어도 커서(100)가 끝(500)에 못 미치면 못 넘긴 구간이 남은 것이다 (5단계 리뷰: 예전엔 false 라 유실)
    expect(ctx.q.sessionNeedsRun('s1', 500)).toBe(true);
    ctx.q.setCursor('s1', 500);
    expect(ctx.q.sessionNeedsRun('s1', 500)).toBe(false);
    expect(ctx.q.sessionNeedsRun('s1', 501)).toBe(true);
    expect(ctx.q.sessionNeedsRun('never', 1)).toBe(true);
  });

  it('실패한 작업은 보관 → 기한 전엔 안 잡힘 → 기한 후 1건만 점유(동시 러너 중복 방지)', () => {
    const now = 1_000_000_000_000;
    ctx.q.enqueue({ sessionId: 's1', cwd: '/x', summary: '마스킹된 요약', phases: ['solution', 'behavior', 'learning'], error: 'timeout' }, now);
    expect(ctx.q.claimDue(now + 60_000)).toBeNull();
    const first = ctx.q.claimDue(now + ctx.q.BACKOFF_MS[0] + 1);
    expect(first?.sessionId).toBe('s1');
    expect(ctx.q.claimDue(now + ctx.q.BACKOFF_MS[0] + 2)).toBeNull(); // 다른 러너는 못 잡음
  });

  it('재시도가 일부 성공하면 남은 단계만 보존, 전부 성공하면 제거', () => {
    const now = 1_000_000_000_000;
    ctx.q.enqueue({ sessionId: 's1', cwd: '/x', summary: 'sum', phases: ['solution', 'behavior', 'learning'], error: 'timeout' }, now);
    const e = ctx.q.claimDue(now + ctx.q.BACKOFF_MS[0] + 1)!;
    ctx.q.completeEntry(e.id, ['learning'], 'timeout', now + ctx.q.BACKOFF_MS[0] + 1);
    const left = ctx.q.readQueue();
    expect(left).toHaveLength(1);
    expect(left[0].phases).toEqual(['learning']);
    expect(left[0].attempts).toBe(1);
    ctx.q.completeEntry(e.id, [], undefined);
    expect(ctx.q.readQueue()).toHaveLength(0);
  });

  it('시도 상한(3)에 도달하면 폐기 — 비용 폭주 방지', () => {
    const now = 1_000_000_000_000;
    ctx.q.enqueue({ sessionId: 's1', cwd: '/x', summary: 'sum', phases: ['solution'], error: 'timeout' }, now);
    const id = ctx.q.readQueue()[0].id;
    let dropped = false;
    for (let i = 0; i < ctx.q.MAX_ATTEMPTS; i++) dropped = ctx.q.completeEntry(id, ['solution'], 'timeout', now).dropped;
    expect(dropped).toBe(true);
    expect(ctx.q.readQueue()).toHaveLength(0);
  });

  it('같은 세션은 합쳐지고, 20건 초과분은 가장 오래된 것부터 버려지며 반환된다', () => {
    const now = 1_000_000_000_000;
    ctx.q.enqueue({ sessionId: 'dup', cwd: '/x', summary: 'a', phases: ['solution'], error: 'e' }, now);
    ctx.q.enqueue({ sessionId: 'dup', cwd: '/x', summary: 'b', phases: ['learning'], error: 'e' }, now);
    expect(ctx.q.readQueue()).toHaveLength(1);
    expect(ctx.q.readQueue()[0].phases.sort()).toEqual(['learning', 'solution']);
    let dropped = 0;
    for (let i = 0; i < 25; i++) dropped += ctx.q.enqueue({ sessionId: `s${i}`, cwd: '/x', summary: 'a', phases: ['solution'], error: 'e' }, now).dropped.length;
    expect(ctx.q.readQueue().length).toBe(ctx.q.MAX_QUEUE);
    expect(dropped).toBeGreaterThan(0);
  });

  it('저장된 요약에 비밀키가 있으면 안 된다는 계약: enqueue 는 받은 문자열만 저장(호출자가 마스킹) — 40K 상한', () => {
    ctx.q.enqueue({ sessionId: 's', cwd: '/x', summary: 'z'.repeat(100_000), phases: ['solution'], error: 'e' });
    expect(ctx.q.readQueue()[0].summary.length).toBe(40_000);
  });
});
