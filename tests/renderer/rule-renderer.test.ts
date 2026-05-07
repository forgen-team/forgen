import { describe, it, expect, beforeEach } from 'vitest';
import { setLocale } from '../../src/i18n/index.js';
import { renderRules, DEFAULT_CONTEXT } from '../../src/renderer/rule-renderer.js';
import { createProfile } from '../../src/store/profile-store.js';
import type { Rule, SessionEffectiveState, RuntimeCapabilityState } from '../../src/store/types.js';

function makeState(overrides?: Partial<SessionEffectiveState>): SessionEffectiveState {
  const runtime: RuntimeCapabilityState = { permission_mode: 'guarded', dangerous_skip_permissions: false, auto_accept_scope: [], detected_from: 'cli' };
  return {
    session_id: 'sess-1', profile_version: '2.0', quality_pack: '균형형', autonomy_pack: '균형형', judgment_pack: '균형형', communication_pack: '균형형',
    effective_trust_policy: '승인 완화', active_rule_ids: [], temporary_overlays: [],
    runtime_capability_state: runtime, warnings: [], started_at: '', ended_at: null,
    ...overrides,
  };
}

function makeRule(overrides: Partial<Rule>): Rule {
  return {
    rule_id: 'r1', category: 'quality', scope: 'me', trigger: 't', policy: 'Test policy',
    strength: 'default', source: 'onboarding', status: 'active', evidence_refs: [],
    render_key: 'quality.test', created_at: '', updated_at: '',
    ...overrides,
  };
}

describe('renderRules', () => {
  beforeEach(() => { setLocale('ko'); });

  const profile = createProfile('u', '균형형', '균형형', '승인 완화', 'onboarding');

  it('renders empty rules gracefully', () => {
    const output = renderRules([], makeState(), profile);
    // include_pack_summary defaults to false (AI-optimized); evidence collection always present
    expect(output).toContain('Evidence Collection');
  });

  it('includes pack summary when explicitly enabled', () => {
    const output = renderRules([], makeState(), profile, { ...DEFAULT_CONTEXT, include_pack_summary: true });
    expect(output).toContain('Trust:');
    expect(output).toContain('Working Defaults');
  });

  it('hard rules go to Must Not', () => {
    const rules = [makeRule({ strength: 'hard', category: 'safety', policy: 'Never expose credentials', render_key: 'safety.creds' })];
    const output = renderRules(rules, makeState(), profile);
    expect(output).toContain('## Must Not');
    expect(output).toContain('Never expose credentials');
  });

  it('quality rules go to How To Validate with [category|strength] tag', () => {
    const rules = [makeRule({ category: 'quality', strength: 'default', policy: 'Run tests before completing' })];
    const output = renderRules(rules, makeState(), profile);
    expect(output).toContain('## How To Validate');
    expect(output).toContain('[quality|default] Run tests before completing');
  });

  it('hard rules omit category tag (Must Not section conveys meaning)', () => {
    const rules = [makeRule({ strength: 'hard', category: 'safety', policy: 'No secrets', render_key: 'safety.sec' })];
    const output = renderRules(rules, makeState(), profile);
    expect(output).toContain('- No secrets');
    expect(output).not.toContain('[safety|hard]');
  });

  it('autonomy rules go to When To Ask', () => {
    const rules = [makeRule({ category: 'autonomy', policy: 'Ask before public API change', render_key: 'autonomy.api' })];
    const output = renderRules(rules, makeState(), profile);
    expect(output).toContain('## When To Ask');
  });

  it('deduplicates by render_key — stronger wins', () => {
    const rules = [
      makeRule({ rule_id: 'weak', strength: 'soft', render_key: 'quality.dup', policy: 'soft policy' }),
      makeRule({ rule_id: 'strong', strength: 'strong', render_key: 'quality.dup', policy: 'strong policy' }),
    ];
    const output = renderRules(rules, makeState(), profile);
    expect(output).toContain('strong policy');
    expect(output).not.toContain('soft policy');
  });

  it('deduplicates by render_key — session scope wins over me', () => {
    const rules = [
      makeRule({ rule_id: 'me-rule', scope: 'me', render_key: 'quality.dup', policy: 'me version' }),
      makeRule({ rule_id: 'session-rule', scope: 'session', render_key: 'quality.dup', policy: 'session version' }),
    ];
    const output = renderRules(rules, makeState(), profile);
    expect(output).toContain('session version');
    expect(output).not.toContain('me version');
  });

  it('filters out non-active rules', () => {
    const rules = [
      makeRule({ status: 'active', policy: 'visible' }),
      makeRule({ rule_id: 'r2', status: 'suppressed', policy: 'hidden', render_key: 'quality.hidden' }),
    ];
    const output = renderRules(rules, makeState(), profile);
    expect(output).toContain('visible');
    expect(output).not.toContain('hidden');
  });

  it('respects max_chars budget', () => {
    const rules = Array.from({ length: 50 }, (_, i) =>
      makeRule({ rule_id: `r-${i}`, render_key: `quality.r${i}`, policy: `Policy number ${i} with some extra text to fill space` }),
    );
    const output = renderRules(rules, makeState(), profile, { ...DEFAULT_CONTEXT, max_chars: 500 });
    expect(output.length).toBeLessThanOrEqual(600); // 약간의 여유
  });

  it('includes warnings from state', () => {
    const output = renderRules([], makeState({ warnings: ['Trust 하향: desired=완전 신뢰, runtime=가드레일'] }), profile);
    expect(output).toContain('## Warnings');
    expect(output).toContain('Trust 하향');
  });

  // v0.4.4 (2026-05-06): facet 극단값이 렌더 출력 차별성을 만드는지 검증.
  // 사용자 피드백 + Agent B 정적 분석에서 "facet 값이 미사용"으로 드러난 결함 fix.
  describe('facet-driven rules (4축 P1)', () => {
    function profileWithFacets(o: {
      verification_depth?: number; stop_threshold?: number; change_conservatism?: number;
      confirmation_independence?: number; approval_threshold?: number;
      minimal_change_bias?: number; abstraction_bias?: number; evidence_first_bias?: number;
      verbosity?: number; structure?: number; teaching_bias?: number;
    }) {
      const p = createProfile('u', '균형형', '균형형', '승인 완화', 'onboarding');
      // override only specified facets; rest stays at default 0.5/0.45
      Object.assign(p.axes.quality_safety.facets, {
        verification_depth: o.verification_depth ?? p.axes.quality_safety.facets.verification_depth,
        stop_threshold: o.stop_threshold ?? p.axes.quality_safety.facets.stop_threshold,
        change_conservatism: o.change_conservatism ?? p.axes.quality_safety.facets.change_conservatism,
      });
      Object.assign(p.axes.autonomy.facets, {
        confirmation_independence: o.confirmation_independence ?? p.axes.autonomy.facets.confirmation_independence,
        approval_threshold: o.approval_threshold ?? p.axes.autonomy.facets.approval_threshold,
      });
      Object.assign(p.axes.judgment_philosophy.facets, {
        minimal_change_bias: o.minimal_change_bias ?? p.axes.judgment_philosophy.facets.minimal_change_bias,
        abstraction_bias: o.abstraction_bias ?? p.axes.judgment_philosophy.facets.abstraction_bias,
        evidence_first_bias: o.evidence_first_bias ?? p.axes.judgment_philosophy.facets.evidence_first_bias,
      });
      Object.assign(p.axes.communication_style.facets, {
        verbosity: o.verbosity ?? p.axes.communication_style.facets.verbosity,
        structure: o.structure ?? p.axes.communication_style.facets.structure,
        teaching_bias: o.teaching_bias ?? p.axes.communication_style.facets.teaching_bias,
      });
      return p;
    }

    it('verification_depth 극단값이 렌더 출력에 차별 만든다 (low vs high)', () => {
      const ctx = { ...DEFAULT_CONTEXT, include_pack_summary: true };
      const low = renderRules([], makeState(), profileWithFacets({ verification_depth: 0.1 }), ctx);
      const high = renderRules([], makeState(), profileWithFacets({ verification_depth: 0.9 }), ctx);
      expect(low).not.toEqual(high);
      expect(high).toContain('e2e 증거');
      expect(low).not.toContain('e2e 증거');
    });

    it('verbosity 극단값이 How To Report 차별 만든다', () => {
      const ctx = { ...DEFAULT_CONTEXT, include_pack_summary: true };
      const low = renderRules([], makeState(), profileWithFacets({ verbosity: 0.1 }), ctx);
      const high = renderRules([], makeState(), profileWithFacets({ verbosity: 0.9 }), ctx);
      expect(low).not.toEqual(high);
      expect(low).toMatch(/3\s*문장|≤\s*3/);
      expect(high).toMatch(/배경|tradeoff|대안/);
    });

    it('approval_threshold 0.9 → 비가역 작업 승인 룰 추가', () => {
      const ctx = { ...DEFAULT_CONTEXT, include_pack_summary: true };
      const out = renderRules([], makeState(), profileWithFacets({ approval_threshold: 0.9 }), ctx);
      expect(out).toMatch(/비가역|force\s*push|broadcast/i);
    });

    it('중간 값 (0.5)은 추가 facet 룰 없음 — pack 기본만', () => {
      const ctx = { ...DEFAULT_CONTEXT, include_pack_summary: true };
      const middle = renderRules([], makeState(), profileWithFacets({}), ctx);
      // verification_depth 0.5 default → "e2e 증거" 추가 룰 없어야 함
      expect(middle).not.toContain('e2e 증거');
    });

    it('include_pack_summary=false 면 facet 룰도 미적용 (DEFAULT_CONTEXT)', () => {
      // facet 룰은 pack 분기와 같은 조건에서만 emit (동일 lifecycle)
      const out = renderRules([], makeState(), profileWithFacets({ verification_depth: 0.9 }));
      expect(out).not.toContain('e2e 증거');
    });
  });
});
