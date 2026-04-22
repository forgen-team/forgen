/**
 * runDailyT4Decay — end-to-end: rules with stale last_inject_at get retired.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-t4-daily-${process.pid}`,
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { runDailyT4Decay } = await import('../src/core/state-gc.js');
const { createRule, saveRule, loadRule } = await import('../src/store/rule-store.js');

describe('runDailyT4Decay', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('rule with last_inject_at > 90d ago → retired (apply mode)', async () => {
    const now = Date.parse('2026-05-01T00:00:00Z');
    const r = createRule({
      category: 'quality', scope: 'me',
      trigger: 'stale-rule', policy: 'unused',
      strength: 'default', source: 'explicit_correction',
      render_key: 'k.stale',
    });
    const seeded = {
      ...r,
      lifecycle: {
        phase: 'active' as const,
        first_active_at: r.created_at,
        inject_count: 5,
        accept_count: 5,
        violation_count: 0,
        bypass_count: 0,
        conflict_refs: [],
        meta_promotions: [],
        last_inject_at: new Date(now - 100 * 24 * 3600_000).toISOString(),
      },
    };
    saveRule(seeded);

    const report = await runDailyT4Decay({ dryRun: false, now });
    expect(report.retired).toBe(1);
    const after = loadRule(r.rule_id);
    expect(after?.lifecycle?.phase).toBe('retired');
    expect(after?.status).toBe('removed');
  });

  it('dry-run does not modify rule', async () => {
    const now = Date.parse('2026-05-01T00:00:00Z');
    const r = createRule({
      category: 'quality', scope: 'me',
      trigger: 's', policy: 's',
      strength: 'default', source: 'explicit_correction',
      render_key: 'k.s',
    });
    saveRule({
      ...r,
      lifecycle: {
        phase: 'active' as const,
        first_active_at: r.created_at,
        inject_count: 1, accept_count: 0, violation_count: 0, bypass_count: 0,
        conflict_refs: [], meta_promotions: [],
        last_inject_at: new Date(now - 200 * 24 * 3600_000).toISOString(),
      },
    });
    const report = await runDailyT4Decay({ dryRun: true, now });
    expect(report.retired).toBe(1);
    expect(report.dryRun).toBe(true);
    const after = loadRule(r.rule_id);
    expect(after?.status).toBe('active');
  });

  it('fresh rule (< 90d) → not retired', async () => {
    const now = Date.parse('2026-05-01T00:00:00Z');
    const r = createRule({
      category: 'quality', scope: 'me',
      trigger: 'fresh', policy: 'fresh',
      strength: 'default', source: 'explicit_correction',
      render_key: 'k.fresh',
    });
    saveRule({
      ...r,
      lifecycle: {
        phase: 'active' as const,
        first_active_at: r.created_at,
        inject_count: 1, accept_count: 0, violation_count: 0, bypass_count: 0,
        conflict_refs: [], meta_promotions: [],
        last_inject_at: new Date(now - 30 * 24 * 3600_000).toISOString(),
      },
    });
    const report = await runDailyT4Decay({ dryRun: false, now });
    expect(report.retired).toBe(0);
  });

  it('no rules → no-op', async () => {
    const report = await runDailyT4Decay({ dryRun: false });
    expect(report.retired).toBe(0);
  });
});
