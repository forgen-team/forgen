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
  it('destructive command → Mech-A PreToolUse + tool_arg_regex matching the actual literal', () => {
    const r = ruleOf({ trigger: 'dangerous-command', policy: 'confirm before rm -rf on home dir' });
    const p = classify(r);
    const a = p.proposed.find((s) => s.mech === 'A' && s.hook === 'PreToolUse');
    expect(a).toBeDefined();
    expect(a?.verifier?.kind).toBe('tool_arg_regex');
    // C1 regression: pattern 이 "credentials" 로 잘못 고정되면 안 됨.
    const pattern = String(a?.verifier?.params.pattern ?? '');
    expect(pattern).not.toBe('credentials');
    // "rm -rf" 구문이 매칭되어야 함.
    expect(new RegExp(pattern, 'i').test('rm -rf /tmp/foo')).toBe(true);
    expect(p.reasoning.join(' ')).toMatch(/rm/);
  });

  it('destructive: .env credentials rule → pattern matches literal, not "credentials" as alt-first', () => {
    const r = ruleOf({ trigger: 'secret-commit', policy: 'do not commit .env files with credentials' });
    const p = classify(r);
    const a = p.proposed.find((s) => s.mech === 'A' && s.hook === 'PreToolUse');
    expect(a).toBeDefined();
    const pattern = String(a?.verifier?.params.pattern ?? '');
    // pattern 이 실제 텍스트에서 매칭된 literal을 기반으로 해야 함 (credentials 또는 .env)
    expect(['\\.env', 'credentials']).toContain(pattern);
    // .env 라면 reasoning 에 반영
    expect(p.reasoning.join(' ')).toMatch(/credentials|\.env/);
  });

  it('destructive: DROP TABLE rule → pattern catches the specific SQL literal', () => {
    const r = ruleOf({ trigger: 'db-safety', policy: 'never DROP TABLE in production' });
    const p = classify(r);
    const a = p.proposed.find((s) => s.mech === 'A' && s.hook === 'PreToolUse');
    expect(a).toBeDefined();
    const pattern = String(a?.verifier?.params.pattern ?? '');
    expect(new RegExp(pattern, 'i').test('DROP TABLE users')).toBe(true);
  });

  it('completion + 명시적 증거 경로 → Mech-A Stop + artifact_check (경로 추출, ~/ 제거)', () => {
    const r = ruleOf({
      trigger: 'test-completion-criteria',
      policy: '통과 증거가 ~/.forgen/state/e2e-result.json 에 최근 1시간 내 생성되어야 완료다.',
      strength: 'strong',
    });
    const p = classify(r);
    const a = p.proposed.find((s) => s.mech === 'A' && s.hook === 'Stop');
    expect(a).toBeDefined();
    expect(a?.verifier?.kind).toBe('artifact_check');
    expect(a?.verifier?.params.path).toBe('.forgen/state/e2e-result.json');
  });

  it('completion + 경로 미명시 → Mech-B self_check (죽은 e2e 디폴트 재생산 금지 — 리뷰 회귀 방지)', () => {
    const r = ruleOf({
      trigger: 'test-completion-criteria',
      policy: 'forgen 프로젝트에서 변경 후 반드시 docker e2e 까지 통과시켜야 완료다.',
      strength: 'strong',
    });
    const p = classify(r);
    // 죽은 디폴트 artifact_check 가 더 이상 제안되지 않는다
    expect(p.proposed.some((s) => s.verifier?.kind === 'artifact_check')).toBe(false);
    const b = p.proposed.find((s) => s.mech === 'B' && s.hook === 'Stop');
    expect(b).toBeDefined();
    expect(b?.verifier?.kind).toBe('self_check_prompt');
    expect(b?.system_tag).toContain('completion-self-check');
    // 중복 self-check 없음 (Mech-B 일반 분기와 합쳐 1개만)
    expect(p.proposed.filter((s) => s.verifier?.kind === 'self_check_prompt').length).toBe(1);
  });

  it('폐지/완화 룰 → 완료 게이트 미제안 (게이트 해제 룰이 게이트를 강제하는 오분류 방지)', () => {
    // 실사례: e2e 게이트 폐지 교정 룰이 "완료"+경로 텍스트 때문에 artifact_check 를 부착받아
    // 폐지 대상 게이트를 스스로 강제했다 (rule efe2580a).
    const r = ruleOf({
      trigger: 'e2e-gate-repeal',
      policy: '완료 선언에 Docker e2e 증거(~/.forgen/state/e2e-result.json)를 더 이상 요구하지 않는다. 기존 룰을 완화.',
      strength: 'strong',
    });
    const p = classify(r);
    expect(p.proposed.some((s) => s.verifier?.kind === 'artifact_check')).toBe(false);
    expect(p.proposed.some((s) => s.hook === 'Stop' && s.mech === 'A')).toBe(false);
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
    // completion (경로 미명시) → B/Stop self_check — 죽은 e2e 디폴트 제거 후 의미 변화
    expect(p.proposed.some((s) => s.hook === 'PreToolUse')).toBe(true);
    expect(p.proposed.some((s) => s.hook === 'Stop' && s.verifier?.kind === 'self_check_prompt')).toBe(true);
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
