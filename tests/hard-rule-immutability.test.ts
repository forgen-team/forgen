/**
 * C2 regression — hard rule 은 어떤 lifecycle signal 로도 mech/status/phase 불변.
 * ADR-002 특별 취급.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import type { Rule } from '../src/store/types.js';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-hard-immut-${process.pid}`,
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const {
  scanDriftForDemotion, applyDemotion, scanSignalsForPromotion, applyPromotion,
} = await import('../src/engine/lifecycle/meta-reclassifier.js');
const { detect: detectT1 } = await import('../src/engine/lifecycle/trigger-t1-correction.js');
const { detect: detectT4 } = await import('../src/engine/lifecycle/trigger-t4-decay.js');
const { createRule, saveRule, loadRule } = await import('../src/store/rule-store.js');

function hardRule(overrides: Partial<Rule> = {}): Rule {
  return {
    rule_id: 'L1-hard-test',
    category: 'safety',
    scope: 'me',
    trigger: 'dangerous',
    policy: 'hard rule policy',
    strength: 'hard',
    source: 'explicit_correction',
    status: 'active',
    evidence_refs: [],
    render_key: 'safety.l1-hard-test',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    enforce_via: [{ mech: 'A', hook: 'Stop', verifier: { kind: 'artifact_check', params: {} } }],
    ...overrides,
  };
}

describe('Hard rule immutability (C2)', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('Meta demote: drift 5건 있어도 hard rule 은 후보에 오르지 않음', () => {
    const now = Date.parse('2026-04-22T00:00:00Z');
    const drift = Array.from({ length: 5 }, (_, i) => ({
      at: new Date(now - (i + 1) * 24 * 3600_000 + 3600_000).toISOString(),
      kind: 'stuck_loop_force_approve',
      session_id: `s${i}`,
      rule_id: 'L1-hard-test',
      count: 4,
    }));
    const candidates = scanDriftForDemotion({ rules: [hardRule()], drift, now });
    expect(candidates).toHaveLength(0);
  });

  it('applyDemotion 직접 호출도 hard rule 은 refuse', () => {
    const r = hardRule();
    // rule 을 TEST_HOME 에 저장 (saveRule 을 통해 write 경로 활성화)
    saveRule(r);
    const fake = {
      rule_id: 'L1-hard-test', event_count: 10, first_at: '', last_at: '', sessions: [],
      window_days: 7, current_mechs: ['A' as const],
    };
    const result = applyDemotion(r, fake);
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/hard/i);
    expect(result.after_mech).toEqual(['A']); // 변하지 않음
    const saved = loadRule(r.rule_id)!;
    expect(saved.strength).toBe('hard');
    expect(saved.enforce_via?.[0].mech).toBe('A');
  });

  it('Meta promote: rolling 30 injects / 0 violations 여도 hard rule 후보 아님', () => {
    const r = hardRule({
      enforce_via: [{ mech: 'B', hook: 'Stop', verifier: { kind: 'self_check_prompt', params: {} } }],
    });
    const signals = new Map([[r.rule_id, { violations_30d: 0, violation_rate_30d: 0, bypass_7d: 0, last_inject_days_ago: 1, injects_rolling_n: 30, violations_rolling_n: 0, last_updated_days_ago: 1 }]]);
    const candidates = scanSignalsForPromotion({ rules: [r], signals });
    expect(candidates).toHaveLength(0);
  });

  it('T1 avoid-this 교정이 hard rule 을 retire 하지 않음 (soft flag 로 강등)', () => {
    const r = hardRule({ render_key: 'safety.dangerous' });
    const events = detectT1({
      evidence: {
        evidence_id: 'e1', type: 'explicit_correction', session_id: 's1',
        timestamp: '2026-04-22T00:00:00Z', source_component: 'mcp',
        summary: 'retire dangerous rule',
        axis_refs: ['quality_safety'],
        candidate_rule_refs: [],
        confidence: 0.9,
        raw_payload: { target: 'dangerous', kind: 'avoid-this' },
      },
      correction_kind: 'avoid-this',
      rules: [r],
    });
    // hard 은 retire/supersede 건너뛰어 events 없음
    expect(events).toHaveLength(0);
  });

  it('T1 fix-now (flag) 는 hard rule 에도 허용 (관찰 신호)', () => {
    const r = hardRule({ render_key: 'safety.dangerous' });
    const events = detectT1({
      evidence: {
        evidence_id: 'e2', type: 'explicit_correction', session_id: 's1',
        timestamp: '2026-04-22T00:00:00Z', source_component: 'mcp',
        summary: 'fix dangerous rule now',
        axis_refs: ['quality_safety'],
        candidate_rule_refs: [r.rule_id],
        confidence: 0.9,
        raw_payload: { target: 'dangerous', kind: 'fix-now' },
      },
      correction_kind: 'fix-now',
      rules: [r],
    });
    expect(events).toHaveLength(1);
    expect(events[0].suggested_action).toBe('flag');
  });

  it('T4 time decay 가 hard rule 을 retire 하지 않음 (1년 방치해도)', () => {
    const r = hardRule();
    const signals = new Map([[r.rule_id, { violations_30d: 0, violation_rate_30d: 0, bypass_7d: 0, last_inject_days_ago: 365, injects_rolling_n: 0, violations_rolling_n: 0, last_updated_days_ago: 365 }]]);
    const events = detectT4({ rules: [r], signals });
    expect(events).toHaveLength(0);
  });

  it('R8-A1: 최근 30일 내 mech 변경된 rule 은 demote 후보 아님 (oscillation cooldown)', () => {
    const now = Date.parse('2026-04-22T00:00:00Z');
    const recentlyDemoted = hardRule({
      strength: 'strong',
      lifecycle: {
        phase: 'active',
        first_active_at: '',
        inject_count: 10, accept_count: 0, violation_count: 0, bypass_count: 0,
        conflict_refs: [],
        // 7일 전에 이미 demoted — cooldown(30d) 내
        meta_promotions: [{
          at: new Date(now - 7 * 24 * 3600_000).toISOString(),
          from_mech: 'A', to_mech: 'B',
          reason: 'stuck_loop_force_approve',
          trigger_stats: { window_n: 4 },
        }],
      },
    });
    const drift = Array.from({ length: 5 }, (_, i) => ({
      at: new Date(now - (i + 1) * 24 * 3600_000 + 3600_000).toISOString(),
      kind: 'stuck_loop_force_approve',
      session_id: `s${i}`,
      rule_id: recentlyDemoted.rule_id,
      count: 4,
    }));
    const candidates = scanDriftForDemotion({ rules: [recentlyDemoted], drift, now });
    expect(candidates).toHaveLength(0); // cooldown
  });

  it('비-hard rule 에는 기존 동작 유지 (회귀 없음)', () => {
    const strong = hardRule({
      strength: 'strong', // hard 아님
      enforce_via: [{ mech: 'A', hook: 'Stop', verifier: { kind: 'artifact_check', params: {} } }],
    });
    const now = Date.parse('2026-04-22T00:00:00Z');
    const drift = Array.from({ length: 4 }, (_, i) => ({
      at: new Date(now - (i + 1) * 24 * 3600_000 + 3600_000).toISOString(),
      kind: 'stuck_loop_force_approve',
      session_id: `s${i}`,
      rule_id: strong.rule_id,
      count: 4,
    }));
    const candidates = scanDriftForDemotion({ rules: [strong], drift, now });
    expect(candidates.length).toBeGreaterThanOrEqual(1);
  });
});
