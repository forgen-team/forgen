/**
 * Bypass detector (T3 signal source) — pure tests.
 */
import { describe, it, expect } from 'vitest';
import type { Rule } from '../src/store/types.js';
import { extractBypassPatterns, scanForBypass } from '../src/engine/lifecycle/bypass-detector.js';

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    rule_id: 'r-' + Math.random().toString(36).slice(2, 8),
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

describe('extractBypassPatterns', () => {
  it('"use async/await not .then()" → [".then()"]', () => {
    const r = rule({ policy: 'use async/await not .then()' });
    const pats = extractBypassPatterns(r);
    expect(pats.length).toBeGreaterThan(0);
    // escaped form — regex of ".then()" literal
    expect(pats.some((p) => /then/.test(p))).toBe(true);
  });

  it('"avoid vi.mock" → ["vi.mock"]', () => {
    const r = rule({ policy: 'avoid vi.mock in production code' });
    const pats = extractBypassPatterns(r);
    expect(pats.some((p) => /vi\\\.mock/.test(p))).toBe(true);
  });

  it('"never use rm -rf" → ["rm"]', () => {
    const r = rule({ policy: 'never use rm -rf without confirmation' });
    const pats = extractBypassPatterns(r);
    expect(pats.some((p) => /rm/.test(p))).toBe(true);
  });

  it('Korean "sudo 쓰지 마" → ["sudo"]', () => {
    const r = rule({ policy: 'sudo 쓰지 마라. 필요하면 명시적 승인 받아' });
    const pats = extractBypassPatterns(r);
    expect(pats.some((p) => /sudo/.test(p))).toBe(true);
  });

  it('positive-only policy ("always use X") → []', () => {
    const r = rule({ policy: 'always include stack trace in error logs' });
    expect(extractBypassPatterns(r)).toHaveLength(0);
  });

  // RC5/E9 fix — Korean generic verb "실행" should NOT be extracted as a pattern
  it('L1-no-rm-rf-unconfirmed policy → "rm -rf"/"DROP"/"force-push", NOT "실행"', () => {
    const r = rule({
      rule_id: 'L1-no-rm-rf-unconfirmed',
      policy: '파괴적 명령(rm -rf, DROP, force-push)은 사용자 확인 없이 실행하지 마라.',
    });
    const pats = extractBypassPatterns(r);
    // Must NOT match generic Korean verb
    expect(pats.some((p) => /^실행$/.test(p))).toBe(false);
    expect(pats.some((p) => /^실행하지$/.test(p))).toBe(false);
    // Should extract concrete examples from parens
    expect(pats.some((p) => /rm/.test(p))).toBe(true);
    expect(pats.some((p) => /DROP/.test(p))).toBe(true);
  });

  it('does NOT match generic word "실행" in tool output (RC5/E9 regression)', () => {
    const r = rule({
      rule_id: 'L1-no-rm-rf-unconfirmed',
      policy: '파괴적 명령(rm -rf, DROP, force-push)은 사용자 확인 없이 실행하지 마라.',
    });
    const out = scanForBypass({
      rules: [r],
      tool_name: 'Bash',
      tool_output: 'echo "테스트 실행 중"', // contains "실행" but not actual rm -rf
      session_id: 's-test',
    });
    expect(out).toHaveLength(0);
  });

  it('DOES match actual "rm -rf" in Bash output', () => {
    const r = rule({
      rule_id: 'L1-no-rm-rf-unconfirmed',
      policy: '파괴적 명령(rm -rf, DROP, force-push)은 사용자 확인 없이 실행하지 마라.',
    });
    const out = scanForBypass({
      rules: [r],
      tool_name: 'Bash',
      tool_output: 'rm -rf /tmp/cache',
      session_id: 's-test',
    });
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('scanForBypass', () => {
  it('matches pattern in tool output → candidate returned', () => {
    const r = rule({ rule_id: 'r-async', policy: 'use async/await not .then()' });
    const out = scanForBypass({
      rules: [r],
      tool_name: 'Write',
      tool_output: 'fetchUser().then(x => console.log(x))',
      session_id: 's1',
    });
    expect(out).toHaveLength(1);
    expect(out[0].rule_id).toBe('r-async');
    expect(out[0].tool).toBe('Write');
  });

  it('no match → no candidates', () => {
    const r = rule({ policy: 'use async/await not .then()' });
    const out = scanForBypass({
      rules: [r],
      tool_name: 'Write',
      tool_output: 'const x = await fetchUser(); console.log(x);',
      session_id: 's1',
    });
    expect(out).toHaveLength(0);
  });

  it('inactive rule → skipped', () => {
    const r = rule({ status: 'removed', policy: 'avoid vi.mock' });
    const out = scanForBypass({
      rules: [r],
      tool_name: 'Write',
      tool_output: 'vi.mock("fs")',
      session_id: 's1',
    });
    expect(out).toHaveLength(0);
  });

  it('same rule+pattern matched multiple times → reported once', () => {
    const r = rule({ policy: 'avoid vi.mock' });
    const out = scanForBypass({
      rules: [r],
      tool_name: 'Write',
      tool_output: 'vi.mock("a"); vi.mock("b"); vi.mock("c");',
      session_id: 's1',
    });
    expect(out).toHaveLength(1);
  });

  it('multi-rule: each active rule checked independently', () => {
    const a = rule({ rule_id: 'ra', policy: 'avoid vi.mock' });
    const b = rule({ rule_id: 'rb', policy: 'never use rm -rf' });
    const out = scanForBypass({
      rules: [a, b],
      tool_name: 'Bash',
      tool_output: 'vi.mock is fine, but rm -rf is a problem',
      session_id: 's1',
    });
    expect(out).toHaveLength(2);
    expect(new Set(out.map((c) => c.rule_id))).toEqual(new Set(['ra', 'rb']));
  });

  it('positive-only policy → no bypass detection', () => {
    const r = rule({ policy: 'always use early return' });
    const out = scanForBypass({
      rules: [r],
      tool_name: 'Write',
      tool_output: 'if (x) { if (y) { ... } }',
      session_id: 's1',
    });
    expect(out).toHaveLength(0);
  });
});
