import { describe, it, expect } from 'vitest';
import { computeHealth } from '../src/core/health-cli.js';

describe('health-cli (v0.5.0)', () => {
  it('returns total score between 0 and 100', () => {
    const h = computeHealth();
    expect(h.total).toBeGreaterThanOrEqual(0);
    expect(h.total).toBeLessThanOrEqual(100);
  });

  it('returns a valid grade', () => {
    const h = computeHealth();
    expect(['A', 'B', 'C', 'D', 'F']).toContain(h.grade);
  });

  it('components sum to total', () => {
    const h = computeHealth();
    const sum = h.components.utilization + h.components.effectiveness +
      h.components.growth + h.components.coverage + h.components.profile;
    expect(sum).toBe(h.total);
  });

  it('each component does not exceed its max', () => {
    const h = computeHealth();
    expect(h.components.utilization).toBeLessThanOrEqual(30);
    expect(h.components.effectiveness).toBeLessThanOrEqual(25);
    expect(h.components.growth).toBeLessThanOrEqual(20);
    expect(h.components.coverage).toBeLessThanOrEqual(15);
    expect(h.components.profile).toBeLessThanOrEqual(10);
  });
});
