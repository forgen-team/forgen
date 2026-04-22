/**
 * Meta promotion (B→A, C→B) + signals collector tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Rule } from '../src/store/types.js';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-meta-promo-${process.pid}`,
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { promoteMech, scanSignalsForPromotion, applyPromotion } = await import(
  '../src/engine/lifecycle/meta-reclassifier.js'
);
const { collectSignals, recordViolation, recordBypass, readJsonlSafe } = await import(
  '../src/engine/lifecycle/signals.js'
);

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    rule_id: 'rp-' + Math.random().toString(36).slice(2, 8),
    category: 'quality',
    scope: 'me',
    trigger: 't',
    policy: 'p',
    strength: 'default',
    source: 'explicit_correction',
    status: 'active',
    evidence_refs: [],
    render_key: 'q.t',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

describe('promoteMech', () => {
  it('C → B', () => { expect(promoteMech('C')).toBe('B'); });
  it('B → A', () => { expect(promoteMech('B')).toBe('A'); });
  it('A → null (already top)', () => { expect(promoteMech('A')).toBe(null); });
});

describe('scanSignalsForPromotion', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('rolling 20 injects + 0 violations → candidate', () => {
    const r = rule({
      rule_id: 'r-p',
      enforce_via: [{ mech: 'B', hook: 'Stop', verifier: { kind: 'self_check_prompt', params: {} } }],
    });
    const signals = new Map([
      [r.rule_id, { violations_30d: 0, violation_rate_30d: 0, bypass_7d: 0, last_inject_days_ago: 2, injects_rolling_n: 25, violations_rolling_n: 0, last_updated_days_ago: 2 }],
    ]);
    const candidates = scanSignalsForPromotion({ rules: [r], signals });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].current_mechs).toContain('B');
  });

  it('injects below rolling_min → no candidate', () => {
    const r = rule({
      enforce_via: [{ mech: 'B', hook: 'Stop', verifier: { kind: 'self_check_prompt', params: {} } }],
    });
    const signals = new Map([
      [r.rule_id, { violations_30d: 0, violation_rate_30d: 0, bypass_7d: 0, last_inject_days_ago: 1, injects_rolling_n: 10, violations_rolling_n: 0, last_updated_days_ago: 1 }],
    ]);
    expect(scanSignalsForPromotion({ rules: [r], signals })).toHaveLength(0);
  });

  it('any violations in rolling window → no candidate', () => {
    const r = rule({
      enforce_via: [{ mech: 'B', hook: 'Stop', verifier: { kind: 'self_check_prompt', params: {} } }],
    });
    const signals = new Map([
      [r.rule_id, { violations_30d: 1, violation_rate_30d: 0.05, bypass_7d: 0, last_inject_days_ago: 1, injects_rolling_n: 25, violations_rolling_n: 1, last_updated_days_ago: 1 }],
    ]);
    expect(scanSignalsForPromotion({ rules: [r], signals })).toHaveLength(0);
  });

  it('already Mech-A only → no candidate', () => {
    const r = rule({
      enforce_via: [{ mech: 'A', hook: 'Stop', verifier: { kind: 'artifact_check', params: {} } }],
    });
    const signals = new Map([
      [r.rule_id, { violations_30d: 0, violation_rate_30d: 0, bypass_7d: 0, last_inject_days_ago: 1, injects_rolling_n: 30, violations_rolling_n: 0, last_updated_days_ago: 1 }],
    ]);
    expect(scanSignalsForPromotion({ rules: [r], signals })).toHaveLength(0);
  });
});

describe('applyPromotion — persistence', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('B→A promotion persists to disk + meta_promotions recorded', () => {
    const r = rule({
      rule_id: 'r-promote',
      enforce_via: [
        { mech: 'B', hook: 'Stop', verifier: { kind: 'self_check_prompt', params: {} } },
        { mech: 'C', hook: 'PostToolUse', drift_key: 'x' },
      ],
    });
    const dir = path.join(TEST_HOME, '.forgen', 'me', 'rules');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'r-promote.json'), JSON.stringify(r));

    const now = Date.parse('2026-05-01T12:00:00Z');
    const candidate = {
      rule_id: 'r-promote',
      injects_rolling_n: 25,
      violations_rolling_n: 0,
      current_mechs: ['B' as const, 'C' as const],
      reason: 'test',
    };
    const result = applyPromotion(r, candidate, now);
    expect(result.applied).toBe(true);
    expect(result.before_mech).toEqual(['B', 'C']);
    expect(result.after_mech).toEqual(['A', 'B']);

    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'r-promote.json'), 'utf-8')) as Rule;
    expect(saved.enforce_via?.map((s) => s.mech)).toEqual(['A', 'B']);
    expect(saved.lifecycle?.meta_promotions).toHaveLength(2);
    expect(saved.lifecycle?.meta_promotions[0].reason).toBe('consistent_adherence');
  });

  it('returns applied=false when only Mech-A specs', () => {
    const r = rule({
      enforce_via: [{ mech: 'A', hook: 'Stop', verifier: { kind: 'artifact_check', params: {} } }],
    });
    const dir = path.join(TEST_HOME, '.forgen', 'me', 'rules');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${r.rule_id}.json`), JSON.stringify(r));
    const result = applyPromotion(r, {
      rule_id: r.rule_id, injects_rolling_n: 30, violations_rolling_n: 0, current_mechs: ['A'], reason: 'x',
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/no Mech-B\/C/);
  });
});

describe('signals.collectSignals', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('aggregates violations within 30d window', () => {
    const r = rule({ rule_id: 'rs-1', updated_at: '2026-03-01T00:00:00Z' });
    const now = Date.parse('2026-04-22T00:00:00Z');
    const violations = [
      { at: new Date(now - 10 * 24 * 3600_000).toISOString(), rule_id: 'rs-1', session_id: 's1', source: 'stop-guard' as const, kind: 'block' as const },
      { at: new Date(now - 29 * 24 * 3600_000).toISOString(), rule_id: 'rs-1', session_id: 's1', source: 'stop-guard' as const, kind: 'block' as const },
      { at: new Date(now - 40 * 24 * 3600_000).toISOString(), rule_id: 'rs-1', session_id: 's1', source: 'stop-guard' as const, kind: 'block' as const },
    ];
    const s = collectSignals(r, { violations, bypass: [], now });
    expect(s.violations_30d).toBe(2);
  });

  it('aggregates bypass within 7d window', () => {
    const r = rule({ rule_id: 'rs-2' });
    const now = Date.parse('2026-04-22T00:00:00Z');
    const bypass = [
      { at: new Date(now - 3 * 24 * 3600_000).toISOString(), rule_id: 'rs-2', session_id: 's1', tool: 'Bash', pattern_preview: 'x' },
      { at: new Date(now - 10 * 24 * 3600_000).toISOString(), rule_id: 'rs-2', session_id: 's1', tool: 'Bash', pattern_preview: 'x' },
    ];
    const s = collectSignals(r, { violations: [], bypass, now });
    expect(s.bypass_7d).toBe(1);
  });

  it('last_inject_days_ago falls back to updated_at when lifecycle.last_inject_at absent', () => {
    const r = rule({ updated_at: '2026-01-01T00:00:00Z' });
    const now = Date.parse('2026-04-22T00:00:00Z');
    const s = collectSignals(r, { violations: [], bypass: [], now });
    expect(s.last_inject_days_ago).toBeGreaterThan(100);
  });

  it('violation_rate = 1 when no inject tracking and ≥ 1 violation', () => {
    const r = rule({ rule_id: 'rs-3' });
    const now = Date.parse('2026-04-22T00:00:00Z');
    const violations = [
      { at: new Date(now - 5 * 24 * 3600_000).toISOString(), rule_id: 'rs-3', session_id: 's1', source: 'stop-guard' as const, kind: 'block' as const },
    ];
    const s = collectSignals(r, { violations, bypass: [], now });
    expect(s.violation_rate_30d).toBe(1);
  });
});

describe('signals.record* IO', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('recordViolation writes JSONL line under TEST_HOME', () => {
    recordViolation({ rule_id: 'r1', session_id: 's1', source: 'stop-guard', kind: 'block' });
    const p = path.join(TEST_HOME, '.forgen', 'state', 'enforcement', 'violations.jsonl');
    expect(fs.existsSync(p)).toBe(true);
    const entries = readJsonlSafe(p);
    expect(entries).toHaveLength(1);
  });

  it('recordBypass writes JSONL line under TEST_HOME', () => {
    recordBypass({ rule_id: 'r1', session_id: 's1', tool: 'Bash', pattern_preview: '.then(' });
    const p = path.join(TEST_HOME, '.forgen', 'state', 'enforcement', 'bypass.jsonl');
    expect(fs.existsSync(p)).toBe(true);
    const entries = readJsonlSafe(p);
    expect(entries).toHaveLength(1);
  });
});
