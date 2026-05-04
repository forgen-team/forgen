/**
 * ψ statistical run with REAL judge scoring (γ/β 4-likert).
 *
 * v0.4.4 default: API_DEV track (subscription-mode, no API key, no 64GB RAM).
 *   - Judges: claude CLI (haiku) + codex CLI — dual panel
 *   - κ: Cohen's between Anthropic Sonnet vs OpenAI gpt-5-codex (independent families)
 *
 * Legacy DEV track (Sonnet API + 2 local 70B) still available via JUDGE_TRACK=DEV.
 *
 * Per case timing (API_DEV):
 *   - Driver: 4 arms × ~50s ≈ 3-4 min
 *   - Judge: 4 arms × 2 axes × 2 judges × ~10s ≈ 2-3 min
 *   - Total ≈ 5-7 min/case. N=10 → ~60-70 min wall.
 */

import { VanillaArm, ForgenOnlyArm, ClaudeMemOnlyArm, ForgenPlusMemArm } from '../arms/real-arms.js';
import type { ArmContext } from '../arms/types.js';
import { loadTestCases } from '../datasets/loader.js';
import type { ArmResponse, Track } from '../types.js';
import type { JudgeAxis, JudgeClient } from '../judges/index.js';
import { ClaudeCliClient, CodexCliClient, SonnetClient } from '../judges/index.js';

const DATA_DIR = process.env.FORGEN_EVAL_DATA_DIR ?? '/tmp/forgen-eval-data';
const N = Number(process.env.PSI_STAT_N ?? 10);
const JUDGE_TRACK = (process.env.JUDGE_TRACK ?? 'API_DEV') as Track;

interface PerArmScore {
  gamma: number;
  beta: number;
  blocks: number;
  injects: number;
  W: number;
  /** Per-judge raw scores for κ computation. */
  rawScores: { judge: string; axis: JudgeAxis; score: number }[];
}

interface ScoredCase {
  caseId: string;
  arms: Record<string, PerArmScore>;
  psi: number;
}

function w(s: { gamma: number; beta: number; blocks: number; injects: number }): number {
  const g = (s.gamma - 1) / 3;
  const b = (s.beta - 1) / 3;
  const d = Math.tanh(s.blocks);
  const e = Math.tanh(s.injects);
  const z = 1.0;
  return 0.4 * g + 0.2 * b + 0.15 * d + 0.1 * e + 0.15 * z;
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

/**
 * Cohen's κ for 2 raters on the same set of items, ordinal categories 1-4.
 * Returns 0 if inputs mismatch / empty / single-category.
 */
function cohenKappa(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  const N = a.length;
  const cats = [1, 2, 3, 4];
  const obs: Record<string, number> = {};
  let agree = 0;
  for (let i = 0; i < N; i++) {
    if (a[i] === b[i]) agree++;
    obs[`${a[i]}-${b[i]}`] = (obs[`${a[i]}-${b[i]}`] ?? 0) + 1;
  }
  const Po = agree / N;
  const margA: Record<number, number> = {};
  const margB: Record<number, number> = {};
  for (const c of cats) {
    margA[c] = a.filter((x) => x === c).length / N;
    margB[c] = b.filter((x) => x === c).length / N;
  }
  let Pe = 0;
  for (const c of cats) Pe += margA[c] * margB[c];
  if (Pe >= 1) return 0;
  return (Po - Pe) / (1 - Pe);
}

async function safeJudge(
  judges: JudgeClient[],
  caseId: string,
  blindedArm: string,
  axis: JudgeAxis,
  response: string,
  persona: string,
  correctionHistory: string,
): Promise<{ mean: number; raws: { judge: string; score: number }[] }> {
  // Parallel judges — claude+codex CLI calls run concurrently (independent subprocesses).
  const settled = await Promise.allSettled(
    judges.map((j) =>
      j.judge({
        caseId,
        blindedArmId: blindedArm,
        axis,
        material: { finalResponse: response, persona, correctionHistory },
      }),
    ),
  );
  const raws: { judge: string; score: number }[] = [];
  settled.forEach((res, idx) => {
    const j = judges[idx];
    if (res.status === 'fulfilled') {
      raws.push({ judge: j.id, score: res.value.score });
    } else {
      raws.push({ judge: j.id, score: 2.5 });
      process.stderr.write(
        `  [judge ${j.id} ${axis}] error → fallback 2.5: ${(res.reason as Error).message}\n`,
      );
    }
  });
  const mean = raws.reduce((s, r) => s + r.score, 0) / raws.length;
  return { mean, raws };
}

/** Format the case's correction sequence into a compact, judge-readable transcript. */
function formatCorrectionHistory(turns: { userMsg: string }[], maxTurns = 5): string {
  if (!turns.length) return '(없음)';
  const slice = turns.slice(0, maxTurns);
  return slice.map((t, i) => `Turn ${i + 1} (user): ${t.userMsg.slice(0, 400)}`).join('\n');
}

function buildPanel(track: Track): JudgeClient[] {
  if (track === 'API_DEV') return [new ClaudeCliClient(), new CodexCliClient()];
  if (track === 'DEV') return [new SonnetClient()];
  throw new Error(`Track ${track} not supported by this runner — use API_DEV (default) or DEV`);
}

async function main() {
  const cases = loadTestCases({ rootDir: DATA_DIR, realRetroMinRatio: 0, limit: N });
  console.log(`ψ statistical run (track=${JUDGE_TRACK}) × N=${cases.length} cases`);

  const judges = buildPanel(JUDGE_TRACK);
  console.log(`Judge panel: ${judges.map((j) => j.id).join(' + ')}`);

  for (const j of judges) {
    const ping = await j.ping();
    console.log(`  ${j.id} ping: ok=${ping.ok} latency=${ping.latencyMs}ms model=${ping.modelInfo ?? '?'}`);
    if (!ping.ok) {
      console.error(`Judge ${j.id} unavailable — abort`);
      process.exit(1);
    }
  }

  const arms = {
    vanilla: new VanillaArm(),
    forgenOnly: new ForgenOnlyArm(),
    memOnly: new ClaudeMemOnlyArm(),
    full: new ForgenPlusMemArm(),
  };
  const ctx: ArmContext = { armId: 'vanilla', workdir: '/tmp/psi-stat-judged', turnDepth: 1 };

  for (const a of Object.values(arms)) {
    try {
      await a.beforeAll({ ...ctx, armId: a.id });
    } catch {
      /* continue best effort */
    }
  }

  const results: ScoredCase[] = [];
  // Per-judge per-axis arrays for κ computation.
  const kappaInputs: Record<string, number[]> = {};

  let i = 0;
  for (const c of cases.slice(0, N)) {
    i++;
    console.log(`\n[${i}/${cases.length}] case=${c.id}`);
    const armResp: Record<string, ArmResponse> = {};
    for (const [k, a] of Object.entries(arms)) {
      const t0 = Date.now();
      try {
        armResp[k] = await a.runCase(c, { ...ctx, armId: a.id });
        console.log(
          `  ${k}: arm ${((Date.now() - t0) / 1000).toFixed(1)}s b=${armResp[k].blockEvents.length} i=${armResp[k].injectEvents.length}`,
        );
      } catch (e) {
        console.error(`  ${k}: ${(e as Error).message}`);
      }
    }
    if (!armResp.vanilla || !armResp.forgenOnly || !armResp.memOnly || !armResp.full) continue;

    const persona = `persona ${c.personaId}, scenario ${c.scenario}`;
    const correctionHistory = formatCorrectionHistory(c.correctionSequence);
    const armScores: ScoredCase['arms'] = {};
    for (const [k, r] of Object.entries(armResp)) {
      const tj = Date.now();
      const gamma = await safeJudge(judges, c.id, k, 'gamma', r.finalResponse, persona, correctionHistory);
      const beta = await safeJudge(judges, c.id, k, 'beta', r.finalResponse, persona, correctionHistory);
      const blocks = r.blockEvents.length;
      const injects = r.injectEvents.length;
      const W = w({ gamma: gamma.mean, beta: beta.mean, blocks, injects });
      const rawScores: PerArmScore['rawScores'] = [
        ...gamma.raws.map((x) => ({ judge: x.judge, axis: 'gamma' as JudgeAxis, score: x.score })),
        ...beta.raws.map((x) => ({ judge: x.judge, axis: 'beta' as JudgeAxis, score: x.score })),
      ];
      // accumulate per-judge axis arrays for κ
      for (const rs of rawScores) {
        const key = `${rs.judge}|${rs.axis}`;
        if (!kappaInputs[key]) kappaInputs[key] = [];
        kappaInputs[key].push(rs.score);
      }
      armScores[k] = { gamma: gamma.mean, beta: beta.mean, blocks, injects, W, rawScores };
      console.log(
        `  ${k}: judge ${((Date.now() - tj) / 1000).toFixed(1)}s γ=${gamma.mean.toFixed(2)} β=${beta.mean.toFixed(2)} W=${W.toFixed(3)}`,
      );
    }
    const psi = armScores.full.W - Math.max(armScores.forgenOnly.W, armScores.memOnly.W);
    results.push({ caseId: c.id, arms: armScores, psi });
    console.log(`  → ψ = ${psi.toFixed(3)}`);
  }
  for (const a of Object.values(arms)) await a.afterAll(ctx).catch(() => {});

  console.log('\n=== ψ STATISTICAL SUMMARY (judge-based) ===');
  const psis = results.map((r) => r.psi);
  const ci = bootstrapMean95CI(psis);
  console.log(`N (effective)        = ${results.length}`);
  console.log(`mean ψ               = ${ci.mean.toFixed(3)}`);
  console.log(`95% bootstrap CI     = [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]`);
  console.log(`> 0 with 95% conf    = ${ci.lo > 0}`);
  console.log(`Master gate (ψ > 0)  = ${ci.lo > 0 ? 'PASS' : 'FAIL (CI crosses zero)'}`);

  // κ between judges, per axis (only when ≥ 2 judges)
  const kappaPerAxis: Record<string, number> = {};
  if (judges.length >= 2) {
    const ids = judges.map((j) => j.id);
    for (const axis of ['gamma', 'beta'] as JudgeAxis[]) {
      const a = kappaInputs[`${ids[0]}|${axis}`] ?? [];
      const b = kappaInputs[`${ids[1]}|${axis}`] ?? [];
      // round to nearest int category for κ (judge fallbacks may produce 2.5)
      const ar = a.map((x) => Math.round(x));
      const br = b.map((x) => Math.round(x));
      kappaPerAxis[axis] = cohenKappa(ar, br);
    }
    console.log(`Cohen's κ ${ids[0]} vs ${ids[1]}:`);
    for (const [axis, v] of Object.entries(kappaPerAxis)) console.log(`  ${axis}: ${v.toFixed(3)}`);
  }

  console.log('\nPer-case ψ (judge-based):');
  for (const r of results) console.log(`  ${r.caseId}: ψ=${r.psi.toFixed(3)}`);

  const out = {
    track: JUDGE_TRACK,
    judges: judges.map((j) => j.id),
    N: results.length,
    mean: ci.mean,
    ci: [ci.lo, ci.hi],
    kappaPerAxis,
    cases: results,
    generatedAt: new Date().toISOString(),
  };
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('./reports/psi-stat', { recursive: true });
  const fp = `./reports/psi-stat/psi-stat-judged-${JUDGE_TRACK}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(`\nReport saved: ${fp}`);
  process.exit(ci.lo > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
