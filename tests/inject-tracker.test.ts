/**
 * markRulesInjected — increments lifecycle.inject_count + last_inject_at.
 * Critical for ADR-002 Meta promotion (rolling 20 injects + 0 violations → B→A).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-inject-${process.pid}`,
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { createRule, saveRule, markRulesInjected, loadRule } = await import('../src/store/rule-store.js');

describe('markRulesInjected', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('initializes lifecycle on first inject', () => {
    const r = createRule({
      category: 'quality', scope: 'me',
      trigger: 't', policy: 'p',
      strength: 'default', source: 'explicit_correction',
      render_key: 'k',
    });
    saveRule(r);
    markRulesInjected([r.rule_id], '2026-05-01T12:00:00.000Z');
    const after = loadRule(r.rule_id);
    expect(after?.lifecycle?.inject_count).toBe(1);
    expect(after?.lifecycle?.last_inject_at).toBe('2026-05-01T12:00:00.000Z');
    expect(after?.lifecycle?.phase).toBe('active');
  });

  it('increments on repeated inject', () => {
    const r = createRule({
      category: 'quality', scope: 'me',
      trigger: 't', policy: 'p',
      strength: 'default', source: 'explicit_correction',
      render_key: 'k',
    });
    saveRule(r);
    for (let i = 0; i < 5; i++) markRulesInjected([r.rule_id]);
    const after = loadRule(r.rule_id);
    expect(after?.lifecycle?.inject_count).toBe(5);
  });

  it('unknown rule_id → no error, no file created', () => {
    expect(() => markRulesInjected(['does-not-exist'])).not.toThrow();
  });

  it('preserves existing lifecycle fields', () => {
    const r = createRule({
      category: 'quality', scope: 'me',
      trigger: 't', policy: 'p',
      strength: 'default', source: 'explicit_correction',
      render_key: 'k',
    });
    // Seed with existing lifecycle
    const seeded = {
      ...r,
      lifecycle: {
        phase: 'active' as const,
        first_active_at: r.created_at,
        inject_count: 3,
        accept_count: 2,
        violation_count: 1,
        bypass_count: 0,
        conflict_refs: ['other-rule'],
        meta_promotions: [],
      },
    };
    saveRule(seeded);
    markRulesInjected([r.rule_id]);
    const after = loadRule(r.rule_id);
    expect(after?.lifecycle?.inject_count).toBe(4);
    expect(after?.lifecycle?.accept_count).toBe(2);
    expect(after?.lifecycle?.violation_count).toBe(1);
    expect(after?.lifecycle?.conflict_refs).toEqual(['other-rule']);
  });

  it('multi-rule batch increments independently', () => {
    const a = createRule({
      category: 'quality', scope: 'me', trigger: 'a', policy: 'a',
      strength: 'default', source: 'explicit_correction', render_key: 'a',
    });
    const b = createRule({
      category: 'workflow', scope: 'me', trigger: 'b', policy: 'b',
      strength: 'default', source: 'explicit_correction', render_key: 'b',
    });
    saveRule(a); saveRule(b);
    markRulesInjected([a.rule_id, b.rule_id]);
    markRulesInjected([a.rule_id]);
    expect(loadRule(a.rule_id)?.lifecycle?.inject_count).toBe(2);
    expect(loadRule(b.rule_id)?.lifecycle?.inject_count).toBe(1);
  });
});
