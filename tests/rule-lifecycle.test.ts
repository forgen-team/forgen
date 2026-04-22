/**
 * R6-F1 unit tests for rule-lifecycle factory.
 */
import { describe, it, expect } from 'vitest';
import type { Rule } from '../src/store/types.js';
import { initLifecycle, safeCount, bumpInject, appendMetaPromotion } from '../src/store/rule-lifecycle.js';

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
    render_key: 'k',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

describe('safeCount', () => {
  it('정상 양수 → 그대로', () => { expect(safeCount(5)).toBe(5); });
  it('0 → 0', () => { expect(safeCount(0)).toBe(0); });
  it('음수 → 0', () => { expect(safeCount(-3)).toBe(0); });
  it('NaN → 0', () => { expect(safeCount(NaN)).toBe(0); });
  it('Infinity → 0', () => { expect(safeCount(Infinity)).toBe(0); });
  it('string → 0', () => { expect(safeCount('5')).toBe(0); });
  it('undefined → 0', () => { expect(safeCount(undefined)).toBe(0); });
});

describe('initLifecycle', () => {
  it('lifecycle 없는 rule → phase=active + 모든 카운터 0', () => {
    const r = rule({});
    const lc = initLifecycle(r);
    expect(lc.phase).toBe('active');
    expect(lc.first_active_at).toBe(r.created_at);
    expect(lc.inject_count).toBe(0);
    expect(lc.accept_count).toBe(0);
    expect(lc.violation_count).toBe(0);
    expect(lc.bypass_count).toBe(0);
    expect(lc.conflict_refs).toEqual([]);
    expect(lc.meta_promotions).toEqual([]);
  });

  it('기존 lifecycle 있으면 복사 반환 (mutation 방지)', () => {
    const r = rule({
      lifecycle: {
        phase: 'flagged',
        first_active_at: '2026-01-01',
        inject_count: 10,
        accept_count: 5,
        violation_count: 3,
        bypass_count: 0,
        conflict_refs: ['other-rule'],
        meta_promotions: [{
          at: 'x', from_mech: 'A', to_mech: 'B',
          reason: 'stuck_loop_force_approve',
          trigger_stats: { window_n: 5 },
        }],
      },
    });
    const lc = initLifecycle(r);
    expect(lc.phase).toBe('flagged');
    expect(lc.inject_count).toBe(10);
    expect(lc.conflict_refs).toEqual(['other-rule']);
    expect(lc.meta_promotions).toHaveLength(1);
    // mutation 방지 — 반환값 수정해도 원본 lifecycle 변화 없음
    lc.conflict_refs.push('new-ref');
    expect(r.lifecycle!.conflict_refs).toEqual(['other-rule']);
  });

  it('lifecycle 카운터가 corrupt (음수/NaN) 이면 safeCount 로 정규화', () => {
    const r = rule({
      lifecycle: {
        phase: 'active',
        first_active_at: '',
        inject_count: -5 as unknown as number,
        accept_count: NaN as unknown as number,
        violation_count: 2,
        bypass_count: Infinity as unknown as number,
        conflict_refs: [],
        meta_promotions: [],
      },
    });
    const lc = initLifecycle(r);
    expect(lc.inject_count).toBe(0);
    expect(lc.accept_count).toBe(0);
    expect(lc.violation_count).toBe(2);
    expect(lc.bypass_count).toBe(0);
  });

  it('conflict_refs/meta_promotions 가 배열이 아니면 빈 배열로', () => {
    const r = rule({
      lifecycle: {
        phase: 'active',
        first_active_at: '',
        inject_count: 0, accept_count: 0, violation_count: 0, bypass_count: 0,
        conflict_refs: null as unknown as string[],
        meta_promotions: 'bad' as unknown as [],
      },
    });
    const lc = initLifecycle(r);
    expect(lc.conflict_refs).toEqual([]);
    expect(lc.meta_promotions).toEqual([]);
  });
});

describe('bumpInject', () => {
  it('inject_count 증가 + last_inject_at 갱신', () => {
    const r = rule({});
    const lc0 = initLifecycle(r);
    const lc1 = bumpInject(lc0, '2026-05-01T00:00:00Z');
    expect(lc1.inject_count).toBe(1);
    expect(lc1.last_inject_at).toBe('2026-05-01T00:00:00Z');
    // immutable
    expect(lc0.inject_count).toBe(0);
    expect(lc0.last_inject_at).toBeUndefined();
  });
});

describe('appendMetaPromotion', () => {
  it('새 promotion 추가, 원본 불변', () => {
    const r = rule({});
    const lc0 = initLifecycle(r);
    const promo = {
      at: '2026-05-01', from_mech: 'B' as const, to_mech: 'A' as const,
      reason: 'consistent_adherence' as const,
      trigger_stats: { window_n: 20, adherence_rate: 1 },
    };
    const lc1 = appendMetaPromotion(lc0, promo);
    expect(lc1.meta_promotions).toHaveLength(1);
    expect(lc0.meta_promotions).toHaveLength(0);
  });
});
