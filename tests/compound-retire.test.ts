/**
 * compound-retire — unit tests (P3)
 * - dry-run: 출력만, 파일 이동 X
 * - apply (--yes): 파일 이동 정확
 * - 이미 archived 솔루션 skip
 * - dead 아닌 솔루션 retire X
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── isolate FORGEN_HOME ───────────────────────────────────────────────────────
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-retire-test-'));
process.env.FORGEN_HOME = TMP_HOME;

// ── mock lifecycle-classifier ─────────────────────────────────────────────────
vi.mock('../src/core/lifecycle-classifier.js', () => ({
  classifySolutions: vi.fn(() => []),
}));

const { retireDeadSolutions } = await import('../src/engine/compound-retire.js');
const { classifySolutions } = await import('../src/core/lifecycle-classifier.js');
const mockClassify = vi.mocked(classifySolutions);

// ── helpers ───────────────────────────────────────────────────────────────────
const SOLUTIONS_DIR = path.join(TMP_HOME, 'me', 'solutions');
const ARCHIVED_DIR = path.join(TMP_HOME, 'lab', 'archived');

function createSolution(id: string): string {
  fs.mkdirSync(SOLUTIONS_DIR, { recursive: true });
  const p = path.join(SOLUTIONS_DIR, `${id}.md`);
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(p, `---
name: ${id}
version: 1
status: experiment
confidence: 0.5
type: pattern
scope: me
tags:
  - test
identifiers:
  - testFn
created: ${today}
updated: ${today}
supersedes: null
extractedBy: manual
evidence:
  injected: 0
  reflected: 0
  negative: 0
  sessions: 0
  reExtracted: 0
---

## Content
test content
`);
  return p;
}

function makeLifecycleClass(id: string, lifecycle: 'hot' | 'warm' | 'cold' | 'dead' | 'new') {
  return {
    solutionId: id,
    lifecycle,
    hitRate: null,
    matched_90d: 0,
    surfaced_90d: 0,
    acted_90d: 0,
    matched_180d: 0,
    ageDays: lifecycle === 'dead' ? 200 : 10,
  };
}

// suppress console.log output in tests
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('compound-retire', () => {
  it('dry-run: 파일 이동 없음, dead 목록 반환', async () => {
    createSolution('dead-sol-1');
    mockClassify.mockReturnValue([makeLifecycleClass('dead-sol-1', 'dead')]);

    const result = await retireDeadSolutions({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.retired).toContain('dead-sol-1');
    // 실제 파일 이동 없음
    expect(fs.existsSync(path.join(SOLUTIONS_DIR, 'dead-sol-1.md'))).toBe(true);
    expect(fs.existsSync(path.join(ARCHIVED_DIR, 'dead-sol-1.md'))).toBe(false);
  });

  it('apply (--yes): 파일을 archived 로 이동', async () => {
    createSolution('dead-sol-2');
    mockClassify.mockReturnValue([makeLifecycleClass('dead-sol-2', 'dead')]);

    const result = await retireDeadSolutions({ dryRun: false, yes: true });

    expect(result.dryRun).toBe(false);
    expect(result.retired).toContain('dead-sol-2');
    expect(fs.existsSync(path.join(SOLUTIONS_DIR, 'dead-sol-2.md'))).toBe(false);
    expect(fs.existsSync(path.join(ARCHIVED_DIR, 'dead-sol-2.md'))).toBe(true);
  });

  it('이미 archived: skip', async () => {
    createSolution('dead-sol-3');
    // pre-create archived copy
    fs.mkdirSync(ARCHIVED_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARCHIVED_DIR, 'dead-sol-3.md'), '# already archived');
    mockClassify.mockReturnValue([makeLifecycleClass('dead-sol-3', 'dead')]);

    const result = await retireDeadSolutions({ dryRun: false, yes: true });

    expect(result.retired).not.toContain('dead-sol-3');
    expect(result.skipped).toContain('dead-sol-3');
  });

  it('dead 아닌 솔루션은 이동 X', async () => {
    createSolution('hot-sol');
    createSolution('new-sol');
    createSolution('dead-sol-4');
    mockClassify.mockReturnValue([
      makeLifecycleClass('hot-sol', 'hot'),
      makeLifecycleClass('new-sol', 'new'),
      makeLifecycleClass('dead-sol-4', 'dead'),
    ]);

    const result = await retireDeadSolutions({ dryRun: false, yes: true });

    expect(result.retired).toContain('dead-sol-4');
    expect(result.retired).not.toContain('hot-sol');
    expect(result.retired).not.toContain('new-sol');
    expect(fs.existsSync(path.join(SOLUTIONS_DIR, 'hot-sol.md'))).toBe(true);
    expect(fs.existsSync(path.join(SOLUTIONS_DIR, 'new-sol.md'))).toBe(true);
  });

  it('dead 없을 때: 0건 반환', async () => {
    mockClassify.mockReturnValue([makeLifecycleClass('warm-sol', 'warm')]);

    const result = await retireDeadSolutions({ dryRun: false, yes: true });

    expect(result.retired).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});
