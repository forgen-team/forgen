/**
 * V3: rotation rename-during-append race.
 *
 * 목적: 여러 Stop hook 이 동시에 logDriftEvent / acknowledgments 를 append 하는
 * 상황에서, 한 프로세스가 rotateIfBig 으로 rename 을 걸어도
 *   (a) 데이터 손실 없음 (합쳐서 기대 엔트리 수 유지)
 *   (b) 예외로 프로세스가 죽지 않음
 * 을 실측.
 *
 * 실제 multi-process 는 test-fragile — 같은 스레드에서 N append 동시 interleave 로
 * 유사 조건을 만든다. fs.renameSync 는 POSIX atomic, appendFileSync 는 O_APPEND
 * 원자성 — 두 연산이 함께 돌아도 커널 레벨에서 순서 결정된다. rotate 후 fresh
 * 파일에 새 append 가 가는지만 검증하면 충분.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-rotate-race-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { rotateIfBig, recordViolation } = await import('../src/engine/lifecycle/signals.js');
const { logDriftEvent, acknowledgeSessionBlocks, incrementBlockCount } = await import('../src/hooks/stop-guard.js');

const ENFORCEMENT_DIR = path.join(TEST_HOME, '.forgen', 'state', 'enforcement');

describe('V3: rotation rename-during-append race', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('rotateIfBig: missing file → no-op, no throw', () => {
    expect(() => rotateIfBig('/nonexistent/path.jsonl')).not.toThrow();
  });

  it('rotateIfBig: small file → no rotation', () => {
    fs.mkdirSync(ENFORCEMENT_DIR, { recursive: true });
    const p = path.join(ENFORCEMENT_DIR, 'test.jsonl');
    fs.writeFileSync(p, 'small\n');
    rotateIfBig(p);
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readdirSync(ENFORCEMENT_DIR)).toEqual(['test.jsonl']);
  });

  it('rotateIfBig: >10MB → rename with timestamp suffix', () => {
    fs.mkdirSync(ENFORCEMENT_DIR, { recursive: true });
    const p = path.join(ENFORCEMENT_DIR, 'test.jsonl');
    fs.writeFileSync(p, 'x'.repeat(11 * 1024 * 1024));
    rotateIfBig(p);
    const siblings = fs.readdirSync(ENFORCEMENT_DIR);
    const rotated = siblings.filter((f) => f.startsWith('test.jsonl.'));
    expect(rotated).toHaveLength(1);
    expect(fs.existsSync(p)).toBe(false); // original gone after rename
  });

  it('rotate while many drift appends in flight: zero data loss', () => {
    const driftPath = path.join(ENFORCEMENT_DIR, 'drift.jsonl');
    // Pre-seed with 9MB so first append crosses threshold mid-burst
    fs.mkdirSync(ENFORCEMENT_DIR, { recursive: true });
    fs.writeFileSync(driftPath, 'seed\n'.repeat(9 * 1024 * 200)); // ~9 MB

    const BURST = 50;
    for (let i = 0; i < BURST; i += 1) {
      logDriftEvent({
        kind: 'stuck_loop_force_approve',
        session_id: `sess-${i}`,
        rule_id: 'R-X',
        count: i,
      });
      if (i === 5) {
        // Simulate a concurrent rotate mid-burst — push active file above 10MB
        // by writing a fat record, then let subsequent appends land after rotation.
        fs.appendFileSync(driftPath, 'F'.repeat(2 * 1024 * 1024) + '\n');
      }
    }

    // Sum entries across active + rotated files — zero loss guarantee.
    const active = fs.existsSync(driftPath)
      ? fs.readFileSync(driftPath, 'utf-8').split('\n').filter(Boolean)
      : [];
    const rotated = fs.readdirSync(ENFORCEMENT_DIR)
      .filter((f) => f.startsWith('drift.jsonl.') && f !== 'drift.jsonl')
      .map((f) => fs.readFileSync(path.join(ENFORCEMENT_DIR, f), 'utf-8').split('\n').filter(Boolean))
      .flat();
    const combined = [...active, ...rotated];
    const stuckLoopLines = combined.filter((l) => l.includes('stuck_loop_force_approve'));
    expect(stuckLoopLines.length).toBe(BURST);
  });

  it('acknowledgments.jsonl: rotate mid-ack preserves all entries', () => {
    // 10 sessions each with block-count pending
    for (let i = 0; i < 10; i += 1) {
      incrementBlockCount(`v3-sess-${i}`, 'R-X');
    }
    const ackPath = path.join(ENFORCEMENT_DIR, 'acknowledgments.jsonl');
    // Pre-fill to 11MB so first ack write triggers rotation
    fs.writeFileSync(ackPath, 'z'.repeat(11 * 1024 * 1024));

    for (let i = 0; i < 10; i += 1) {
      acknowledgeSessionBlocks(`v3-sess-${i}`);
    }
    const active = fs.existsSync(ackPath)
      ? fs.readFileSync(ackPath, 'utf-8').split('\n').filter(Boolean)
      : [];
    // rotated file exists (from the pre-fill threshold trip on first ack)
    const rotated = fs.readdirSync(ENFORCEMENT_DIR)
      .filter((f) => f.startsWith('acknowledgments.jsonl.') && f !== 'acknowledgments.jsonl');
    expect(rotated.length).toBeGreaterThanOrEqual(1);
    // 10 ack entries — all must land in the active file (rotated is the pre-fill junk)
    const ackJson = active.filter((l) => {
      try {
        const obj = JSON.parse(l);
        return obj.session_id?.startsWith('v3-sess-');
      } catch {
        return false;
      }
    });
    expect(ackJson.length).toBe(10);
  });

  it('recordViolation burst with rotation mid-stream: atomic no-loss', () => {
    const vPath = path.join(ENFORCEMENT_DIR, 'violations.jsonl');
    fs.mkdirSync(ENFORCEMENT_DIR, { recursive: true });
    fs.writeFileSync(vPath, 'w'.repeat(11 * 1024 * 1024)); // trigger rotate on first call

    for (let i = 0; i < 30; i += 1) {
      recordViolation({
        rule_id: 'R-race',
        session_id: `burst-${i}`,
        source: 'stop-guard',
        kind: 'block',
      });
    }
    const active = fs.readFileSync(vPath, 'utf-8').split('\n').filter(Boolean);
    const burstEntries = active.filter((l) => l.includes('burst-'));
    expect(burstEntries.length).toBe(30);
  });
});
