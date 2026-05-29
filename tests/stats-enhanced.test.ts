import { describe, it, expect } from 'vitest';
import { computeStats, renderStats } from '../src/core/stats-cli.js';

describe('stats-cli enhanced fields (v0.5.0)', () => {
  it('computeStats returns solutionHealth', () => {
    const snap = computeStats();
    expect(snap.solutionHealth).toBeDefined();
    expect(typeof snap.solutionHealth.total).toBe('number');
    expect(typeof snap.solutionHealth.avgConfidence).toBe('number');
    expect(typeof snap.solutionHealth.utilization7d).toBe('number');
    expect(snap.solutionHealth.byStatus).toBeDefined();
  });

  it('computeStats returns topRules7d', () => {
    const snap = computeStats();
    expect(Array.isArray(snap.topRules7d)).toBe(true);
    for (const r of snap.topRules7d) {
      expect(typeof r.name).toBe('string');
      expect(typeof r.count).toBe('number');
    }
  });

  it('computeStats returns weeklyTrend', () => {
    const snap = computeStats();
    expect(snap.weeklyTrend).toBeDefined();
    expect(typeof snap.weeklyTrend.blocksThisWeek).toBe('number');
    expect(typeof snap.weeklyTrend.blocksLastWeek).toBe('number');
    expect(typeof snap.weeklyTrend.recallsThisWeek).toBe('number');
    expect(typeof snap.weeklyTrend.recallsLastWeek).toBe('number');
    expect(typeof snap.weeklyTrend.extractionsThisWeek).toBe('number');
    expect(typeof snap.weeklyTrend.extractionsLastWeek).toBe('number');
  });

  it('renderStats includes Solutions section when total > 0', () => {
    const snap = computeStats();
    const output = renderStats(snap);
    if (snap.solutionHealth.total > 0) {
      expect(output).toContain('Solutions');
      expect(output).toContain('Avg confidence');
      expect(output).toContain('Utilization');
    }
  });

  it('renderStats includes Weekly trend section', () => {
    const snap = computeStats();
    const output = renderStats(snap);
    expect(output).toContain('Weekly trend');
    expect(output).toContain('Blocks');
    expect(output).toContain('Recalls');
    expect(output).toContain('Extractions');
  });

  it('topRules7d has max 3 entries', () => {
    const snap = computeStats();
    expect(snap.topRules7d.length).toBeLessThanOrEqual(3);
  });

  it('solutionHealth utilization is between 0 and 1', () => {
    const snap = computeStats();
    expect(snap.solutionHealth.utilization7d).toBeGreaterThanOrEqual(0);
    expect(snap.solutionHealth.utilization7d).toBeLessThanOrEqual(1);
  });
});
