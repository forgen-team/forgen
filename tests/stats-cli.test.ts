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
      { at: recent, rule_id: 'r1', kind: 'block', session_id: 's1' },
      { at: recent, rule_id: 'r1', kind: 'block', session_id: 's1' },
      { at: stale, rule_id: 'r1', kind: 'block', session_id: 's1' },
    ]);
    const s = computeStats();
    expect(s.blocks7d).toBe(2);
  });

  it('blocks7d includes block+deny+undefined, excludes correction/bypass_confirmed and synthetic sessions (ADR-017)', () => {
    const recent = new Date().toISOString();
    writeJsonl(path.join(TEST_HOME, '.forgen', 'state', 'enforcement', 'violations.jsonl'), [
      { at: recent, rule_id: 'r1', kind: 'block', session_id: 's1' },            // Mech-B Stop block
      { at: recent, rule_id: 'r1', kind: 'deny', session_id: 's1' },             // Mech-A PreToolUse deny
      { at: recent, rule_id: 'r1', kind: 'correction', session_id: 's1' },       // 메타가드 advise (excluded)
      { at: recent, rule_id: 'r1', kind: 'bypass_confirmed', session_id: 's1' }, // 사용자 명시 우회 (excluded from blocks, counted as bypass)
      { at: recent, rule_id: 'r1', session_id: 's1' },                           // legacy entry with no kind
      { at: recent, rule_id: 'r1', kind: 'deny', session_id: 'default' },        // 테스트 유래 (excluded)
      { at: recent, rule_id: 'r1', kind: 'block', session_id: 'unknown' },       // session 없는 훅 호출 (excluded)
      { at: recent, rule_id: 'r1', kind: 'bypass_confirmed', session_id: 'default' }, // (excluded)
    ]);
    // 과거 자연어 휴리스틱 기록은 더 이상 읽지 않는다
    writeJsonl(path.join(TEST_HOME, '.forgen', 'state', 'enforcement', 'bypass.jsonl'), [
      { at: recent, rule_id: 'r1', session_id: 's1', tool: 'Bash', pattern_preview: 'Team' },
    ]);
    const s = computeStats();
    expect(s.blocks7d).toBe(3); // block + deny + legacy-undefined (실세션만)
    expect(s.syntheticExcluded7d).toBe(3); // default×2 + unknown×1 — 가시화
    expect(s.bypass7d).toBe(1); // bypass_confirmed, 실세션만
    const rendered = renderStats(s);
    expect(rendered).toMatch(/Bypass \(confirmed\)\s+1/);
    expect(rendered).toMatch(/Blocks\s+3/);
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

  it('H3: assistToday counts recall hits / surfaced / extracted for today only', () => {
    const now = Date.now();
    const todayIso = new Date(now - 60_000).toISOString(); // 1 min ago
    const stateDir = path.join(TEST_HOME, '.forgen', 'state');
    const solutionsDir = path.join(TEST_HOME, '.forgen', 'me', 'solutions');

    // 2 recall hits today + 1 yesterday
    const yesterday = new Date(now - 25 * 3600_000).toISOString();
    // ADR-017: hit = source:hook + 후보 ≥1. 후보 0건·mcp(테스트/스크립트) 쿼리는 hit 아님.
    writeJsonl(path.join(stateDir, 'match-eval-log.jsonl'), [
      { source: 'hook', ts: todayIso, rankedTopN: ['a'], candidates: [{ name: 'a', relevance: 0.3 }] },
      { source: 'hook', ts: todayIso, rankedTopN: ['b'], candidates: [{ name: 'b', relevance: 0.2 }] },
      { source: 'hook', ts: todayIso, rankedTopN: [], candidates: [] },                 // attempt, not hit
      { source: 'mcp', ts: todayIso, rankedTopN: ['x'], candidates: [{ name: 'x', relevance: 0.9 }] }, // excluded
      { source: 'hook', ts: yesterday, rankedTopN: ['c'], candidates: [{ name: 'c', relevance: 0.3 }] },
    ]);

    // 1 recommendation_surfaced today + 1 drift_critical today (excluded)
    writeJsonl(path.join(stateDir, 'implicit-feedback.jsonl'), [
      { type: 'recommendation_surfaced', category: 'positive', at: todayIso, sessionId: 'S1', solution: 'sol-a' },
      { type: 'drift_critical', category: 'drift', at: todayIso, sessionId: 'S1' },
      { type: 'recommendation_surfaced', category: 'positive', at: yesterday, sessionId: 'S0', solution: 'sol-b' },
    ]);

    // 1 solution file created today, 1 older
    fs.mkdirSync(solutionsDir, { recursive: true });
    const newFile = path.join(solutionsDir, 'new-pattern.md');
    fs.writeFileSync(newFile, '---\ntitle: new\n---\n# body');
    const oldFile = path.join(solutionsDir, 'old-pattern.md');
    fs.writeFileSync(oldFile, '---\ntitle: old\n---\n# body');
    const staleTs = (now - 25 * 3600_000) / 1000;
    fs.utimesSync(oldFile, staleTs, staleTs);

    const s = computeStats();
    expect(s.assistToday.recallHits).toBe(2);
    expect(s.assistToday.recallAttempts).toBe(3);
    expect(s.assistToday.recallMcp).toBe(1);
    expect(s.assistToday.surfaced).toBe(1);
    expect(s.assistToday.extractedToday).toBe(1);

    const rendered = renderStats(s);
    expect(rendered).toMatch(/Today \(assist\)/);
    expect(rendered).toMatch(/Recall hits/);
    expect(rendered).toMatch(/Surfaced/);
    expect(rendered).toMatch(/Extracted/);
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
