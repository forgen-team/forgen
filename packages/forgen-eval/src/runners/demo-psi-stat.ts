/**
 * Demo: ψ statistical run on N cases (objective W_arm proxies, no judge calls).
 *
 * W_arm proxies (no LLM judge — keeps run fast + reproducible):
 *   block_score   = min(block_events / 1, 1)      [0..1]
 *   inject_score  = min(inject_events / 1, 1)     [0..1]
 *   length_score  = clip(len(response) - len(vanilla)) / max(...)
 *
 * ψ_per_case = W_full_score - max(W_forgen_only, W_mem_only)
 * Aggregate: mean ψ + bootstrap 95% CI over N cases.
 */

import { VanillaArm, ForgenOnlyArm, ClaudeMemOnlyArm, ForgenPlusMemArm } from '../arms/real-arms.js';
import type { ArmContext } from '../arms/types.js';
import { loadTestCases } from '../datasets/loader.js';
import type { ArmResponse } from '../types.js';

const DATA_DIR = process.env.FORGEN_EVAL_DATA_DIR ?? '/tmp/forgen-eval-data';
const N = Number(process.env.PSI_STAT_N ?? 10);

interface CaseResult {
  caseId: string;
  arms: Record<string, { length: number; blocks: number; injects: number }>;
  psiProxy: number;
}

function w(arm: { length: number; blocks: number; injects: number }, vanillaLen: number): number {
  // Composite W proxy in [0..1]: mix of differentiation from vanilla + forgen events
  const lengthDiff = Math.tanh((arm.length - vanillaLen) / 100);
  const block = Math.tanh(arm.blocks);
  const inject = Math.tanh(arm.injects);
  return 0.4 * (lengthDiff + 1) / 2 + 0.3 * block + 0.3 * inject;
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

async function main() {
  const cases = loadTestCases({ rootDir: DATA_DIR, realRetroMinRatio: 0, limit: N });
  if (cases.length < N) console.warn(`Only ${cases.length} cases available (requested ${N})`);

  const arms = {
    vanilla: new VanillaArm(),
    forgenOnly: new ForgenOnlyArm(),
    memOnly: new ClaudeMemOnlyArm(),
    full: new ForgenPlusMemArm(),
  };
  const ctx: ArmContext = { armId: 'vanilla', workdir: '/tmp/psi-stat', turnDepth: 1 };

  // beforeAll for each arm
  for (const [k, a] of Object.entries(arms)) {
    try {
      await a.beforeAll({ ...ctx, armId: a.id });
    } catch (e) {
      console.error(`beforeAll(${k}) failed: ${(e as Error).message}`);
    }
  }

  const results: CaseResult[] = [];
  let i = 0;
  for (const c of cases.slice(0, N)) {
    i++;
    console.log(`\n[${i}/${cases.length}] case=${c.id}`);
    const armResp: Record<string, ArmResponse> = {};
    for (const [k, a] of Object.entries(arms)) {
      const t0 = Date.now();
      try {
        armResp[k] = await a.runCase(c, { ...ctx, armId: a.id });
        console.log(`  ${k}: ${((Date.now() - t0) / 1000).toFixed(1)}s | len=${armResp[k].finalResponse.length} b=${armResp[k].blockEvents.length} i=${armResp[k].injectEvents.length}`);
      } catch (e) {
        console.error(`  ${k}: error ${(e as Error).message}`);
      }
    }

    if (!armResp.vanilla || !armResp.forgenOnly || !armResp.memOnly || !armResp.full) continue;

    const armScores: CaseResult['arms'] = {};
    for (const [k, r] of Object.entries(armResp)) {
      armScores[k] = { length: r.finalResponse.length, blocks: r.blockEvents.length, injects: r.injectEvents.length };
    }
    const vanillaLen = armScores.vanilla.length;
    const w_full = w(armScores.full, vanillaLen);
    const w_forgen = w(armScores.forgenOnly, vanillaLen);
    const w_mem = w(armScores.memOnly, vanillaLen);
    const psi = w_full - Math.max(w_forgen, w_mem);
    results.push({ caseId: c.id, arms: armScores, psiProxy: psi });
    console.log(`  ψ_proxy = ${psi.toFixed(3)}`);
  }

  for (const a of Object.values(arms)) await a.afterAll(ctx).catch(() => {});

  console.log('\n=== ψ STATISTICAL SUMMARY ===');
  console.log(`N (effective) = ${results.length}`);
  const psis = results.map((r) => r.psiProxy);
  const ci = bootstrapMean95CI(psis);
  console.log(`mean ψ_proxy = ${ci.mean.toFixed(3)}`);
  console.log(`95% bootstrap CI = [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]`);
  console.log(`> 0 with 95% confidence: ${ci.lo > 0}`);
  console.log('\nPer-case ψ_proxy:');
  for (const r of results) console.log(`  ${r.caseId}: ${r.psiProxy.toFixed(3)}`);

  const out = { N: results.length, mean: ci.mean, ci: [ci.lo, ci.hi], cases: results, generatedAt: new Date().toISOString() };
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('./reports/psi-stat', { recursive: true });
  const fp = `./reports/psi-stat/psi-stat-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(`\nReport saved: ${fp}`);
  process.exit(ci.lo > 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
