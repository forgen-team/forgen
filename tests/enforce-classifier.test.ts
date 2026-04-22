/**
 * Tests for enforce-classifier — ADR-001 §Migration heuristics.
 *
 * classify() 는 pure: rule → proposal. 파일 I/O 없음.
 */
import { describe, it, expect } from 'vitest';
import type { Rule } from '../src/store/types.js';
import { classify, applyProposal } from '../src/engine/enforce-classifier.js';

function ruleOf(overrides: Partial<Rule>): Rule {
  return {
    rule_id: 'r1',
    category: 'quality',
    scope: 'me',
    trigger: '',
    policy: '',
    strength: 'default',
    source: 'explicit_correction',
    status: 'active',
    evidence_refs: [],
    render_key: 'test.r1',
    created_at: '2026-04-22T00:00:00Z',
    updated_at: '2026-04-22T00:00:00Z',
    ...overrides,
  };
}

describe('enforce-classifier.classify', () => {
  it('destructive command → Mech-A PreToolUse + tool_arg_regex', () => {
    const r = ruleOf({ trigger: 'dangerous-command', policy: 'confirm before rm -rf on home dir' });
    const p = classify(r);
    const a = p.proposed.find((s) => s.mech === 'A' && s.hook === 'PreToolUse');
    expect(a).toBeDefined();
    expect(a?.verifier?.kind).toBe('tool_arg_regex');
    expect(p.reasoning.join(' ')).toMatch(/destructive/);
  });

  it('completion keyword → Mech-A Stop + artifact_check', () => {
    const r = ruleOf({
      trigger: 'test-completion-criteria',
      policy: 'forgen 프로젝트에서 변경 후 반드시 docker e2e 까지 통과시켜야 완료다.',
      strength: 'strong',
    });
    const p = classify(r);
    const a = p.proposed.find((s) => s.mech === 'A' && s.hook === 'Stop');
    expect(a).toBeDefined();
    expect(a?.verifier?.kind).toBe('artifact_check');
    expect(a?.verifier?.params.path).toBe('.forgen/state/e2e-result.json');
  });

  it('strong strength + style context → Mech-B Stop + self_check_prompt', () => {
    const r = ruleOf({
      trigger: 'verbose-style',
      policy: '응답은 간결한 톤으로 작성하라. 불필요한 장황함 금지.',
      strength: 'strong',
    });
    const p = classify(r);
    const b = p.proposed.find((s) => s.mech === 'B');
    expect(b).toBeDefined();
    expect(b?.verifier?.kind).toBe('self_check_prompt');
  });

  it('soft/default + mechanical pattern absent → Mech-C drift', () => {
    const r = ruleOf({
      trigger: 'async-pref',
      policy: 'use async/await not .then()',
      strength: 'default',
    });
    const p = classify(r);
    // 'async' 는 mechanical 이지만 현 휴리스틱은 강제 unsafe 판정은 안 함 → Mech-C fallback
    expect(p.proposed.length).toBeGreaterThan(0);
    const hasC = p.proposed.some((s) => s.mech === 'C');
    expect(hasC).toBe(true);
  });

  it('compound (destructive + completion) → multiple mech proposals', () => {
    const r = ruleOf({
      trigger: 'deploy-safety',
      policy: 'rm -rf 후 완료 선언 전 e2e 통과 확인 필수',
      strength: 'hard',
    });
    const p = classify(r);
    // destructive → A/PreToolUse
    // completion → A/Stop
    expect(p.proposed.some((s) => s.hook === 'PreToolUse')).toBe(true);
    expect(p.proposed.some((s) => s.hook === 'Stop' && s.mech === 'A')).toBe(true);
  });

  it('applyProposal does not overwrite existing enforce_via (force=false)', () => {
    const existing = ruleOf({
      enforce_via: [{ mech: 'A', hook: 'Stop' }],
    });
    const p = classify(existing);
    const updated = applyProposal(existing, p);
    expect(updated.enforce_via).toEqual([{ mech: 'A', hook: 'Stop' }]);
  });

  it('applyProposal overwrites when force=true', () => {
    const existing = ruleOf({
      trigger: 'rm -rf preview',
      policy: 'guard rm -rf',
      enforce_via: [{ mech: 'A', hook: 'Stop' }],
    });
    const p = classify(existing);
    const updated = applyProposal(existing, p, { force: true });
    expect(updated.enforce_via?.[0].hook).toBe('PreToolUse');
    expect(updated.enforce_via?.[0].mech).toBe('A');
  });

  it('applyProposal bumps updated_at', () => {
    const r = ruleOf({ trigger: 'done declaration', policy: 'e2e before done' });
    const before = r.updated_at;
    const p = classify(r);
    // ensure clock moves
    const updated = applyProposal(r, p);
    expect(updated.updated_at).not.toBe(before);
  });
});
