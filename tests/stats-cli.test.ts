/**
 * R9-PA1: forgen stats aggregation tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-stats-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { computeStats, renderStats } = await import('../src/core/stats-cli.js');
const { saveRule, createRule } = await import('../src/store/rule-store.js');
const { saveEvidence } = await import('../src/store/evidence-store.js');

function writeJsonl(p: string, entries: unknown[]): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

describe('forgen stats — R9-PA1', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('empty state yields zero counts and "never" extraction', () => {
    const s = computeStats();
    expect(s.activeRules).toBe(0);
    expect(s.correctionsTotal).toBe(0);
    expect(s.blocks7d).toBe(0);
    expect(s.acks7d).toBe(0);
    expect(s.bypass7d).toBe(0);
    expect(s.drift7d).toBe(0);
    expect(s.retired7d).toBe(0);
    expect(s.lastExtraction).toBe('never');
  });

  it('counts active vs suppressed rules correctly', () => {
    saveRule(createRule({
      category: 'workflow', scope: 'me', trigger: 'a', policy: 'p',
      source: 'explicit_correction', strength: 'soft', render_key: 'workflow.a',
    }));
    const suppressed = createRule({
      category: 'workflow', scope: 'me', trigger: 'b', policy: 'p',
      source: 'explicit_correction', strength: 'soft', render_key: 'workflow.b',
    });
    suppressed.status = 'suppressed';
    saveRule(suppressed);
    const s = computeStats();
    expect(s.activeRules).toBe(1);
    expect(s.suppressedRules).toBe(1);
  });

  it('7-day window excludes older blocks', () => {
    const now = Date.now();
    const recent = new Date(now - 2 * 86400_000).toISOString();
    const stale = new Date(now - 30 * 86400_000).toISOString();
    writeJsonl(path.join(TEST_HOME, '.forgen', 'state', 'enforcement', 'violations.jsonl'), [
      { at: recent, rule_id: 'r1', kind: 'block' },
      { at: recent, rule_id: 'r1', kind: 'block' },
      { at: stale, rule_id: 'r1', kind: 'block' },
    ]);
    const s = computeStats();
    expect(s.blocks7d).toBe(2);
  });

  it('blocks7d includes block+deny+undefined, excludes correction audit entries', () => {
    const recent = new Date().toISOString();
    writeJsonl(path.join(TEST_HOME, '.forgen', 'state', 'enforcement', 'violations.jsonl'), [
      { at: recent, rule_id: 'r1', kind: 'block' },       // Mech-B Stop block
      { at: recent, rule_id: 'r1', kind: 'deny' },        // Mech-A PreToolUse deny
      { at: recent, rule_id: 'r1', kind: 'correction' },  // user bypass audit (excluded)
      { at: recent, rule_id: 'r1' },                       // legacy entry with no kind
    ]);
    const s = computeStats();
    expect(s.blocks7d).toBe(3); // block + deny + legacy-undefined
  });

  it('counts acknowledgments within 7d', () => {
    const now = Date.now();
    writeJsonl(path.join(TEST_HOME, '.forgen', 'state', 'enforcement', 'acknowledgments.jsonl'), [
      { at: new Date(now - 86400_000).toISOString(), session_id: 's1', rule_id: 'r1', block_count: 2 },
      { at: new Date(now - 30 * 86400_000).toISOString(), session_id: 's2', rule_id: 'r1', block_count: 1 },
    ]);
    const s = computeStats();
    expect(s.acks7d).toBe(1);
  });

  it('counts retired/supersede lifecycle events within 7d', () => {
    const now = Date.now();
    const dir = path.join(TEST_HOME, '.forgen', 'state', 'lifecycle');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-04-22.jsonl'), [
      JSON.stringify({ kind: 't4_time_decay', suggested_action: 'retire', ts: now - 86400_000 }),
      JSON.stringify({ kind: 't5_conflict', suggested_action: 'supersede', ts: now - 2 * 86400_000 }),
      JSON.stringify({ kind: 't2_violation', suggested_action: 'demote', ts: now - 86400_000 }),
      JSON.stringify({ kind: 't4_time_decay', suggested_action: 'retire', ts: now - 30 * 86400_000 }),
    ].join('\n'));
    const s = computeStats();
    expect(s.retired7d).toBe(2);
  });

  it('render output includes all 7 numbers + labels', () => {
    saveEvidence({
      evidence_id: 'e1', type: 'explicit_correction', session_id: 's1',
      timestamp: new Date().toISOString(), source_component: 'mcp',
      summary: 'test', axis_refs: ['quality_safety'], candidate_rule_refs: [],
      confidence: 0.9, raw_payload: { kind: 'prefer-from-now' },
    });
    const s = computeStats();
    const rendered = renderStats(s);
    expect(rendered).toMatch(/Active rules/);
    expect(rendered).toMatch(/Corrections \(total\)/);
    expect(rendered).toMatch(/Blocks/);
    expect(rendered).toMatch(/Bypass/);
    expect(rendered).toMatch(/Drift events/);
    expect(rendered).toMatch(/Retired rules/);
    expect(rendered).toMatch(/Last extraction/);
  });
});
