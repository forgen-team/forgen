import { readAllOutcomes, type OutcomeEvent } from './solution-outcomes.js';

export type FitnessState = 'draft' | 'active' | 'champion' | 'underperform';

export interface FitnessRecord {
  solution: string;
  injected: number;
  accepted: number;
  corrected: number;
  errored: number;
  unknown: number;
  /** Laplace-smoothed acceptance ratio × log(1+injected). */
  fitness: number;
  state: FitnessState;
  /** ms since last injection event. Infinity if never injected. */
  last_injected_ago_ms: number;
}

export interface FitnessOptions {
  /**
   * Minimum injections required before a solution is evaluated against the
   * underperform threshold. Below this, state stays at `draft`.
   */
  minEvalInjections?: number;
  /**
   * Injections required to qualify as champion (in addition to fitness cut).
   */
  minChampionInjections?: number;
  /**
   * Champion cut: fitness must exceed this fraction of the max fitness in
   * the current population. Default 0.7 → top 30% by ratio of max.
   */
  championFraction?: number;
  /**
   * Underperform cut: fitness must fall below this fraction of the median.
   */
  underperformFraction?: number;
  /** Pre-loaded events (for tests). Defaults to `readAllOutcomes()`. */
  events?: OutcomeEvent[];
}

const DEFAULT_OPTS: Required<Omit<FitnessOptions, 'events'>> = {
  minEvalInjections: 5,
  minChampionInjections: 10,
  championFraction: 0.7,
  underperformFraction: 0.3,
};

/**
 * Compute fitness scores for every solution with at least one recorded
 * outcome event.
 *
 * Formula: `fitness = (accept + 1) / (accept + correct + error + 1) × log(1 + injected)`
 *   - `accept` = positive (silence = consent)
 *   - `correct` = negative (explicit user correction within window)
 *   - `error` = weak negative (tool failed while solution was pending)
 *   - `unknown` = ignored (session ended mid-pending; we can't tell)
 *
 * Epsilon smoothing (+1) means a cold solution with 1 injection and 1
 * accept produces `2/2 × log(2) ≈ 0.69`, not a meaningless `1.0 × 0` or
 * `∞`. Log confidence penalizes small-sample champions.
 */
export function computeFitness(opts: FitnessOptions = {}): FitnessRecord[] {
  const config = { ...DEFAULT_OPTS, ...opts };
  const events = opts.events ?? readAllOutcomes();
  const now = Date.now();

  type Bucket = { accept: number; correct: number; error: number; unknown: number; last_inject_ts: number };
  const byName = new Map<string, Bucket>();
  for (const ev of events) {
    const b = byName.get(ev.solution) ?? { accept: 0, correct: 0, error: 0, unknown: 0, last_inject_ts: 0 };
    if (ev.outcome === 'accept') b.accept++;
    else if (ev.outcome === 'correct') b.correct++;
    else if (ev.outcome === 'error') b.error++;
    else b.unknown++;
    // Every event is a proxy for an injection (each outcome represents one
    // inject that resolved). `last_inject_ts` tracks the most recent event
    // timestamp which is also the latest decision time.
    if (ev.ts > b.last_inject_ts) b.last_inject_ts = ev.ts;
    byName.set(ev.solution, b);
  }

  // First pass: raw fitness
  const records: FitnessRecord[] = [];
  for (const [solution, b] of byName) {
    const injected = b.accept + b.correct + b.error + b.unknown;
    const decided = b.accept + b.correct + b.error; // unknown excluded from ratio
    const ratio = (b.accept + 1) / (decided + 1);
    const confidence = Math.log(1 + injected);
    const fitness = ratio * confidence;
    records.push({
      solution,
      injected,
      accepted: b.accept,
      corrected: b.correct,
      errored: b.error,
      unknown: b.unknown,
      fitness,
      state: 'draft',
      last_injected_ago_ms: b.last_inject_ts === 0 ? Infinity : now - b.last_inject_ts,
    });
  }

  // Population stats for state classification (only solutions past the
  // eval threshold contribute — draft solutions distort max/median).
  const evalPool = records.filter((r) => r.injected >= config.minEvalInjections).map((r) => r.fitness);
  const maxFit = evalPool.length ? Math.max(...evalPool) : 0;
  const medianFit = evalPool.length ? median(evalPool) : 0;

  for (const r of records) {
    r.state = classifyState(r, { maxFit, medianFit, config });
  }

  // Sort: champions first, then active by fitness desc, then underperform,
  // then draft (cold solutions) at the bottom.
  const order: Record<FitnessState, number> = { champion: 0, active: 1, underperform: 2, draft: 3 };
  records.sort((a, b) => order[a.state] - order[b.state] || b.fitness - a.fitness);
  return records;
}

function classifyState(
  r: FitnessRecord,
  ctx: { maxFit: number; medianFit: number; config: Required<Omit<FitnessOptions, 'events'>> },
): FitnessState {
  const { config, maxFit, medianFit } = ctx;
  if (r.injected < config.minEvalInjections) return 'draft';
  if (r.injected >= config.minChampionInjections && r.fitness >= config.championFraction * maxFit) {
    return 'champion';
  }
  if (r.fitness < config.underperformFraction * medianFit) return 'underperform';
  return 'active';
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
