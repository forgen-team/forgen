/**
 * forgen-eval — core type contracts
 *
 * Spec: docs/plans/2026-04-28-forgen-testbed-proof-spec.md
 * ADRs: ADR-004 (coexistence), ADR-005 (module), ADR-006 (metrics)
 */

export type ArmId =
  | 'vanilla'
  | 'forgen-only'
  | 'claude-mem-only'
  | 'forgen-plus-mem'
  | 'gstack-only';

export type TurnDepth = 1 | 5 | 10 | 50;

export type Track = 'DEV' | 'PUBLIC';

export type Tier = 'smoke' | 'full';

/** A single dataset case — synthetic or real-retro-derived. */
export interface TestCase {
  id: string;
  scenario: 1 | 2 | 3 | 4 | 5 | 6; // see Spec §10a
  personaId: string; // resolved from forgen-eval-data external repo
  correctionSequence: CorrectionTurn[];
  trigger: TriggerPrompt;
  source: 'synthetic' | 'retro-real';
}

export interface CorrectionTurn {
  userMsg: string;
  expectedRule?: string; // for δ/ε measurement
}

export interface TriggerPrompt {
  prompt: string;
  expectedBlocked?: boolean; // for δ/φ measurement
}

/** A single arm response after all turns — what judges score. */
export interface ArmResponse {
  caseId: string;
  armId: ArmId; // BLINDED at judge time — see runners/blinding.ts
  turnDepth: TurnDepth;
  finalResponse: string;
  blockEvents: BlockEvent[]; // Mech-A traces
  injectEvents: InjectEvent[]; // Mech-B traces
}

export interface BlockEvent {
  ruleId: string;
  reason: string;
  ts: string;
}

export interface InjectEvent {
  ruleId: string;
  injectedText: string;
  ts: string;
}

/** Judge verdict — 4-likert per ADR-006. */
export interface JudgeScore {
  caseId: string;
  blindedArmId: string; // anonymized
  judgeId: 'sonnet' | 'qwen-72b' | 'llama-70b';
  axis: 'gamma' | 'beta' | 'phi'; // δ/ε/ζ are derived from event traces, not judged directly
  score: 1 | 2 | 3 | 4;
  rationale: string;
}

/** Aggregated metric outcomes — final pass-fail input. */
export interface MetricBundle {
  gamma: { cohenD: number; wilcoxonR: number; pValue: number };
  beta: { pairedDiff: number; pValue: number };
  delta: Record<ArmId, number>; // block rate per arm
  epsilon: Record<ArmId, number>;
  zeta: Record<ArmId, number>;
  phi: number; // master gate: ≤ 0.05
  psi: number; // synergy: > 0
  kappa: { dev: number; public: number };
  discardRate: number;
}

/** Full report after a runner completes. */
export interface RunReport {
  runId: string;
  track: Track;
  tier: Tier;
  startedAt: string;
  endedAt: string;
  claudeMemVersion: string; // detected at runtime, compared against pin
  datasetVersion: string; // commit hash from forgen-eval-data
  totalCases: number;
  discardedCases: number;
  metrics: MetricBundle;
  passFail: PassFailVerdict;
  costUsd: number;
  warnings: string[];
}

export interface PassFailVerdict {
  passed: boolean;
  hardFailReason?: 'phi_exceeded' | 'psi_non_positive' | 'kappa_low' | 'discard_high';
  metricStatus: Record<string, 'pass' | 'fail' | 'na'>;
}
