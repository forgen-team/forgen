import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-weakness-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { buildWeaknessReport } = await import('../src/engine/solution-weakness.js');
const { ME_SOLUTIONS } = await import('../src/core/paths.js');

function writeSolution(name: string, tags: string[]): void {
  fs.mkdirSync(ME_SOLUTIONS, { recursive: true });
  const fm = {
    name,
    version: 1,
    status: 'verified',
    confidence: 0.7,
    type: 'pattern',
    scope: 'me',
    tags,
    identifiers: [] as string[],
    created: '2026-04-16',
    updated: '2026-04-16',
    supersedes: null,
    extractedBy: 'manual',
    evidence: { injected: 0, reflected: 0, negative: 0, sessions: 0, reExtracted: 0 },
  };
  const yamlStr = yaml.dump(fm);
  fs.writeFileSync(path.join(ME_SOLUTIONS, `${name}.md`), `---\n${yamlStr}---\n\nbody\n`);
}

function writeOutcome(sessionId: string, solution: string, outcome: 'accept' | 'correct' | 'error' | 'unknown', tsOffset = 0): void {
  const dir = path.join(TEST_HOME, '.forgen', 'state', 'outcomes');
  fs.mkdirSync(dir, { recursive: true });
  const event = {
    ts: Date.now() + tsOffset,
    session_id: sessionId,
    solution,
    match_score: 0.5,
    injected_chars: 100,
    outcome,
    outcome_lag_ms: 1000,
    attribution: 'default',
  };
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify(event) + '\n');
}

describe('buildWeaknessReport', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('returns empty report when no solutions or events', () => {
    const report = buildWeaknessReport();
    expect(report.population.total).toBe(0);
    expect(report.under_served_tags).toEqual([]);
    expect(report.conflict_clusters).toEqual([]);
    expect(report.dead_corners).toEqual([]);
    expect(report.volatile).toEqual([]);
  });

  it('detects dead corners (injected=0 with unique tags)', () => {
    writeSolution('champion', ['common', 'shared']);
    writeSolution('dead', ['common', 'very-specific-unique']);
    // Champion has events so it escapes the "never injected" bucket
    for (let i = 0; i < 15; i++) writeOutcome('s1', 'champion', 'accept', i);
    const report = buildWeaknessReport();
    const deadNames = report.dead_corners.map((d) => d.solution);
    expect(deadNames).toContain('dead');
    const dead = report.dead_corners.find((d) => d.solution === 'dead');
    expect(dead?.unique_tags).toContain('very-specific-unique');
  });

  it('detects conflict clusters (champion and underperform share tags)', () => {
    writeSolution('ch', ['auth', 'login', 'flow']);
    writeSolution('up', ['auth', 'login', 'session']);
    // Champion: 15 accept
    for (let i = 0; i < 15; i++) writeOutcome('s1', 'ch', 'accept', i);
    // Underperform: 2 accept + 10 correct (well below median)
    // Need a second active/champion to establish a median floor
    writeSolution('ok', ['other']);
    for (let i = 0; i < 15; i++) writeOutcome('s2', 'ok', 'accept', i + 100);
    for (let i = 0; i < 2; i++) writeOutcome('s3', 'up', 'accept', i + 200);
    for (let i = 0; i < 10; i++) writeOutcome('s3', 'up', 'correct', i + 210);
    const report = buildWeaknessReport();
    const cluster = report.conflict_clusters.find(
      (c) => c.champion.name === 'ch' && c.underperform.name === 'up',
    );
    expect(cluster).toBeDefined();
    expect(cluster?.shared_tags.length).toBeGreaterThanOrEqual(2);
  });

  it('detects volatile solutions (accept rate shifts >0.3 across time)', () => {
    writeSolution('volatile', ['foo']);
    // Window A: 5 accepts → accept rate 1.0
    for (let i = 0; i < 5; i++) writeOutcome('s1', 'volatile', 'accept', i * 1000);
    // Window B: 5 corrects → accept rate 0.0
    for (let i = 0; i < 5; i++) writeOutcome('s2', 'volatile', 'correct', 10000 + i * 1000);
    const report = buildWeaknessReport();
    const vol = report.volatile.find((v) => v.solution === 'volatile');
    expect(vol).toBeDefined();
    expect(Math.abs(vol!.delta)).toBeGreaterThan(0.3);
  });

  it('populates population counts from fitness states', () => {
    writeSolution('ch', ['a']);
    for (let i = 0; i < 15; i++) writeOutcome('s1', 'ch', 'accept', i);
    const report = buildWeaknessReport();
    expect(report.population.total).toBe(1);
    expect(report.population.champion).toBe(1);
  });
});
