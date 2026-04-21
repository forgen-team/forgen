/**
 * Invariant: solution-outcomes mutations are protected by a file lock
 * and atomic write so concurrent inject/correction/error hooks on the
 * same session cannot lose or duplicate pending entries.
 *
 * Audit finding #9 (2026-04-21): prior code did
 *   readPending() → mutate → writePending(fs.writeFileSync)
 * with no lock. The audit flagged this as a real race since the hooks
 * that call these functions (solution-injector, correction-record MCP,
 * post-tool-failure) can legitimately fire concurrently during a single
 * user turn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-outcomes-lock-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { appendPending, attributeCorrection, attributeError, finalizeSession } = await import(
  '../src/engine/solution-outcomes.js'
);
const { STATE_DIR, OUTCOMES_DIR } = await import('../src/core/paths.js');

function readOutcomes(sessionId: string): Array<Record<string, unknown>> {
  const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const p = path.join(OUTCOMES_DIR, `${sanitized}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readPendingFile(sessionId: string): { pending: Array<{ solution: string }> } | null {
  const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const p = path.join(STATE_DIR, `outcome-pending-${sanitized}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('solution-outcomes lock invariants', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('순차 appendPending은 모든 항목을 보존한다 (baseline)', () => {
    const sid = 'seq-append';
    for (let i = 0; i < 5; i++) {
      appendPending(sid, [{ solution: `sol-${i}`, match_score: 0.5, injected_chars: 50 }]);
    }
    const pending = readPendingFile(sid);
    expect(pending).not.toBeNull();
    expect(pending!.pending).toHaveLength(5);
  });

  it('각 함수는 pending file lock이 이미 잡혀있으면 fail-open으로 no-op', () => {
    // 수동으로 lock 파일을 만들어 다른 프로세스가 잡고 있는 상황 재현
    const sid = 'locked-session';
    const pendingFile = path.join(STATE_DIR, `outcome-pending-${sid}.json`);
    const lockFile = `${pendingFile}.lock`;

    // 미래 staleMs 기준을 넘지 않는 "살아있는" lock — mtime now, pid = 우리 프로세스
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'xxx' }));

    // 정상 동작이면 조용히 no-op, pending 파일 안 만들어짐 (fail-open).
    // 정확히 no-op을 실측하기 위해 outcomes/ 도 비어있는지 확인.
    expect(() => {
      appendPending(sid, [{ solution: 'x', match_score: 0.8, injected_chars: 100 }]);
    }).not.toThrow();

    // lock 때문에 아무것도 쓰지 못했어야 함
    expect(fs.existsSync(pendingFile)).toBe(false);
    expect(readOutcomes(sid)).toHaveLength(0);

    fs.unlinkSync(lockFile);
  });

  it('attribute + finalize 경로 전부 atomic write (partial state 미노출)', () => {
    const sid = 'atomic-check';
    appendPending(sid, [
      { solution: 'a', match_score: 0.8, injected_chars: 100 },
      { solution: 'b', match_score: 0.9, injected_chars: 100 },
    ]);

    const tmpPattern = path.join(STATE_DIR, `outcome-pending-${sid}.json.tmp`);

    attributeError(sid);
    // atomic write 이후에는 .tmp가 남으면 안 됨
    const files = fs.readdirSync(STATE_DIR);
    expect(files.some((f) => f.startsWith(path.basename(tmpPattern)))).toBe(false);

    attributeCorrection(sid);
    expect(fs.readdirSync(STATE_DIR).some((f) => f.startsWith(path.basename(tmpPattern)))).toBe(false);

    finalizeSession(sid);
    expect(fs.existsSync(path.join(STATE_DIR, `outcome-pending-${sid}.json`))).toBe(false);
  });

  it('source invariant: 모든 mutation은 mutatePending 내부에서 실행', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'engine', 'solution-outcomes.ts'),
      'utf-8',
    );
    // mutatePending 도입 + withFileLockSync 사용 확인
    expect(src).toMatch(/function mutatePending/);
    expect(src).toMatch(/withFileLockSync/);
    // writePending은 atomicWriteJSON 사용
    expect(src).toMatch(/atomicWriteJSON\(p, state/);
    // raw fs.writeFileSync(p, JSON.stringify(state)) 패턴이 남지 않았는지
    expect(src).not.toMatch(/fs\.writeFileSync\(p,\s*JSON\.stringify\(state\)\)/);
  });
});
