/**
 * buildSessionBrief — Feature 1-C tests
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: '/tmp/forgen-test-session-brief',
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import { buildSessionBrief } from '../src/hooks/pre-compact.js';

const STATE_DIR = path.join(TEST_HOME, '.forgen', 'state');
const ME_RULES_DIR = path.join(TEST_HOME, '.forgen', 'me', 'rules');

describe('buildSessionBrief', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(ME_RULES_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('returns valid JSON with all required fields', () => {
    const brief = buildSessionBrief('test-session-1');
    expect(typeof brief.sessionId).toBe('string');
    expect(typeof brief.mode).toBe('string');
    expect(Array.isArray(brief.modifiedFiles)).toBe(true);
    expect(typeof brief.promptCount).toBe('number');
    expect(Array.isArray(brief.solutionsInjected)).toBe(true);
    expect(typeof brief.correctionCount).toBe('number');
    expect(typeof brief.generatedAt).toBe('string');
    // generatedAt should be a valid ISO date
    expect(new Date(brief.generatedAt).toISOString()).toBe(brief.generatedAt);
  });

  it('missing state files → defaults (empty arrays, 0)', () => {
    const brief = buildSessionBrief('no-state-session');
    expect(brief.modifiedFiles).toEqual([]);
    expect(brief.promptCount).toBe(0);
    expect(brief.solutionsInjected).toEqual([]);
    expect(brief.correctionCount).toBe(0);
    expect(brief.mode).toBe('general');
  });

  it('reads modifiedFiles from modified-files-{sessionId}.json', () => {
    fs.writeFileSync(
      path.join(STATE_DIR, 'modified-files-test-session-2.json'),
      JSON.stringify({
        sessionId: 'test-session-2',
        files: { 'src/foo.ts': { count: 1 }, 'src/bar.ts': { count: 2 } },
        toolCallCount: 2,
      }),
    );
    const brief = buildSessionBrief('test-session-2');
    expect(brief.modifiedFiles).toContain('src/foo.ts');
    expect(brief.modifiedFiles).toContain('src/bar.ts');
  });

  it('reads promptCount from context-guard.json', () => {
    fs.writeFileSync(
      path.join(STATE_DIR, 'context-guard.json'),
      JSON.stringify({ promptCount: 42, totalChars: 1000, lastWarningAt: 0, sessionId: 'test-session-3' }),
    );
    const brief = buildSessionBrief('test-session-3');
    expect(brief.promptCount).toBe(42);
  });

  it('collects solutionsInjected from injection-cache-*.json files', () => {
    fs.writeFileSync(
      path.join(STATE_DIR, 'injection-cache-test-session-4.json'),
      JSON.stringify({
        solutions: [
          { name: 'sol-a', status: 'candidate', injectedAt: new Date().toISOString() },
          { name: 'sol-b', status: 'verified', injectedAt: new Date().toISOString() },
        ],
      }),
    );
    const brief = buildSessionBrief('test-session-4');
    expect(brief.solutionsInjected).toContain('sol-a');
    expect(brief.solutionsInjected).toContain('sol-b');
  });

  it('counts correctionCount from ME_RULES files with scope=session', () => {
    fs.writeFileSync(
      path.join(ME_RULES_DIR, 'rule-1.json'),
      JSON.stringify({ rule_id: 'r1', scope: 'session', status: 'active' }),
    );
    fs.writeFileSync(
      path.join(ME_RULES_DIR, 'rule-2.json'),
      JSON.stringify({ rule_id: 'r2', scope: 'me', status: 'active' }),
    );
    const brief = buildSessionBrief('test-session-5');
    expect(brief.correctionCount).toBe(1);
  });

  it('deduplicates solutions across multiple injection-cache files', () => {
    fs.writeFileSync(
      path.join(STATE_DIR, 'injection-cache-sess-a.json'),
      JSON.stringify({ solutions: [{ name: 'sol-x' }, { name: 'sol-y' }] }),
    );
    fs.writeFileSync(
      path.join(STATE_DIR, 'injection-cache-sess-b.json'),
      JSON.stringify({ solutions: [{ name: 'sol-x' }, { name: 'sol-z' }] }),
    );
    const brief = buildSessionBrief('any');
    const names = brief.solutionsInjected;
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
    expect(names).toContain('sol-x');
    expect(names).toContain('sol-y');
    expect(names).toContain('sol-z');
  });
});
