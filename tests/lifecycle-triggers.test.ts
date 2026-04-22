/**
 * Unit tests for T1~T5 lifecycle triggers (ADR-002) — pure detect() functions.
 */
import { describe, it, expect } from 'vitest';
import type { Evidence, Rule } from '../src/store/types.js';
import type { RuleSignals } from '../src/engine/lifecycle/types.js';
import { detect as detectT1 } from '../src/engine/lifecycle/trigger-t1-correction.js';
import { detect as detectT2 } from '../src/engine/lifecycle/trigger-t2-violation.js';
import { detect as detectT3 } from '../src/engine/lifecycle/trigger-t3-bypass.js';
import { detect as detectT4 } from '../src/engine/lifecycle/trigger-t4-decay.js';
import { detect as detectT5 } from '../src/engine/lifecycle/trigger-t5-conflict.js';

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    rule_id: 'r-' + Math.random().toString(36).slice(2, 8),
    category: 'quality',
    scope: 'me',
    trigger: 'then-usage',
    policy: 'use async/await not .then',
    strength: 'default',
    source: 'explicit_correction',
    status: 'active',
    evidence_refs: [],
    render_key: 'quality_safety.then-usage',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

function sig(overrides: Partial<RuleSignals> = {}): RuleSignals {
  return {
    violations_30d: 0,
    violation_rate_30d: 0,
    bypass_7d: 0,
    last_inject_days_ago: 0,
    injects_rolling_n: 0,
    violations_rolling_n: 0,
    last_updated_days_ago: 0,
    ...overrides,
  };
}

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    evidence_id: 'ev-1',
    type: 'explicit_correction',
    session_id: 's1',
    timestamp: '2026-04-22T00:00:00Z',
    source_component: 'correction-record',
    summary: 'user asked to stop using then-usage pattern',
    axis_refs: ['quality_safety'],
    candidate_rule_refs: [],
    confidence: 0.9,
    raw_payload: { target: 'then-usage' },
    ...overrides,
  };
}

describe('T1 — explicit_correction', () => {
  it('matches rule by axis + render_key token overlap', () => {
    const r = rule({ rule_id: 'r1', category: 'quality' });
    const ev = evidence({ axis_refs: ['quality_safety'] });
    const events = detectT1({ evidence: ev, rules: [r] });
    expect(events).toHaveLength(1);
    expect(events[0].rule_id).toBe('r1');
    expect(events[0].kind).toBe('t1_explicit_correction');
  });

  it('axis matches but no key-token overlap → NOT matched (prevents FP)', () => {
    const r = rule({ rule_id: 'r-unrelated', render_key: 'quality_safety.early-return' });
    const ev = evidence({
      axis_refs: ['quality_safety'],
      summary: 'stop using mock in production',
      raw_payload: { target: 'mock-usage' },
    });
    expect(detectT1({ evidence: ev, rules: [r] })).toHaveLength(0);
  });

  it('matches by candidate_rule_refs id', () => {
    const r = rule({ rule_id: 'r1', category: 'autonomy' });
    const ev = evidence({ axis_refs: [], candidate_rule_refs: ['r1'] });
    const events = detectT1({ evidence: ev, rules: [r] });
    expect(events).toHaveLength(1);
  });

  it('correction_kind=avoid-this → retire', () => {
    const r = rule({ rule_id: 'r1' });
    const ev = evidence();
    const events = detectT1({ evidence: ev, rules: [r], correction_kind: 'avoid-this' });
    expect(events[0].suggested_action).toBe('retire');
  });

  it('correction_kind=prefer-from-now → supersede', () => {
    const r = rule({ rule_id: 'r1' });
    const events = detectT1({ evidence: evidence(), rules: [r], correction_kind: 'prefer-from-now' });
    expect(events[0].suggested_action).toBe('supersede');
  });

  it('correction_kind=fix-now → flag (default)', () => {
    const r = rule({ rule_id: 'r1' });
    const events = detectT1({ evidence: evidence(), rules: [r], correction_kind: 'fix-now' });
    expect(events[0].suggested_action).toBe('flag');
  });

  it('non-explicit_correction evidence → no events', () => {
    const ev = evidence({ type: 'session_summary' });
    const events = detectT1({ evidence: ev, rules: [rule({})] });
    expect(events).toHaveLength(0);
  });

  it('inactive rule → skipped', () => {
    const r = rule({ status: 'removed' });
    const events = detectT1({ evidence: evidence(), rules: [r] });
    expect(events).toHaveLength(0);
  });
});

describe('T2 — repeated_violation', () => {
  it('violations ≥ 3 AND rate > 0.3 → flag event', () => {
    const r = rule({ rule_id: 'r2' });
    const signals = new Map([[r.rule_id, sig({ violations_30d: 5, violation_rate_30d: 0.4 })]]);
    const events = detectT2({ rules: [r], signals });
    expect(events).toHaveLength(1);
    expect(events[0].suggested_action).toBe('flag');
    expect(events[0].evidence?.metrics?.violations_30d).toBe(5);
  });

  it('violations < 3 → no event', () => {
    const r = rule({ rule_id: 'r2' });
    const signals = new Map([[r.rule_id, sig({ violations_30d: 2, violation_rate_30d: 0.9 })]]);
    expect(detectT2({ rules: [r], signals })).toHaveLength(0);
  });

  it('rate ≤ 0.3 → no event', () => {
    const r = rule({ rule_id: 'r2' });
    const signals = new Map([[r.rule_id, sig({ violations_30d: 10, violation_rate_30d: 0.25 })]]);
    expect(detectT2({ rules: [r], signals })).toHaveLength(0);
  });

  it('already flagged → skip (no duplicate)', () => {
    const r = rule({
      rule_id: 'r2',
      lifecycle: { phase: 'flagged', first_active_at: '', inject_count: 0, accept_count: 0, violation_count: 10, bypass_count: 0, conflict_refs: [], meta_promotions: [] },
    });
    const signals = new Map([[r.rule_id, sig({ violations_30d: 5, violation_rate_30d: 0.5 })]]);
    expect(detectT2({ rules: [r], signals })).toHaveLength(0);
  });
});

describe('T3 — user_bypass', () => {
  it('bypass_7d ≥ 5 → flag event (R6-P1: suppress 에서 약화)', () => {
    const r = rule({ rule_id: 'r3' });
    const signals = new Map([[r.rule_id, sig({ bypass_7d: 5 })]]);
    const events = detectT3({ rules: [r], signals });
    expect(events).toHaveLength(1);
    expect(events[0].suggested_action).toBe('flag');
  });

  it('bypass_7d < 5 → no event', () => {
    const r = rule({ rule_id: 'r3' });
    const signals = new Map([[r.rule_id, sig({ bypass_7d: 4 })]]);
    expect(detectT3({ rules: [r], signals })).toHaveLength(0);
  });

  it('already flagged/suppressed → skip', () => {
    const r = rule({
      rule_id: 'r3',
      lifecycle: { phase: 'flagged', first_active_at: '', inject_count: 0, accept_count: 0, violation_count: 0, bypass_count: 10, conflict_refs: [], meta_promotions: [] },
    });
    const signals = new Map([[r.rule_id, sig({ bypass_7d: 10 })]]);
    expect(detectT3({ rules: [r], signals })).toHaveLength(0);
  });
});

describe('T4 — time_decay', () => {
  it('last_inject_days_ago >= 90 → retire event', () => {
    const r = rule({ rule_id: 'r4' });
    const signals = new Map([[r.rule_id, sig({ last_inject_days_ago: 100 })]]);
    const events = detectT4({ rules: [r], signals });
    expect(events).toHaveLength(1);
    expect(events[0].suggested_action).toBe('retire');
  });

  it('last_inject_days_ago < 90 → no event', () => {
    const r = rule({ rule_id: 'r4' });
    const signals = new Map([[r.rule_id, sig({ last_inject_days_ago: 89 })]]);
    expect(detectT4({ rules: [r], signals })).toHaveLength(0);
  });

  it('already retired → skip', () => {
    const r = rule({
      rule_id: 'r4',
      lifecycle: { phase: 'retired', first_active_at: '', inject_count: 0, accept_count: 0, violation_count: 0, bypass_count: 0, conflict_refs: [], meta_promotions: [] },
    });
    const signals = new Map([[r.rule_id, sig({ last_inject_days_ago: 365 })]]);
    expect(detectT4({ rules: [r], signals })).toHaveLength(0);
  });

  it('custom decay_days threshold', () => {
    const r = rule({ rule_id: 'r4' });
    const signals = new Map([[r.rule_id, sig({ last_inject_days_ago: 30 })]]);
    const events = detectT4({ rules: [r], signals, decay_days: 14 });
    expect(events).toHaveLength(1);
  });
});

describe('T5 — conflict_detected', () => {
  it('opposite policies (same category, shared tokens, negation diff) → 2 events (both sides)', () => {
    const a = rule({
      rule_id: 'ra', category: 'quality',
      policy: 'use async/await for database operations',
    });
    const b = rule({
      rule_id: 'rb', category: 'quality',
      policy: 'do not use async/await for database operations',
    });
    const events = detectT5({ rules: [a, b] });
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.rule_id))).toEqual(new Set(['ra', 'rb']));
    for (const e of events) {
      expect(e.kind).toBe('t5_conflict_detected');
      expect(e.evidence?.refs).toContain('ra');
      expect(e.evidence?.refs).toContain('rb');
    }
  });

  it('different categories → no conflict', () => {
    const a = rule({ policy: 'use async/await', category: 'quality' });
    const b = rule({ policy: 'do not use async/await', category: 'communication' });
    expect(detectT5({ rules: [a, b] })).toHaveLength(0);
  });

  it('both positive (no negation) → no conflict', () => {
    const a = rule({ policy: 'use async/await everywhere' });
    const b = rule({ policy: 'prefer async/await patterns' });
    expect(detectT5({ rules: [a, b] })).toHaveLength(0);
  });

  it('insufficient shared tokens → no conflict', () => {
    const a = rule({ policy: 'use async/await' });
    const b = rule({ policy: 'never use callback' });
    expect(detectT5({ rules: [a, b] })).toHaveLength(0);
  });

  it('pair reported once (not duplicated)', () => {
    const a = rule({ policy: 'use async/await for db calls' });
    const b = rule({ policy: "don't use async/await for db calls" });
    const c = rule({ policy: 'prefer callback style always' }); // no conflict
    const events = detectT5({ rules: [a, b, c] });
    expect(events.length).toBe(2); // only a-b pair, once each side
  });
});
