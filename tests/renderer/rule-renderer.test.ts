import { describe, it, expect, beforeEach } from 'vitest';
import { setLocale } from '../../src/i18n/index.js';
import { renderRules, renderRulesDetailed, DEFAULT_CONTEXT  } from '../../src/renderer/rule-renderer.js';
import { composeRuleFiles } from '../../src/hooks/shared/injection-caps.js';
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

    it('R8: DEFAULT_CONTEXT(include_pack_summary=false)에서도 facet 룰이 렌더에 들어간다 — 프로필이 표시 전용이던 결함', () => {
      const hi = renderRules([], makeState(), profileWithFacets({ verification_depth: 0.9 }));
      expect(hi).toContain('[profile] 완료 선언 전 실행 로그');
      const mid = renderRules([], makeState(), profileWithFacets({ verification_depth: 0.5 }));
      expect(mid).not.toContain('[profile]');
      expect(hi).not.toBe(mid);
    });
    it('프로필이 null/undefined 여도 렌더가 깨지지 않는다 (null 안전)', () => {
      expect(() => renderRules([], makeState(), null)).not.toThrow();
      expect(renderRules([], makeState(), undefined)).not.toContain('[profile]');
    });
    it('facet 규칙은 예산 최하위 — 남는 자리가 없으면 빠지고 Omitted 에 표시, 룰이 먼저 자리를 차지한다', () => {
      const tight = { surface: 'session_start' as const, max_rules: 60, max_chars: 10, include_pack_summary: false };
      const out = renderRules([], makeState(), profileWithFacets({ verification_depth: 0.95 }), tight);
      expect(out).not.toContain('[profile]');
      expect(out).toMatch(/profile rules/);
      // 룰 하나가 있고 예산이 룰 하나분만 남는 경우: 룰이 들어가고 facet 이 밀린다
      const rule = { rule_id: 'r1', category: 'workflow', scope: 'me', trigger: 't', policy: '룰 하나', strength: 'strong', source: 'explicit_correction', status: 'active', evidence_refs: [], render_key: 'workflow.r1', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' } as unknown as Rule;
      const full = renderRules([rule], makeState(), profileWithFacets({ verification_depth: 0.95 }));
      expect(full.indexOf('룰 하나')).toBeGreaterThan(-1);
      expect(full.indexOf('[profile]')).toBeGreaterThan(full.indexOf('룰 하나') - 1);
    });
  });
});

describe('렌더 예산 (룰이 조용히 사라지지 않는다)', () => {
  const profile = createProfile('u', '균형형', '균형형', '승인 완화', 'onboarding');
  const rule = (id: string, strength: Rule['strength'], policy: string, source: Rule['source'] = 'explicit_correction'): Rule => ({
    rule_id: id, category: 'workflow', scope: 'me', trigger: 't', policy, strength, source, status: 'active',
    evidence_refs: [], render_key: `workflow.${id}`, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
  });
  const ctx = { surface: 'session_start', max_rules: 60, max_chars: 1200, include_pack_summary: false } as const;

  it('넘치면 strong 을 먼저 지키고 빠진 룰을 표시한다', () => {
    const defaults = Array.from({ length: 30 }, (_, i) => rule(`d${i}`, 'default', `기본 룰 ${i} ${'가'.repeat(40)}`));
    const strong = rule('s1', 'strong', '답변은 항상 한국어로');
    const r = renderRulesDetailed([...defaults, strong], makeState(), profile, ctx);
    expect(r.text).toContain('답변은 항상 한국어로');
    expect(r.included.map((x) => x.rule_id)[0]).toBe('s1');
    expect(r.omitted.length).toBeGreaterThan(0);
    expect(r.included.length + r.omitted.length).toBe(31);
    expect(r.text).toContain(`${r.omitted.length} lower-priority rules omitted`);
    for (const o of r.omitted) expect(r.text).not.toContain(o.policy);
  });

  it('사용자 교정이 같은 강도의 채굴 룰보다 먼저다', () => {
    const r = renderRulesDetailed([
      ...Array.from({ length: 30 }, (_, i) => rule(`m${i}`, 'default', `채굴 ${i} ${'나'.repeat(40)}`, 'behavior_inference')),
      rule('e1', 'default', '오너 교정 룰'),
    ], makeState(), profile, ctx);
    expect(r.included.map((x) => x.rule_id)).toContain('e1');
  });

  it('교정 기록 지시는 룰이 많아도 항상 들어간다', () => {
    const many = Array.from({ length: 80 }, (_, i) => rule(`x${i}`, 'strong', `룰 ${i} ${'다'.repeat(60)}`));
    expect(renderRulesDetailed(many, makeState(), profile, ctx).text).toContain('correction-record');
  });

  it('상한 안이면 빠지는 룰이 없고 생략 표시도 없다', () => {
    const r = renderRulesDetailed([rule('a', 'default', '짧은 룰')], makeState(), profile, ctx);
    expect(r.omitted).toEqual([]);
    expect(r.text).not.toContain('## Omitted');
  });
});

describe('composeRuleFiles', () => {
  it('사용자 룰을 먼저 배치하고 줄 경계에서 자른다', () => {
    const long = Array.from({ length: 400 }, (_, i) => `- 줄 ${i}`).join('\n');
    const { files } = composeRuleFiles({ 'project-context.md': long, 'v1-rules.md': '# rules\n- 한국어' });
    expect(files[0].filename).toBe('v1-rules.md');
    const ctxFile = files.find((f) => f.filename === 'project-context.md');
    expect(ctxFile?.truncated).toBe(true);
    const beforeNote = ctxFile?.content.split('\n... (capped')[0] ?? '';
    expect(beforeNote.split('\n').at(-1)).toMatch(/^- 줄 \d+$/);
  });

  it('총량을 넘으면 뒤 파일만 빠지고 목록으로 알린다', () => {
    const big = 'x'.repeat(2900);
    const map: Record<string, string> = {};
    for (let i = 0; i < 8; i++) map[`f${i}.md`] = big;
    const { files, omitted } = composeRuleFiles(map);
    expect(files.length).toBe(2);
    expect(omitted.length).toBe(6);
  });
});
