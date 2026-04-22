/**
 * T5 integration: appendRule detects conflicts with existing rules and records
 * conflict_refs on both sides + lifecycle event.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-t5-${process.pid}`,
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { createRule, saveRule, appendRule, loadRule } = await import('../src/store/rule-store.js');

describe('T5 integration (appendRule)', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('two conflicting rules → both sides get conflict_refs', async () => {
    const a = createRule({
      category: 'quality', scope: 'me',
      trigger: 'async-pref',
      policy: 'use async/await for database calls',
      strength: 'default', source: 'explicit_correction',
      render_key: 'q.async-pref',
    });
    saveRule(a);

    const b = createRule({
      category: 'quality', scope: 'me',
      trigger: 'sync-pref',
      policy: 'do not use async/await for database calls',
      strength: 'strong', source: 'explicit_correction',
      render_key: 'q.sync-pref',
    });
    const result = await appendRule(b);
    expect(result.saved).toBe(true);
    expect(result.conflicts_with).toContain(a.rule_id);

    const aAfter = loadRule(a.rule_id);
    const bAfter = loadRule(b.rule_id);
    expect(aAfter?.lifecycle?.conflict_refs).toContain(b.rule_id);
    expect(bAfter?.lifecycle?.conflict_refs).toContain(a.rule_id);
  });

  it('non-conflicting rules → no conflicts recorded', async () => {
    const a = createRule({
      category: 'quality', scope: 'me',
      trigger: 'async',
      policy: 'use async/await',
      strength: 'default', source: 'explicit_correction',
      render_key: 'q.async',
    });
    saveRule(a);

    const b = createRule({
      category: 'workflow', scope: 'me',
      trigger: 'early-return',
      policy: 'prefer early-return over nested if',
      strength: 'default', source: 'explicit_correction',
      render_key: 'w.early-return',
    });
    const result = await appendRule(b);
    expect(result.conflicts_with).toHaveLength(0);

    const aAfter = loadRule(a.rule_id);
    expect(aAfter?.lifecycle).toBeUndefined();
  });

  it('lifecycle event written to daily jsonl', async () => {
    const a = createRule({
      category: 'quality', scope: 'me',
      trigger: 'mock-usage',
      policy: 'use vi.mock for external calls',
      strength: 'default', source: 'explicit_correction',
      render_key: 'q.mock-usage',
    });
    saveRule(a);
    const b = createRule({
      category: 'quality', scope: 'me',
      trigger: 'no-mock',
      policy: 'do not use vi.mock for external calls',
      strength: 'strong', source: 'explicit_correction',
      render_key: 'q.no-mock',
    });
    await appendRule(b);

    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(TEST_HOME, '.forgen', 'state', 'lifecycle', `${today}.jsonl`);
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, 'utf-8').trim();
    expect(content).toContain('t5_conflict_detected');
  });
});
