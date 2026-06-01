/**
 * Regression: runAutoCompound (spawn.ts) 는 세션 종료를 막지 않아야 한다.
 *
 * 과거에는 execFileSync 로 동기 실행하여 세션 종료가 최대 ~210초(haiku LLM 3회
 * 순차) 동안 블록되었다. 이제 detached + unref 로 백그라운드 spawn 하고 즉시
 * 반환하며, last-auto-compound.json 마커를 Stop 훅과 공유해 double-run 을 막는다.
 *
 * 본 테스트는 node:child_process.spawn 을 mock 하여:
 *   - detached:true + stdio:'ignore' + unref() 로 spawn 되는지 (비차단)
 *   - dedup (최근 동일 세션 마커) 시 spawn 을 건너뛰는지
 * 를 검증한다. FORGEN_HOME 을 임시 디렉토리로 격리한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { mockSpawn, mockUnref } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockUnref: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mockSpawn };
});

let tmpHome: string;
let stateDir: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-detached-'));
  process.env.FORGEN_HOME = tmpHome;
  stateDir = path.join(tmpHome, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  mockSpawn.mockReset();
  mockUnref.mockReset();
  mockSpawn.mockReturnValue({ unref: mockUnref });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.resetModules();
});

afterEach(() => {
  delete process.env.FORGEN_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeMarker(sessionId: string, completedAtMs: number): void {
  fs.writeFileSync(
    path.join(stateDir, 'last-auto-compound.json'),
    JSON.stringify({ sessionId, completedAt: new Date(completedAtMs).toISOString() }),
  );
}

describe('runAutoCompound — detached, non-blocking', () => {
  it('마커 없으면 detached+unref 로 spawn 하고 동기 반환', async () => {
    const { runAutoCompound } = await import('../src/core/spawn.js');
    const ret = runAutoCompound('/tmp/cwd', '/tmp/transcript.jsonl', 's-new');
    // 동기 void 반환 (Promise 아님) — 세션 종료를 await 로 막지 않는다.
    expect(ret).toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const opts = mockSpawn.mock.calls[0][2];
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    expect(mockUnref).toHaveBeenCalledTimes(1);
  });

  it('같은 세션의 최근(<5분) 마커가 있으면 spawn 건너뜀 (dedup)', async () => {
    writeMarker('s-dup', Date.now() - 60 * 1000); // 1분 전
    const { runAutoCompound } = await import('../src/core/spawn.js');
    runAutoCompound('/tmp/cwd', '/tmp/transcript.jsonl', 's-dup');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('같은 세션이라도 마커가 5분보다 오래되면 spawn', async () => {
    writeMarker('s-old', Date.now() - 6 * 60 * 1000); // 6분 전
    const { runAutoCompound } = await import('../src/core/spawn.js');
    runAutoCompound('/tmp/cwd', '/tmp/transcript.jsonl', 's-old');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('다른 세션의 마커는 dedup 대상 아님 → spawn', async () => {
    writeMarker('other-session', Date.now()); // 방금 전이지만 세션 다름
    const { runAutoCompound } = await import('../src/core/spawn.js');
    runAutoCompound('/tmp/cwd', '/tmp/transcript.jsonl', 's-mine');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('손상된 마커여도 fail-open 으로 spawn', async () => {
    fs.writeFileSync(path.join(stateDir, 'last-auto-compound.json'), '{ not json');
    const { runAutoCompound } = await import('../src/core/spawn.js');
    runAutoCompound('/tmp/cwd', '/tmp/transcript.jsonl', 's-corrupt');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
