/**
 * Orchestrator tests (pure applyEvent + foldEvents).
 */
import { describe, it, expect } from 'vitest';
import type { Rule } from '../src/store/types.js';
import type { LifecycleEvent } from '../src/engine/lifecycle/types.js';
import { applyEvent, foldEvents, ensureLifecycle } from '../src/engine/lifecycle/orchestrator.js';

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    rule_id: 'r1',
    category: 'quality',
    scope: 'me',
    trigger: 't',
    policy: 'p',
    strength: 'default',
    source: 'explicit_correction',
    status: 'active',
    evidence_refs: [],
    render_key: 'quality_safety.t',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

function event(overrides: Partial<LifecycleEvent> = {}): LifecycleEvent {
  return {
    kind: 't2_repeated_violation',
    rule_id: 'r1',
    suggested_action: 'flag',
    ts: Date.now(),
    ...overrides,
  };
}

describe('ensureLifecycle', () => {
  it('initializes with phase=active when absent', () => {
    const r = rule({});
    const lc = ensureLifecycle(r);
    expect(lc.phase).toBe('active');
    expect(lc.inject_count).toBe(0);
  });

  it('returns existing lifecycle unchanged', () => {
    const r = rule({
      lifecycle: { phase: 'flagged', first_active_at: '', inject_count: 3, accept_count: 1, violation_count: 2, bypass_count: 0, conflict_refs: [], meta_promotions: [] },
    });
    expect(ensureLifecycle(r).phase).toBe('flagged');
    expect(ensureLifecycle(r).inject_count).toBe(3);
  });
});

describe('applyEvent — state transitions', () => {
  it('flag → phase=flagged, status unchanged', () => {
    const r = rule({});
    const r2 = applyEvent(r, event({ suggested_action: 'flag' }));
    expect(r2.lifecycle?.phase).toBe('flagged');
    expect(r2.status).toBe('active'); // status not yet touched
  });

  it('suppress → phase=suppressed + status=suppressed', () => {
    const r = rule({});
    const r2 = applyEvent(r, event({ suggested_action: 'suppress' }));
    expect(r2.lifecycle?.phase).toBe('suppressed');
    expect(r2.status).toBe('suppressed');
  });

  it('retire → phase=retired + status=removed', () => {
    const r = rule({});
    const r2 = applyEvent(r, event({ suggested_action: 'retire' }));
    expect(r2.lifecycle?.phase).toBe('retired');
    expect(r2.status).toBe('removed');
  });

  it('merge → phase=merged + merged_into set', () => {
    const r = rule({});
    const r2 = applyEvent(r, event({ suggested_action: 'merge', merged_into: 'other-rule' }));
    expect(r2.lifecycle?.phase).toBe('merged');
    expect(r2.lifecycle?.merged_into).toBe('other-rule');
  });

  it('supersede → phase=superseded + superseded_by set + status=superseded', () => {
    const r = rule({});
    const r2 = applyEvent(r, event({ suggested_action: 'supersede', superseded_by: 'new-rule' }));
    expect(r2.lifecycle?.phase).toBe('superseded');
    expect(r2.lifecycle?.superseded_by).toBe('new-rule');
    expect(r2.status).toBe('superseded');
  });

  it('t5_conflict → conflict_refs accumulate (excluding self)', () => {
    const r = rule({ rule_id: 'r1' });
    const r2 = applyEvent(r, event({
      kind: 't5_conflict_detected',
      suggested_action: 'flag',
      evidence: { source: 'rule-pairing', refs: ['r1', 'r2'] },
    }));
    expect(r2.lifecycle?.conflict_refs).toEqual(['r2']);
  });

  it('promote_mech/demote_mech → passthrough (meta-reclassifier handles)', () => {
    const r = rule({});
    const r2 = applyEvent(r, event({ kind: 'meta_promote_to_a', suggested_action: 'promote_mech' }));
    expect(r2).toEqual(r); // no change
  });

  it('updates updated_at on state change', () => {
    const r = rule({});
    const r2 = applyEvent(r, event({ suggested_action: 'flag' }), Date.parse('2026-05-01T00:00:00Z'));
    expect(r2.updated_at).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('foldEvents', () => {
  it('applies multiple events to same rule in order (last wins for phase)', () => {
    const r = rule({ rule_id: 'r1' });
    const events: LifecycleEvent[] = [
      event({ rule_id: 'r1', suggested_action: 'flag' }),
      event({ rule_id: 'r1', suggested_action: 'retire' }),
    ];
    const byId = foldEvents([r], events);
    expect(byId.get('r1')?.lifecycle?.phase).toBe('retired');
    expect(byId.get('r1')?.status).toBe('removed');
  });

  it('applies events to separate rules independently', () => {
    const a = rule({ rule_id: 'ra' });
    const b = rule({ rule_id: 'rb' });
    const events: LifecycleEvent[] = [
      event({ rule_id: 'ra', suggested_action: 'flag' }),
      event({ rule_id: 'rb', suggested_action: 'suppress' }),
    ];
    const byId = foldEvents([a, b], events);
    expect(byId.get('ra')?.lifecycle?.phase).toBe('flagged');
    expect(byId.get('rb')?.lifecycle?.phase).toBe('suppressed');
  });

  it('skips events whose rule_id is unknown', () => {
    const r = rule({ rule_id: 'ra' });
    const events: LifecycleEvent[] = [
      event({ rule_id: 'missing', suggested_action: 'flag' }),
    ];
    const byId = foldEvents([r], events);
    expect(byId.get('ra')?.lifecycle?.phase).toBeUndefined(); // no change
  });
});
