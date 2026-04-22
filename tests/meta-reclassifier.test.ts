/**
 * Tests for Meta-trigger (ADR-002) — drift.jsonl scanning and Mech demotion.
 *
 * Pure scanner + apply paths isolated from IO via sandboxed homedir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DriftEntry } from '../src/engine/lifecycle/meta-reclassifier.js';
import type { Rule } from '../src/store/types.js';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-meta-${process.pid}`,
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const {
  scanDriftForDemotion,
  applyDemotion,
  demoteMech,
  readDriftEntries,
  appendLifecycleEvents,
} = await import('../src/engine/lifecycle/meta-reclassifier.js');

function rule(overrides: Partial<Rule>): Rule {
  return {
    rule_id: 'r-1',
    category: 'quality',
    scope: 'me',
    trigger: 't',
    policy: 'p',
    strength: 'strong',
    source: 'explicit_correction',
    status: 'active',
    evidence_refs: [],
    render_key: 'k',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    enforce_via: [{ mech: 'A', hook: 'Stop', verifier: { kind: 'artifact_check', params: { path: 'x' } } }],
    ...overrides,
  };
}

function driftEntry(overrides: Partial<DriftEntry>): DriftEntry {
  return {
    at: new Date().toISOString(),
    kind: 'stuck_loop_force_approve',
    session_id: 's1',
    rule_id: 'r-1',
    count: 4,
    ...overrides,
  };
}

describe('demoteMech', () => {
  it('A → B, B → C, C → null', () => {
    expect(demoteMech('A')).toBe('B');
    expect(demoteMech('B')).toBe('C');
    expect(demoteMech('C')).toBe(null);
  });
});

describe('scanDriftForDemotion', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  const now = Date.parse('2026-04-22T12:00:00Z');

  it('returns no candidates when no drift entries', () => {
    const c = scanDriftForDemotion({ rules: [rule({})], drift: [], now });
    expect(c).toHaveLength(0);
  });

  it('counts only stuck_loop_force_approve events within window', () => {
    const drift = [
      driftEntry({ at: new Date(now - 1 * 24 * 3600_000).toISOString() }),
      driftEntry({ at: new Date(now - 2 * 24 * 3600_000).toISOString() }),
      driftEntry({ at: new Date(now - 3 * 24 * 3600_000).toISOString() }),
      // outside 7-day window → excluded
      driftEntry({ at: new Date(now - 10 * 24 * 3600_000).toISOString() }),
      // wrong kind → excluded
      driftEntry({ kind: 'other_event', at: new Date(now - 1 * 24 * 3600_000).toISOString() }),
    ];
    const c = scanDriftForDemotion({ rules: [rule({})], drift, now, windowDays: 7, threshold: 3 });
    expect(c).toHaveLength(1);
    expect(c[0].event_count).toBe(3);
    expect(c[0].rule_id).toBe('r-1');
  });

  it('ignores rule below threshold', () => {
    const drift = [
      driftEntry({ at: new Date(now - 1 * 24 * 3600_000).toISOString() }),
      driftEntry({ at: new Date(now - 2 * 24 * 3600_000).toISOString() }),
    ];
    const c = scanDriftForDemotion({ rules: [rule({})], drift, now, threshold: 3 });
    expect(c).toHaveLength(0);
  });

  it('deduplicates sessions', () => {
    const drift = [
      driftEntry({ session_id: 'A', at: new Date(now - 1 * 24 * 3600_000).toISOString() }),
      driftEntry({ session_id: 'A', at: new Date(now - 2 * 24 * 3600_000).toISOString() }),
      driftEntry({ session_id: 'B', at: new Date(now - 3 * 24 * 3600_000).toISOString() }),
    ];
    const c = scanDriftForDemotion({ rules: [rule({})], drift, now });
    expect(c).toHaveLength(1);
    expect(c[0].sessions.sort()).toEqual(['A', 'B']);
  });

  it('reports current_mechs correctly', () => {
    const r = rule({
      enforce_via: [
        { mech: 'A', hook: 'Stop', verifier: { kind: 'artifact_check', params: {} } },
        { mech: 'A', hook: 'PreToolUse', verifier: { kind: 'tool_arg_regex', params: {} } },
        { mech: 'B', hook: 'Stop', verifier: { kind: 'self_check_prompt', params: {} } },
      ],
    });
    const drift = Array.from({ length: 4 }, (_, i) =>
      driftEntry({ at: new Date(now - (i + 1) * 24 * 3600_000 + 3600_000).toISOString() })
    );
    const c = scanDriftForDemotion({ rules: [r], drift, now });
    expect(c).toHaveLength(1);
    expect(c[0].current_mechs.sort()).toEqual(['A', 'B']);
  });
});

describe('applyDemotion', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('demotes all Mech-A/B specs and records meta_promotions', () => {
    const r = rule({
      rule_id: 'r-demote',
      enforce_via: [
        { mech: 'A', hook: 'Stop', verifier: { kind: 'artifact_check', params: {} } },
        { mech: 'B', hook: 'Stop', verifier: { kind: 'self_check_prompt', params: {} } },
        { mech: 'C', hook: 'PostToolUse', drift_key: 'x' },
      ],
    });
    // setup rule on disk so saveRule succeeds
    const rulesDir = path.join(TEST_HOME, '.forgen', 'me', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'r-demote.json'), JSON.stringify(r));

    const now = Date.parse('2026-04-22T12:00:00Z');
    const candidate = {
      rule_id: 'r-demote',
      event_count: 5,
      first_at: '2026-04-15T00:00:00Z',
      last_at: '2026-04-22T00:00:00Z',
      sessions: ['s1', 's2'],
      window_days: 7,
      current_mechs: ['A' as const, 'B' as const, 'C' as const],
    };
    const result = applyDemotion(r, candidate, now);
    expect(result.applied).toBe(true);
    expect(result.before_mech).toEqual(['A', 'B', 'C']);
    expect(result.after_mech).toEqual(['B', 'C', 'C']);
    expect(result.events).toHaveLength(2); // A→B and B→C, not C

    // verify persisted
    const saved = JSON.parse(fs.readFileSync(path.join(rulesDir, 'r-demote.json'), 'utf-8')) as Rule;
    expect(saved.enforce_via?.map((s) => s.mech)).toEqual(['B', 'C', 'C']);
    expect(saved.lifecycle?.meta_promotions).toHaveLength(2);
    expect(saved.lifecycle?.meta_promotions[0].reason).toBe('stuck_loop_force_approve');
  });

  it('returns applied=false when rule has no Mech-A/B', () => {
    const r = rule({
      rule_id: 'r-c-only',
      enforce_via: [{ mech: 'C', hook: 'PostToolUse', drift_key: 'x' }],
    });
    const rulesDir = path.join(TEST_HOME, '.forgen', 'me', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'r-c-only.json'), JSON.stringify(r));

    const candidate = {
      rule_id: 'r-c-only', event_count: 10, first_at: '', last_at: '', sessions: [], window_days: 7, current_mechs: ['C' as const],
    };
    const result = applyDemotion(r, candidate);
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/no Mech-A\/B/);
  });
});

describe('readDriftEntries + appendLifecycleEvents (IO)', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('readDriftEntries returns [] when file absent', () => {
    expect(readDriftEntries()).toEqual([]);
  });

  it('readDriftEntries skips malformed lines', () => {
    const dir = path.join(TEST_HOME, '.forgen', 'state', 'enforcement');
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, 'drift.jsonl');
    fs.writeFileSync(log, [
      JSON.stringify(driftEntry({})),
      'not-json',
      JSON.stringify(driftEntry({ session_id: 's2' })),
      '',
    ].join('\n'));
    const entries = readDriftEntries(log);
    expect(entries).toHaveLength(2);
  });

  it('appendLifecycleEvents writes to daily jsonl', () => {
    const now = Date.parse('2026-04-22T09:00:00Z');
    appendLifecycleEvents(
      [{ kind: 'meta_demote_to_b', rule_id: 'r1', suggested_action: 'demote_mech', ts: now }],
      now
    );
    const logPath = path.join(TEST_HOME, '.forgen', 'state', 'lifecycle', '2026-04-22.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.kind).toBe('meta_demote_to_b');
    expect(parsed.rule_id).toBe('r1');
  });
});
