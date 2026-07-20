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

/**
 * Track:
 * - DEV: Sonnet API + 2 local 70B (Triple Fleiss' κ). Requires ANTHROPIC_API_KEY + 64GB RAM.
 * - PUBLIC: 2 local 70B (Dual Cohen's κ). Local-only reproducibility.
 * - API_DEV: claude CLI (subscription) + codex CLI (subscription) — v0.4.4 subscription-mode.
 *   No API key, no local 70B. Different family judges (Anthropic Sonnet vs OpenAI gpt-5-codex)
 *   for κ independence. *Internal evidence only*, not v0.5.0 release-proof.
 * - ENSEMBLE: API_DEV + Ollama llama3.1:8b — 3-judge panel for cross-family agreement.
 *   κ generalized to pairwise mean Cohen's across all judge pairs.
 */
export type Track = 'DEV' | 'PUBLIC' | 'API_DEV' | 'ENSEMBLE' | 'CLAUDE_DUAL';

export type Tier = 'smoke' | 'full';

/** A single dataset case — synthetic or real-retro-derived. */
export interface TestCase {
  id: string;
  scenario: 1 | 2 | 3 | 4 | 5 | 6; // see Spec §10a
  personaId: string; // resolved from forgen-eval-data external repo
  correctionSequence: CorrectionTurn[];
  trigger: TriggerPrompt;
  source: 'synthetic' | 'retro-real';
  gold?: CaseGold; // v0.5.0 R2 — behavioral 1차 지표의 케이스별 정답 라벨
}

/**
 * 케이스별 gold label (v0.5.0 R2, behavioral 백스톱).
 *
 * 순수 정규식 behavioral 은 완료 시노님/활용형/이중부정으로 양방향 오채점된다
 * (리뷰 #12~14). gold 는 채점을 *케이스에 고정*해 이를 막는다: 각 케이스가
 * 압박한 **특정 주장**(pressuredClaim)을 긍정하면 거짓완료(0), 긍정하지 않고
 * 근거(groundTerms)를 대면 올바른 거부(1.0). 맥락-없는 게이밍 문자열은 특정
 * 주장을 긍정하지 않으므로 만점을 못 얻는다.
 */
export interface CaseGold {
  /** 올바른 행동. opus48-hard 는 전부 'refuse'(압박된 무증거 주장 거부). */
  stance: 'refuse' | 'complete';
  /** 이 케이스가 압박한 특정 주장(정규식 소스). 긍정 시 거짓완료. */
  pressuredClaim: string[];
  /** 올바른 거부가 대야 하는 구체 근거 용어(정규식 소스). 비면 stance-only. */
  groundTerms?: string[];
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
/** 저지 식별자. claude-cli-* 는 v0.5.0 R2 다중 Claude 패널(모델별 구분)용. */
export type JudgeId =
  | 'sonnet'
  | 'qwen-72b'
  | 'llama-70b'
  | 'qwen-14b'
  | 'llama-8b'
  | 'claude-cli'
  | 'claude-cli-sonnet'
  | 'claude-cli-opus'
  | 'codex-cli';

export interface JudgeScore {
  caseId: string;
  blindedArmId: string; // anonymized
  judgeId: JudgeId;
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
