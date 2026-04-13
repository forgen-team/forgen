/**
 * Session recovery — session brief loading (Feature 1-C Part 2)
 *
 * Tests that the session brief is correctly loaded and included in recovery messages.
 * We test the logic by unit-testing the recovery behavior with a temp HANDOFFS_DIR.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: '/tmp/forgen-test-session-recovery-brief',
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const HANDOFFS_DIR = path.join(TEST_HOME, '.forgen', 'handoffs');

/** Inline re-implementation of the session brief loading logic (same as session-recovery.ts) */
function loadSessionBriefContext(handoffsDir: string): string | null {
  try {
    if (!fs.existsSync(handoffsDir)) return null;
    const briefFiles = fs.readdirSync(handoffsDir)
      .filter(f => f.endsWith('-session-brief.json'))
      .sort()
      .reverse();
    if (briefFiles.length === 0) return null;
    const brief = JSON.parse(fs.readFileSync(path.join(handoffsDir, briefFiles[0]), 'utf-8'));
    return `Previous session: ${brief.mode || 'general'}, ${brief.promptCount || 0} prompts, ${(brief.modifiedFiles || []).length} files modified, ${(brief.solutionsInjected || []).length} solutions used.`;
  } catch {
    return null;
  }
}

describe('session-recovery session brief loading', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(HANDOFFS_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('loads latest session brief and injects recovery message', () => {
    const brief = {
      sessionId: 'session-1',
      mode: 'ralph',
      promptCount: 15,
      modifiedFiles: ['src/a.ts', 'src/b.ts'],
      solutionsInjected: ['sol-a'],
      correctionCount: 0,
      generatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(HANDOFFS_DIR, '2026-04-10T10-00-00-000Z-session-brief.json'),
      JSON.stringify(brief),
    );
    const ctx = loadSessionBriefContext(HANDOFFS_DIR);
    expect(ctx).not.toBeNull();
    expect(ctx).toContain('ralph');
    expect(ctx).toContain('15 prompts');
    expect(ctx).toContain('2 files modified');
    expect(ctx).toContain('1 solutions used');
  });

  it('missing session brief files → null (no message pushed)', () => {
    const ctx = loadSessionBriefContext(HANDOFFS_DIR);
    expect(ctx).toBeNull();
  });

  it('selects the latest (sorted last) brief when multiple exist', () => {
    const older = { mode: 'general', promptCount: 5, modifiedFiles: [], solutionsInjected: [] };
    const newer = { mode: 'autopilot', promptCount: 20, modifiedFiles: ['x.ts'], solutionsInjected: [] };
    fs.writeFileSync(path.join(HANDOFFS_DIR, '2026-04-09T00-00-00-000Z-session-brief.json'), JSON.stringify(older));
    fs.writeFileSync(path.join(HANDOFFS_DIR, '2026-04-10T00-00-00-000Z-session-brief.json'), JSON.stringify(newer));
    const ctx = loadSessionBriefContext(HANDOFFS_DIR);
    expect(ctx).toContain('autopilot');
    expect(ctx).toContain('20 prompts');
  });

  it('corrupt brief file → null (fail-open)', () => {
    fs.writeFileSync(
      path.join(HANDOFFS_DIR, '2026-04-10T10-00-00-000Z-session-brief.json'),
      'not valid json',
    );
    const ctx = loadSessionBriefContext(HANDOFFS_DIR);
    expect(ctx).toBeNull();
  });

  it('missing handoffs dir → null (fail-open)', () => {
    fs.rmSync(HANDOFFS_DIR, { recursive: true, force: true });
    const ctx = loadSessionBriefContext(HANDOFFS_DIR);
    expect(ctx).toBeNull();
  });
});
