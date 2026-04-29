/**
 * ψ (psi) — Synergy. (α) Full mode 셀링의 수학적 정당성.
 * ADR-006 §ψ. ψ ≤ 0 → HARD FAIL.
 *
 * ψ = W_full - max(W_forgen_only, W_claude_mem_only)
 * W_arm 가중치: γ(0.4) + β(0.2) + δ(0.15) + ε(0.1) + ζ(0.15) = 1.0
 */

import type { ArmId } from '../types.js';

export interface ArmCompositeScore {
  gamma: number; // normalized 0-1
  beta: number;
  delta: number;
  epsilon: number;
  zeta: number;
}

export interface PsiInput {
  scores: Record<ArmId, ArmCompositeScore>;
}

export interface PsiResult {
  weighted: Record<ArmId, number>;
  psi: number;
  passes: boolean; // > 0
  stretch: boolean; // ≥ 1 likert-equivalent
}

const WEIGHTS = { gamma: 0.4, beta: 0.2, delta: 0.15, epsilon: 0.1, zeta: 0.15 } as const;

export function weightedScore(s: ArmCompositeScore): number {
  return (
    WEIGHTS.gamma * s.gamma +
    WEIGHTS.beta * s.beta +
    WEIGHTS.delta * s.delta +
    WEIGHTS.epsilon * s.epsilon +
    WEIGHTS.zeta * s.zeta
  );
}

export function computePsi(input: PsiInput): PsiResult {
  const weighted: Partial<Record<ArmId, number>> = {};
  for (const [arm, s] of Object.entries(input.scores) as [ArmId, ArmCompositeScore][]) {
    weighted[arm] = weightedScore(s);
  }
  const full = weighted['forgen-plus-mem'] ?? 0;
  const forgen = weighted['forgen-only'] ?? 0;
  const mem = weighted['claude-mem-only'] ?? 0;
  const psi = full - Math.max(forgen, mem);
  return {
    weighted: weighted as Record<ArmId, number>,
    psi,
    passes: psi > 0,
    stretch: psi >= 1,
  };
}
