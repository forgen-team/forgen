/**
 * Regression: runAutoCompound (spawn.ts) 는 세션 종료를 막지 않아야 한다.
 *
 * 과거에는 execFileSync 로 동기 실행하여 세션 종료가 최대 ~210초(haiku LLM 3회
 * 순차) 동안 블록되었다. 이제 detached + unref 로 백그라운드 spawn 하고 즉시
 * 반환하며, last-auto-compound.json 마커를 Stop 훅과 공유해 double-run 을 막는다.
 *
 * 본 테스트는 node:child_process.spawn 을 mock 하여:
 *   - detached:true + stdio(stdin='ignore', stdout/stderr=로그 파일 fd) + unref() 로
 *     spawn 되는지 (비차단, 관측성)
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

/** 세션별 러너 처리 기록(D9): 마지막 실행 시점의 transcript 크기. */
function writeRunMark(sessionId: string, runSize: number): void {
  fs.writeFileSync(
    path.join(stateDir, 'extraction-cursors.json'),
    JSON.stringify({ [sessionId]: { offset: runSize, at: new Date().toISOString(), runSize } }), // 커서도 끝까지 — 못 넘긴 구간 없음
  );
}

function makeTranscript(bytes: number): string {
  const f = path.join(tmpHome, 't.jsonl');
  fs.writeFileSync(f, 'x'.repeat(bytes));
  return f;
}

describe('runAutoCompound — detached, non-blocking', () => {
  it('마커 없으면 detached+unref 로 spawn 하고 동기 반환', async () => {
    const { runAutoCompound } = await import('../src/core/spawn.js');
    const ret = runAutoCompound('/tmp/cwd', '/tmp/transcript.jsonl', 's-new');
    // 동기 상태 반환 (Promise 아님) — 세션 종료를 await 로 막지 않는다. (ADR-011: sweep 이
    // 실제 spawn 만 기록하도록 status 반환. 여기선 spawn 성공 = 'spawned'.)
    expect(ret).toBe('spawned');
    expect(ret).not.toBeInstanceOf(Promise);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const opts = mockSpawn.mock.calls[0][2];
    expect(opts.detached).toBe(true);
    // 결함2 관측성 fix (2026-08-18): stdin은 여전히 'ignore'이지만 stdout/stderr는
    // 세션별 로그 파일 fd로 리다이렉트된다(더 이상 stdio:'ignore' 통짜가 아님) —
    // tests/auto-compound-extraction.test.ts가 로그 파일 내용까지 검증한다.
    expect(Array.isArray(opts.stdio)).toBe(true);
    expect(opts.stdio[0]).toBe('ignore');
    expect(typeof opts.stdio[1]).toBe('number');
    expect(typeof opts.stdio[2]).toBe('number');
    expect(mockUnref).toHaveBeenCalledTimes(1);
  });

  it('같은 세션이고 마지막 러너 실행 이후 transcript 가 자라지 않았으면 spawn 건너뜀 (dedup)', async () => {
    const t = makeTranscript(1000);
    writeRunMark('s-dup', 1000);
    const { runAutoCompound } = await import('../src/core/spawn.js');
    expect(runAutoCompound('/tmp/cwd', t, 's-dup')).toBe('skipped-dedup');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('최근 실행이어도 transcript 가 자랐으면 spawn (마지막 교정이 5분 안에 들어와도 종료 시 승급 누락 없음)', async () => {
    const t = makeTranscript(2000);
    writeRunMark('s-grew', 1000);
    const { runAutoCompound } = await import('../src/core/spawn.js');
    expect(runAutoCompound('/tmp/cwd', t, 's-grew')).toBe('spawned');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('final=true 이면 러너 6번째 인자로 final 을 넘긴다', async () => {
    const t = makeTranscript(10);
    const { runAutoCompound } = await import('../src/core/spawn.js');
    runAutoCompound('/tmp/cwd', t, 's-final', 0, true);
    expect(mockSpawn.mock.calls[0][1].slice(-1)[0]).toBe('final');
  });

  it('다른 세션의 기록은 dedup 대상 아님 → spawn', async () => {
    const t = makeTranscript(1000);
    writeRunMark('other-session', 1000);
    const { runAutoCompound } = await import('../src/core/spawn.js');
    runAutoCompound('/tmp/cwd', t, 's-mine');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('손상된 기록이어도 fail-open 으로 spawn', async () => {
    fs.writeFileSync(path.join(stateDir, 'extraction-cursors.json'), '{ not json');
    const { runAutoCompound } = await import('../src/core/spawn.js');
    runAutoCompound('/tmp/cwd', makeTranscript(10), 's-corrupt');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
