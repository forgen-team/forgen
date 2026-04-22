/**
 * Integration test: appendEvidence(explicit_correction) fires T1 and transitions rules.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-t1-${process.pid}`,
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { appendEvidence, createEvidence } = await import('../src/store/evidence-store.js');
const { createRule, saveRule, loadRule } = await import('../src/store/rule-store.js');

describe('T1 integration (appendEvidence → orchestrator)', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('avoid-this correction → T1 fires → rule.status=removed + phase=retired', () => {
    const rule = createRule({
      category: 'quality',
      scope: 'me',
      trigger: 'verbose-errors',
      policy: 'always include stack trace in error logs',
      strength: 'default',
      source: 'explicit_correction',
      render_key: 'quality_safety.verbose-errors',
    });
    saveRule(rule);

    const evidence = createEvidence({
      type: 'explicit_correction',
      session_id: 's-t1',
      source_component: 'mcp:correction-record',
      summary: 'stop including stack trace in errors — too verbose',
      axis_refs: ['quality_safety'],
      confidence: 0.9,
      raw_payload: { kind: 'avoid-this', target: 'verbose-errors', axis_hint: 'quality_safety' },
    });
    const result = appendEvidence(evidence);
    expect(result.saved).toBe(true);
    expect(result.t1_events).toBeGreaterThan(0);

    const after = loadRule(rule.rule_id);
    expect(after?.status).toBe('removed'); // retire via avoid-this
    expect(after?.lifecycle?.phase).toBe('retired');
  });

  it('prefer-from-now correction → T1 supersede', () => {
    const rule = createRule({
      category: 'workflow',
      scope: 'me',
      trigger: 'early-return',
      policy: 'early return over nested if',
      strength: 'default',
      source: 'explicit_correction',
      render_key: 'judgment_philosophy.early-return',
    });
    saveRule(rule);

    const evidence = createEvidence({
      type: 'explicit_correction',
      session_id: 's-t1b',
      source_component: 'mcp:correction-record',
      summary: 'prefer early-return going forward',
      axis_refs: ['judgment_philosophy'],
      confidence: 0.8,
      raw_payload: { kind: 'prefer-from-now', target: 'early-return', axis_hint: 'judgment_philosophy' },
    });
    appendEvidence(evidence);

    const after = loadRule(rule.rule_id);
    expect(after?.lifecycle?.phase).toBe('superseded');
    expect(after?.status).toBe('superseded');
  });

  it('non-explicit_correction evidence → no T1 events, rule untouched', () => {
    const rule = createRule({
      category: 'quality',
      scope: 'me',
      trigger: 'async-pref',
      policy: 'use async/await',
      strength: 'default',
      source: 'behavior_inference',
      render_key: 'quality_safety.async-pref',
    });
    saveRule(rule);

    const evidence = createEvidence({
      type: 'behavior_observation',
      session_id: 's-t1c',
      source_component: 'auto-compound',
      summary: 'used async/await consistently',
      axis_refs: ['quality_safety'],
      confidence: 0.6,
    });
    const result = appendEvidence(evidence);
    expect(result.t1_events).toBe(0);

    const after = loadRule(rule.rule_id);
    expect(after?.status).toBe('active');
    expect(after?.lifecycle).toBeUndefined();
  });

  it('lifecycle event appended to daily jsonl', () => {
    const rule = createRule({
      category: 'quality',
      scope: 'me',
      trigger: 'retire-me',
      policy: 'something to retire',
      strength: 'default',
      source: 'explicit_correction',
      render_key: 'quality_safety.retire-me',
    });
    saveRule(rule);

    const evidence = createEvidence({
      type: 'explicit_correction',
      session_id: 's-t1d',
      source_component: 'mcp:correction-record',
      summary: 'retire-me is no longer wanted',
      axis_refs: ['quality_safety'],
      confidence: 0.9,
      raw_payload: { kind: 'avoid-this', target: 'retire-me' },
    });
    appendEvidence(evidence);

    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(TEST_HOME, '.forgen', 'state', 'lifecycle', `${today}.jsonl`);
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, 'utf-8').trim();
    expect(content).toContain('t1_explicit_correction');
  });
});
