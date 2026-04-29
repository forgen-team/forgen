/**
 * Unit tests — ADR-006 메트릭 공식 정확성.
 * 합성 입력 → 알려진 출력 검증.
 */

import { describe, it, expect } from 'vitest';
import { computeGamma } from '../src/metrics/gamma.js';
import { computeBeta } from '../src/metrics/beta.js';
import { computeDelta, computeEpsilon, computeZeta } from '../src/metrics/delta-epsilon-zeta.js';
import { computePhi } from '../src/metrics/phi.js';
import { computePsi } from '../src/metrics/psi.js';
import { cohensKappa, fleissKappa } from '../src/judges/kappa.js';
import { judgePassFail } from '../src/reports/pass-fail.js';

describe('γ (gamma)', () => {
  it('large effect (forgen 일관 우위) → Cohen\'s d ≥ 0.8', () => {
    const pairs = Array.from({ length: 30 }, () => ({
      onN5: 2, onN10: 4, offN5: 2, offN10: 2.5,
    }));
    const r = computeGamma({ pairs });
    expect(r.cohenD).toBeGreaterThanOrEqual(0.8);
    expect(r.passes).toBe(true);
  });

  it('null effect (변화 없음) → d 작고 fail', () => {
    const pairs = Array.from({ length: 30 }, () => ({
      onN5: 2, onN10: 2.5, offN5: 2, offN10: 2.5,
    }));
    const r = computeGamma({ pairs });
    expect(Math.abs(r.cohenD)).toBeLessThan(0.1);
    expect(r.passes).toBe(false);
  });
});

describe('β (beta)', () => {
  it('persona 부합 +1 likert → pass', () => {
    const pairs = Array.from({ length: 30 }, () => ({ on: 4, off: 3 }));
    const r = computeBeta({ pairs });
    expect(r.pairedDiff).toBeCloseTo(1, 1);
    expect(r.passes).toBe(true);
  });

  it('차이 없음 → fail', () => {
    const pairs = Array.from({ length: 30 }, () => ({ on: 3, off: 3 }));
    const r = computeBeta({ pairs });
    expect(r.passes).toBe(false);
  });
});

describe('δ/ε/ζ rate metrics', () => {
  it('δ 95% → pass (≥ 90%)', () => {
    expect(computeDelta(95, 100).passes).toBe(true);
  });
  it('δ 80% → fail', () => {
    expect(computeDelta(80, 100).passes).toBe(false);
  });
  it('ε 90% → pass (≥ 85%)', () => {
    expect(computeEpsilon(90, 100).passes).toBe(true);
  });
  it('ζ 86% → pass (≥ 85%)', () => {
    expect(computeZeta(86, 100).passes).toBe(true);
  });
  it('zero attempts → rate 0', () => {
    expect(computeDelta(0, 0).rate).toBe(0);
  });
});

describe('φ (phi) master gate', () => {
  it('FP rate 3% on N=100 → wilson upper ≤ 5%? marginal', () => {
    const judgements = [
      ...Array(3).fill(1),
      ...Array(97).fill(4),
    ] as (1 | 4)[];
    const r = computePhi({ judgements });
    expect(r.rate).toBeCloseTo(0.03, 2);
    // Wilson upper at 3/100 ≈ 8.5% — fails (small N)
    expect(r.passes).toBe(false);
  });

  it('FP rate 1% on N=500 → wilson upper ≤ 5% pass', () => {
    const judgements = [
      ...Array(5).fill(1),
      ...Array(495).fill(4),
    ] as (1 | 4)[];
    const r = computePhi({ judgements });
    expect(r.passes).toBe(true);
  });

  it('FP rate 8% → fail', () => {
    const judgements = [
      ...Array(40).fill(1),
      ...Array(460).fill(4),
    ] as (1 | 4)[];
    expect(computePhi({ judgements }).passes).toBe(false);
  });
});

describe('ψ (psi) synergy', () => {
  const fullScore = { gamma: 0.9, beta: 0.8, delta: 0.95, epsilon: 0.9, zeta: 0.9 };
  const forgenOnly = { gamma: 0.7, beta: 0.6, delta: 0.95, epsilon: 0.9, zeta: 0.9 };
  const memOnly = { gamma: 0.3, beta: 0.4, delta: 0.0, epsilon: 0.0, zeta: 0.3 };

  it('full > both single → ψ > 0 pass', () => {
    const r = computePsi({
      scores: {
        vanilla: { gamma: 0, beta: 0, delta: 0, epsilon: 0, zeta: 0 },
        'forgen-only': forgenOnly,
        'claude-mem-only': memOnly,
        'forgen-plus-mem': fullScore,
        'gstack-only': { gamma: 0, beta: 0, delta: 0, epsilon: 0, zeta: 0 },
      },
    });
    expect(r.psi).toBeGreaterThan(0);
    expect(r.passes).toBe(true);
  });

  it('full ≤ forgen-only → ψ ≤ 0 fail (no synergy)', () => {
    const r = computePsi({
      scores: {
        vanilla: { gamma: 0, beta: 0, delta: 0, epsilon: 0, zeta: 0 },
        'forgen-only': fullScore,
        'claude-mem-only': memOnly,
        'forgen-plus-mem': forgenOnly,
        'gstack-only': { gamma: 0, beta: 0, delta: 0, epsilon: 0, zeta: 0 },
      },
    });
    expect(r.psi).toBeLessThanOrEqual(0);
    expect(r.passes).toBe(false);
  });
});

describe('κ (kappa) judge agreement', () => {
  it("Cohen's κ — 완전 일치 → 1", () => {
    expect(cohensKappa([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1, 5);
  });

  it("Cohen's κ — 진짜 무작위 (seeded) → |κ| < 0.2", () => {
    let s = 42;
    const rand = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    const a = Array.from({ length: 200 }, () => Math.floor(rand() * 4) + 1);
    const b = Array.from({ length: 200 }, () => Math.floor(rand() * 4) + 1);
    expect(Math.abs(cohensKappa(a, b))).toBeLessThan(0.2);
  });

  it("Fleiss' κ — 3 raters 완전 일치 → 1", () => {
    const raters = Array.from({ length: 30 }, () => [3, 3, 3]);
    expect(fleissKappa(raters)).toBeCloseTo(1, 5);
  });
});

describe('passFail master gate priority', () => {
  const goodMetrics = {
    gamma: { cohenD: 1.0, wilcoxonR: 0.5, pValue: 0.001 },
    beta: { pairedDiff: 0.7, pValue: 0.001 },
    delta: { 'forgen-only': 0.95, 'forgen-plus-mem': 0.95, vanilla: 0.1, 'claude-mem-only': 0.1, 'gstack-only': 0.1 } as const,
    epsilon: { 'forgen-only': 0.9, 'forgen-plus-mem': 0.9, vanilla: 0, 'claude-mem-only': 0, 'gstack-only': 0 } as const,
    zeta: { 'forgen-only': 0.9, 'forgen-plus-mem': 0.9, vanilla: 0, 'claude-mem-only': 0.3, 'gstack-only': 0 } as const,
    phi: 0.03,
    psi: 1.5,
    kappa: { dev: 0.85, public: 0.75 },
    discardRate: 0.05,
  };

  it('φ > 5% → 즉시 fail, 다른 메트릭 무시', () => {
    const v = judgePassFail({ ...goodMetrics, phi: 0.07 }, 0.05);
    expect(v.passed).toBe(false);
    expect(v.hardFailReason).toBe('phi_exceeded');
  });

  it('ψ ≤ 0 → fail', () => {
    const v = judgePassFail({ ...goodMetrics, psi: -0.1 }, 0.05);
    expect(v.hardFailReason).toBe('psi_non_positive');
  });

  it('κ < threshold → fail', () => {
    const v = judgePassFail({ ...goodMetrics, kappa: { dev: 0.7, public: 0.75 } }, 0.05);
    expect(v.hardFailReason).toBe('kappa_low');
  });

  it('discard > 10% → fail', () => {
    const v = judgePassFail(goodMetrics, 0.15);
    expect(v.hardFailReason).toBe('discard_high');
  });

  it('all good → PASS', () => {
    const v = judgePassFail(goodMetrics, 0.05);
    expect(v.passed).toBe(true);
  });
});
