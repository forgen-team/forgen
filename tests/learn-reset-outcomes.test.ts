/**
 * Invariant: `forgen learn reset-outcomes --apply` archives outcomes to
 * `outcomes.archive-<ts>/` and creates a fresh empty outcomes dir.
 *
 * Audit context (2026-04-21): pre-v0.3.2 attribution path blamed every
 * pending solution whenever any tool failed in the session window,
 * producing 91% global error rate. v0.3.2 attribution gates
 * (score≥0.3, lag≤5min, top-3) fix the write side going forward, but
 * legacy outcome records under the old rule would continue to distort
 * `computeFitness`. This command lets upgrading users start fresh
 * without losing history (archive, never delete).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-reset-outcomes-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { handleLearn } = await import('../src/engine/learn-cli.js');
const { OUTCOMES_DIR, STATE_DIR } = await import('../src/core/paths.js');

describe('forgen learn reset-outcomes', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(OUTCOMES_DIR, { recursive: true });
    // Seed two session outcome files
    fs.writeFileSync(
      path.join(OUTCOMES_DIR, 'sess-a.jsonl'),
      '{"session_id":"sess-a","outcome":"error"}\n{"session_id":"sess-a","outcome":"accept"}\n',
    );
    fs.writeFileSync(
      path.join(OUTCOMES_DIR, 'sess-b.jsonl'),
      '{"session_id":"sess-b","outcome":"error"}\n',
    );
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('dry-run은 아무것도 바꾸지 않는다', async () => {
    const beforeFiles = fs.readdirSync(OUTCOMES_DIR).sort();
    await handleLearn(['reset-outcomes']); // no --apply
    const afterFiles = fs.readdirSync(OUTCOMES_DIR).sort();
    expect(afterFiles).toEqual(beforeFiles);
    // archive dir should NOT exist
    const siblings = fs.readdirSync(STATE_DIR).filter((f) => f.startsWith('outcomes.archive-'));
    expect(siblings).toEqual([]);
  });

  it('--apply는 outcomes를 archive로 옮기고 fresh dir 생성', async () => {
    await handleLearn(['reset-outcomes', '--apply']);
    // 원본 outcomes/는 비어있어야 함
    expect(fs.existsSync(OUTCOMES_DIR)).toBe(true);
    expect(fs.readdirSync(OUTCOMES_DIR)).toEqual([]);
    // archive 디렉토리 존재 + 원본 내용 보존
    const archives = fs.readdirSync(STATE_DIR).filter((f) => f.startsWith('outcomes.archive-'));
    expect(archives.length).toBe(1);
    const archivePath = path.join(STATE_DIR, archives[0]);
    const archived = fs.readdirSync(archivePath).sort();
    expect(archived).toEqual(['sess-a.jsonl', 'sess-b.jsonl']);
    // content unchanged
    const a = fs.readFileSync(path.join(archivePath, 'sess-a.jsonl'), 'utf-8');
    expect(a).toMatch(/session_id":"sess-a"/);
    expect(a).toMatch(/"accept"/);
  });

  it('빈 outcomes dir는 no-op (crash 없음)', async () => {
    // clean out seed files
    for (const f of fs.readdirSync(OUTCOMES_DIR)) {
      fs.unlinkSync(path.join(OUTCOMES_DIR, f));
    }
    await expect(handleLearn(['reset-outcomes', '--apply'])).resolves.not.toThrow();
    // no archive created
    const archives = fs.readdirSync(STATE_DIR).filter((f) => f.startsWith('outcomes.archive-'));
    expect(archives).toEqual([]);
  });

  it('outcomes dir가 아예 없어도 no-op', async () => {
    fs.rmSync(OUTCOMES_DIR, { recursive: true, force: true });
    await expect(handleLearn(['reset-outcomes', '--apply'])).resolves.not.toThrow();
  });
});
