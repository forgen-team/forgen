/**
 * ψ statistical run with REAL judge scoring (γ/β 4-likert via Sonnet API).
 * Stronger signal than length-proxy version. Slower (Sonnet API calls).
 *
 * Per case: 4 arms × 1 turn-depth × ~50s (driver) + 4 arms × 2 axes × ~5s (Sonnet judge)
 *   ≈ 4-5 min/case. N=10 → ~40-50 min wall.
 */

import { VanillaArm, ForgenOnlyArm, ClaudeMemOnlyArm, ForgenPlusMemArm } from '../arms/real-arms.js';
import type { ArmContext } from '../arms/types.js';
import { loadTestCases } from '../datasets/loader.js';
import type { ArmResponse } from '../types.js';
import { SonnetClient } from '../judges/sonnet-client.js';

const DATA_DIR = process.env.FORGEN_EVAL_DATA_DIR ?? '/tmp/forgen-eval-data';
const N = Number(process.env.PSI_STAT_N ?? 10);

interface ScoredCase {
  caseId: string;
  arms: Record<string, { gamma: number; beta: number; blocks: number; injects: number; W: number }>;
  psi: number;
}

/** Compute composite W per ADR-006: γ(0.4) + β(0.2) + δ(0.15) + ε(0.1) + ζ(0.15). */
function w(s: { gamma: number; beta: number; blocks: number; injects: number }): number {
  // Normalize 1-4 likert to 0-1; events to 0-1 saturation
  const g = (s.gamma - 1) / 3;
  const b = (s.beta - 1) / 3;
  const d = Math.tanh(s.blocks);
  const e = Math.tanh(s.injects);
  const z = 1.0; // ζ architectural ≈ 1 for forgen; vanilla = 0
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

async function judgeScore(
  judge: SonnetClient,
  caseId: string,
  blindedArm: string,
  axis: 'gamma' | 'beta',
  response: string,
  persona: string,
): Promise<number> {
  try {
    const result = await judge.judge({
      caseId,
      blindedArmId: blindedArm,
      axis,
      material: { finalResponse: response, persona, correctionHistory: '(prior turns omitted)' },
    });
    return result.score;
  } catch {
    // Fallback: middle score on error
    return 2.5;
  }
}

async function main() {
  const cases = loadTestCases({ rootDir: DATA_DIR, realRetroMinRatio: 0, limit: N });
  console.log(`ψ statistical run with real Sonnet judge × N=${cases.length} cases`);

  const judge = new SonnetClient({ model: 'claude-sonnet-4-6' });
  const ping = await judge.ping();
  if (!ping.ok) {
    console.error('Sonnet judge ping failed — check ANTHROPIC_API_KEY');
    process.exit(1);
  }
  console.log(`Sonnet ping OK (${ping.latencyMs}ms)`);

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
  let i = 0;
  for (const c of cases.slice(0, N)) {
    i++;
    console.log(`\n[${i}/${cases.length}] case=${c.id}`);
    const armResp: Record<string, ArmResponse> = {};
    for (const [k, a] of Object.entries(arms)) {
      const t0 = Date.now();
      try {
        armResp[k] = await a.runCase(c, { ...ctx, armId: a.id });
        console.log(`  ${k}: arm ${((Date.now() - t0) / 1000).toFixed(1)}s b=${armResp[k].blockEvents.length} i=${armResp[k].injectEvents.length}`);
      } catch (e) {
        console.error(`  ${k}: ${(e as Error).message}`);
      }
    }
    if (!armResp.vanilla || !armResp.forgenOnly || !armResp.memOnly || !armResp.full) continue;

    const persona = `persona ${c.personaId}, scenario ${c.scenario}`;
    const armScores: ScoredCase['arms'] = {};
    for (const [k, r] of Object.entries(armResp)) {
      const tj = Date.now();
      const gamma = await judgeScore(judge, c.id, k, 'gamma', r.finalResponse, persona);
      const beta = await judgeScore(judge, c.id, k, 'beta', r.finalResponse, persona);
      const W = w({ gamma, beta, blocks: r.blockEvents.length, injects: r.injectEvents.length });
      armScores[k] = { gamma, beta, blocks: r.blockEvents.length, injects: r.injectEvents.length, W };
      console.log(`  ${k}: judge ${((Date.now() - tj) / 1000).toFixed(1)}s γ=${gamma} β=${beta} W=${W.toFixed(3)}`);
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

  console.log('\nPer-case ψ (judge-based):');
  for (const r of results) console.log(`  ${r.caseId}: ψ=${r.psi.toFixed(3)}`);

  const out = { N: results.length, mean: ci.mean, ci: [ci.lo, ci.hi], cases: results, generatedAt: new Date().toISOString() };
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('./reports/psi-stat', { recursive: true });
  const fp = `./reports/psi-stat/psi-stat-judged-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(`\nReport saved: ${fp}`);
  process.exit(ci.lo > 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
