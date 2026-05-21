/**
 * Longitudinal compound smoke — within-conversation compound effect.
 *
 * Hypothesis: forgenOnly arm's W (γ/β based) increases as T (warm-up turns) grows,
 * because more prior corrections give forgen more rules to inject at trigger time.
 *
 * Time points: T ∈ {1, 5, 10}  (turnDepth = T; T=1 = no warm-up, just trigger)
 * For T > 1, the case's correctionSequence is augmented with (T-1) warm-up turns
 * drawn from same-persona peer cases (first correction turn of each peer).
 *
 * SCOPE LIMITATION (smoke MVP):
 *   This measures *within-conversation* compound — single arm session, long history.
 *   Not *cross-session* compound (which is forgen's real claim). Cross-session requires
 *   FORGEN_HOME isolation (not yet implemented). Track 3 v2 should add that.
 *
 * Output: ψ_long ≈ W(T=10) - W(T=1) per case, mean + bootstrap CI.
 *
 * Run: PSI_LONG_N=3 node dist/runners/demo-longitudinal.js
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { ForgenOnlyArm } from '../arms/real-arms.js';
import type { ArmContext } from '../arms/types.js';
import { loadTestCases } from '../datasets/loader.js';
import type { TestCase, TurnDepth, CorrectionTurn } from '../types.js';
import type { JudgeAxis } from '../judges/index.js';
import { ClaudeCliClient, CodexCliClient } from '../judges/index.js';

const DATA_DIR = process.env.FORGEN_EVAL_DATA_DIR ?? '/tmp/forgen-eval-data';
const N = Number(process.env.PSI_LONG_N ?? 3);
const TIME_POINTS: number[] = (process.env.PSI_LONG_TS ?? '1,5,10')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 1);

const personaCache = new Map<string, string>();
function loadPersonaSpec(personaId: string): string {
  if (personaCache.has(personaId)) return personaCache.get(personaId)!;
  const path = join(DATA_DIR, 'personas', `${personaId}.json`);
  if (!existsSync(path)) {
    personaCache.set(personaId, `(persona spec missing: ${personaId})`);
    return personaCache.get(personaId)!;
  }
  const spec = JSON.parse(readFileSync(path, 'utf-8'));
  const text = JSON.stringify(spec, null, 2);
  personaCache.set(personaId, text);
  return text;
}

function w(s: { gamma: number; beta: number; blocks: number; injects: number }): number {
  const g = (s.gamma - 1) / 3;
  const b = (s.beta - 1) / 3;
  const d = Math.tanh(s.blocks);
  const e = Math.tanh(s.injects);
  return 0.4 * g + 0.2 * b + 0.15 * d + 0.1 * e + 0.15;
}

function bootstrapMean95CI(values: number[], iters = 1000): { mean: number; lo: number; hi: number } {
  if (values.length === 0) return { mean: 0, lo: 0, hi: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    let acc = 0;
    for (let j = 0; j < values.length; j++) acc += values[Math.floor(Math.random() * values.length)];
    samples.push(acc / values.length);
  }
  samples.sort((a, b) => a - b);
  return { mean, lo: samples[Math.floor(iters * 0.025)], hi: samples[Math.floor(iters * 0.975)] };
}

/** Pick (T-1) warm-up turns from same-persona peers' first corrections. */
function buildWarmupSequence(
  measurementCase: TestCase,
  pool: TestCase[],
  T: number,
): CorrectionTurn[] {
  if (T <= 1) return [];
  const peers = pool.filter(
    (c) => c.id !== measurementCase.id && c.personaId === measurementCase.personaId,
  );
  const fallback = pool.filter((c) => c.id !== measurementCase.id);
  const source = peers.length >= T - 1 ? peers : peers.concat(fallback);
  return source.slice(0, T - 1).map((c) => c.correctionSequence[0]).filter(Boolean);
}

function augmentCase(c: TestCase, warmup: CorrectionTurn[]): TestCase {
  return { ...c, correctionSequence: [...warmup, ...c.correctionSequence] };
}

async function safeJudge(
  judges: ReturnType<typeof buildJudges>,
  caseId: string,
  axis: JudgeAxis,
  response: string,
  persona: string,
  correctionHistory: string,
): Promise<number> {
  const settled = await Promise.allSettled(
    judges.map((j) =>
      j.judge({
        caseId,
        blindedArmId: 'L', // longitudinal arm, blinded
        axis,
        material: { finalResponse: response, persona, correctionHistory },
      }),
    ),
  );
  const scores: number[] = [];
  settled.forEach((res, idx) => {
    if (res.status === 'fulfilled') scores.push(res.value.score);
    else {
      scores.push(2.5);
      process.stderr.write(
        `  [judge ${judges[idx].id} ${axis}] error → fallback 2.5: ${(res.reason as Error).message}\n`,
      );
    }
  });
  return scores.reduce((s, v) => s + v, 0) / scores.length;
}

function buildJudges() {
  return [new ClaudeCliClient(), new CodexCliClient()];
}

function formatHistory(turns: CorrectionTurn[]): string {
  if (!turns.length) return '(없음)';
  return turns
    .slice(0, 10)
    .map((t, i) => `Turn ${i + 1} (user): ${t.userMsg.slice(0, 300)}`)
    .join('\n');
}

interface PointResult {
  T: number;
  perCase: { caseId: string; gamma: number; beta: number; blocks: number; injects: number; W: number }[];
  meanW: number;
  ci: [number, number];
}

async function main() {
  const cases = loadTestCases({ rootDir: DATA_DIR, realRetroMinRatio: 0, limit: Math.max(N * 2, 8) });
  const measurement = cases.slice(0, N);
  const pool = cases; // peers may overlap with measurement — guarded by id filter
  console.log(`Longitudinal smoke: T=[${TIME_POINTS.join(',')}], N=${measurement.length} measurement cases`);

  const judges = buildJudges();
  for (const j of judges) {
    const ping = await j.ping();
    console.log(`  ${j.id} ping ok=${ping.ok} ${ping.latencyMs}ms`);
    if (!ping.ok) {
      console.error(`Judge ${j.id} unavailable — abort`);
      process.exit(1);
    }
  }

  const arm = new ForgenOnlyArm();
  await arm.beforeAll({ armId: 'forgen-only', workdir: '/tmp/longi', turnDepth: 1 });

  const points: PointResult[] = [];
  for (const T of TIME_POINTS) {
    console.log(`\n=== T=${T} (turnDepth=${T}) ===`);
    const ctx: ArmContext = {
      armId: 'forgen-only',
      workdir: '/tmp/longi',
      turnDepth: T as unknown as TurnDepth,
    };
    const perCase: PointResult['perCase'] = [];
    for (let i = 0; i < measurement.length; i++) {
      const base = measurement[i];
      const warmup = buildWarmupSequence(base, pool, T);
      const augmented = augmentCase(base, warmup);
      const t0 = Date.now();
      try {
        const resp = await arm.runCase(augmented, ctx);
        const persona = loadPersonaSpec(base.personaId);
        const history = formatHistory(augmented.correctionSequence);
        const gamma = await safeJudge(judges, base.id, 'gamma', resp.finalResponse, persona, history);
        const beta = await safeJudge(judges, base.id, 'beta', resp.finalResponse, persona, history);
        const blocks = resp.blockEvents.length;
        const injects = resp.injectEvents.length;
        const W = w({ gamma, beta, blocks, injects });
        perCase.push({ caseId: base.id, gamma, beta, blocks, injects, W });
        console.log(
          `  [${i + 1}/${measurement.length}] ${base.id}: ${((Date.now() - t0) / 1000).toFixed(1)}s γ=${gamma.toFixed(2)} β=${beta.toFixed(2)} b=${blocks} i=${injects} W=${W.toFixed(3)}`,
        );
      } catch (e) {
        console.error(`  [${i + 1}/${measurement.length}] ${base.id}: ${(e as Error).message}`);
      }
    }
    const Ws = perCase.map((p) => p.W);
    const ci = bootstrapMean95CI(Ws);
    points.push({ T, perCase, meanW: ci.mean, ci: [ci.lo, ci.hi] });
    console.log(`  → mean W = ${ci.mean.toFixed(3)} CI=[${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]`);
  }
  await arm.afterAll({ armId: 'forgen-only', workdir: '/tmp/longi', turnDepth: 1 }).catch(() => {});

  const T_first = points[0]?.meanW ?? 0;
  const T_last = points[points.length - 1]?.meanW ?? 0;
  const psiLong = T_last - T_first;
  console.log('\n=== LONGITUDINAL SUMMARY ===');
  console.log(`T points    : ${points.map((p) => `T=${p.T}:${p.meanW.toFixed(3)}`).join('  ')}`);
  console.log(`ψ_long      = W(T=${TIME_POINTS[TIME_POINTS.length - 1]}) - W(T=${TIME_POINTS[0]}) = ${psiLong.toFixed(3)}`);
  console.log(`Compound gate (ψ_long > 0): ${psiLong > 0 ? 'PASS' : 'FAIL'}`);

  const out = {
    runner: 'demo-longitudinal',
    scope: 'within-conversation compound (smoke MVP)',
    timePoints: TIME_POINTS,
    N: measurement.length,
    points,
    psiLong,
    generatedAt: new Date().toISOString(),
  };
  mkdirSync('./reports/longitudinal', { recursive: true });
  const fp = `./reports/longitudinal/longi-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(`\nReport saved: ${fp}`);

  // v0.4.10: ship-gate 가 읽을 state 파일도 emit.
  // doctor / release 가 ~/.forgen/state/psi-long-result.json 의 freshness + psiLong > 0 을 검사한다.
  // FORGEN_HOME 격리 환경에서도 동작하도록 env 우선.
  try {
    const forgenHome = process.env.FORGEN_HOME ?? join(homedir(), '.forgen');
    const stateDir = join(forgenHome, 'state');
    mkdirSync(stateDir, { recursive: true });
    const gatePayload = {
      passed: psiLong > 0,
      psiLong,
      timePoints: TIME_POINTS,
      N: measurement.length,
      at: new Date().toISOString(),
      reportFile: fp,
      note: psiLong > 0
        ? 'within-conversation compound effect detected (W increases with T)'
        : 'ψ_long <= 0 — compound effect not observed in this run; investigate corrections injection',
    };
    writeFileSync(join(stateDir, 'psi-long-result.json'), JSON.stringify(gatePayload, null, 2));
    console.log(`Gate state: ${join(stateDir, 'psi-long-result.json')}`);
  } catch (e) {
    console.warn(`[psi-long] failed to write gate state: ${e instanceof Error ? e.message : String(e)}`);
  }

  process.exit(psiLong > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
