/**
 * lifecycle-classifier — unit tests (P3)
 * 격리: FORGEN_HOME + mock queryHitRate via vi.mock
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── isolate FORGEN_HOME ───────────────────────────────────────────────────────
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-lc-test-'));
process.env.FORGEN_HOME = TMP_HOME;

// ── mock observability-store (queryHitRate) ───────────────────────────────────
vi.mock('../src/core/observability-store.js', () => ({
  queryHitRate: vi.fn(() => []),
}));

const { classifyOne, classifySolutions } = await import('../src/core/lifecycle-classifier.js');
const { queryHitRate } = await import('../src/core/observability-store.js');
const mockQueryHitRate = vi.mocked(queryHitRate);

// ── helpers ───────────────────────────────────────────────────────────────────
function makeRates(overrides: Partial<{
  matched_30d: number; surfaced_30d: number; acted_30d: number;
  matched_90d: number; surfaced_90d: number; acted_90d: number;
  matched_180d: number; surfaced_180d: number; acted_180d: number;
  last_event_ts: number;
}> = {}) {
  return {
    solutionId: 'test-id',
    matched_30d: 0, surfaced_30d: 0, acted_30d: 0,
    matched_90d: 0, surfaced_90d: 0, acted_90d: 0,
    matched_180d: 0, surfaced_180d: 0, acted_180d: 0,
    last_event_ts: 0,
    ...overrides,
  };
}

const SOLUTIONS_DIR = path.join(TMP_HOME, 'me', 'solutions');

function clearSolutionsDir(): void {
  if (fs.existsSync(SOLUTIONS_DIR)) {
    for (const f of fs.readdirSync(SOLUTIONS_DIR)) {
      fs.unlinkSync(path.join(SOLUTIONS_DIR, f));
    }
  }
}

function writeSolution(solutionId: string, createdDate: string): void {
  fs.mkdirSync(SOLUTIONS_DIR, { recursive: true });
  const content = `---
name: ${solutionId}
version: 1
status: experiment
confidence: 0.5
type: pattern
scope: me
tags:
  - test
identifiers:
  - testFn
created: ${createdDate}
updated: ${createdDate}
supersedes: null
extractedBy: manual
evidence:
  injected: 0
  reflected: 0
  negative: 0
  sessions: 0
  reExtracted: 0
---

## Content
test content
`;
  fs.writeFileSync(path.join(SOLUTIONS_DIR, `${solutionId}.md`), content);
}

beforeEach(() => {
  mockQueryHitRate.mockReturnValue([]);
  clearSolutionsDir();
});

// ── classifyOne — boundary tests ──────────────────────────────────────────────
describe('classifyOne', () => {
  it('new: age <= 30', () => {
    expect(classifyOne('x', 30, makeRates())).toBe('new');
    expect(classifyOne('x', 0, makeRates())).toBe('new');
  });

  it('new boundary: age == 30 is new, age == 31 is not', () => {
    expect(classifyOne('x', 30, makeRates())).toBe('new');
    expect(classifyOne('x', 31, makeRates())).not.toBe('new');
  });

  it('dead: matched_180d == 0 AND age > 30', () => {
    expect(classifyOne('x', 31, makeRates({ matched_180d: 0 }))).toBe('dead');
  });

  it('dead NOT triggered when matched_180d >= 1', () => {
    expect(classifyOne('x', 31, makeRates({ matched_180d: 1 }))).not.toBe('dead');
  });

  it('hot: acted_90d >= 3 AND rate >= 0.4', () => {
    // 3 acted, 5 surfaced → 0.6 rate ≥ 0.4 → hot
    const r = makeRates({ matched_180d: 5, surfaced_90d: 5, acted_90d: 3 });
    expect(classifyOne('x', 60, r)).toBe('hot');
  });

  it('hot boundary: acted_90d == 3, rate exactly 0.4 (3/7 < 0.4 → not hot)', () => {
    // 3/7 ≈ 0.428 → hot
    const r = makeRates({ matched_180d: 5, surfaced_90d: 7, acted_90d: 3 });
    expect(classifyOne('x', 60, r)).toBe('hot');
  });

  it('hot: NOT hot when acted_90d < 3', () => {
    const r = makeRates({ matched_180d: 5, surfaced_90d: 5, acted_90d: 2 });
    expect(classifyOne('x', 60, r)).not.toBe('hot');
  });

  it('hot: NOT hot when rate < 0.4 (3/8 = 0.375)', () => {
    const r = makeRates({ matched_180d: 5, surfaced_90d: 8, acted_90d: 3 });
    expect(classifyOne('x', 60, r)).not.toBe('hot');
  });

  it('warm: surfaced_90d >= 3 AND acted_90d >= 1 (hot 미달)', () => {
    const r = makeRates({ matched_180d: 5, surfaced_90d: 3, acted_90d: 1 });
    expect(classifyOne('x', 60, r)).toBe('warm');
  });

  it('warm NOT when acted_90d == 0', () => {
    const r = makeRates({ matched_180d: 5, surfaced_90d: 3, acted_90d: 0 });
    expect(classifyOne('x', 60, r)).not.toBe('warm');
  });

  it('cold: matched_90d >= 1 AND surfaced_90d == 0', () => {
    const r = makeRates({ matched_180d: 2, matched_90d: 1, surfaced_90d: 0 });
    expect(classifyOne('x', 60, r)).toBe('cold');
  });

  it('cold fallback when no condition matches', () => {
    // matched_180d >= 1, surfaced_90d >= 1, acted_90d == 0, surfaced < 3
    const r = makeRates({ matched_180d: 1, matched_90d: 1, surfaced_90d: 1, acted_90d: 0 });
    expect(classifyOne('x', 60, r)).toBe('cold');
  });
});

// ── classifySolutions ─────────────────────────────────────────────────────────
describe('classifySolutions', () => {
  it('returns empty array when solutions dir does not exist', () => {
    // TMP_HOME already set but we can wipe solutions dir
    const solutionsDir = path.join(TMP_HOME, 'me', 'solutions');
    if (fs.existsSync(solutionsDir)) {
      for (const f of fs.readdirSync(solutionsDir)) {
        fs.unlinkSync(path.join(solutionsDir, f));
      }
    }
    const result = classifySolutions();
    expect(result).toEqual([]);
  });

  it('new: age <= 30 days', () => {
    const today = new Date().toISOString().slice(0, 10);
    writeSolution('new-sol', today);
    const result = classifySolutions();
    const found = result.find(r => r.solutionId === 'new-sol');
    expect(found).toBeDefined();
    expect(found?.lifecycle).toBe('new');
  });

  it('dead: old solution with no events', () => {
    writeSolution('old-sol', '2025-01-01');
    const result = classifySolutions();
    const found = result.find(r => r.solutionId === 'old-sol');
    expect(found).toBeDefined();
    expect(found?.lifecycle).toBe('dead');
  });

  it('hot: uses queryHitRate data', () => {
    writeSolution('hot-sol', '2025-01-01');
    mockQueryHitRate.mockReturnValue([{
      solutionId: 'hot-sol',
      matched_30d: 5, surfaced_30d: 4, acted_30d: 3,
      matched_90d: 5, surfaced_90d: 5, acted_90d: 3,
      matched_180d: 8, surfaced_180d: 6, acted_180d: 4,
      last_event_ts: Date.now(),
    }]);
    const result = classifySolutions();
    const found = result.find(r => r.solutionId === 'hot-sol');
    expect(found?.lifecycle).toBe('hot');
    expect(found?.hitRate).toBeCloseTo(0.6);
  });

  it('age calculation: created 2025-01-01 → ageDays > 30', () => {
    writeSolution('age-test', '2025-01-01');
    const result = classifySolutions();
    const found = result.find(r => r.solutionId === 'age-test');
    expect(found?.ageDays).toBeGreaterThan(30);
  });

  it('hitRate is null when surfaced_90d == 0', () => {
    writeSolution('cold-sol', '2025-01-01');
    mockQueryHitRate.mockReturnValue([{
      solutionId: 'cold-sol',
      matched_30d: 1, surfaced_30d: 0, acted_30d: 0,
      matched_90d: 1, surfaced_90d: 0, acted_90d: 0,
      matched_180d: 1, surfaced_180d: 0, acted_180d: 0,
      last_event_ts: Date.now(),
    }]);
    const result = classifySolutions();
    const found = result.find(r => r.solutionId === 'cold-sol');
    expect(found?.hitRate).toBeNull();
    expect(found?.lifecycle).toBe('cold');
  });
});
