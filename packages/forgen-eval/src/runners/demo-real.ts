/**
 * Demo runner — quickest possible evidence that forgen changes responses.
 *
 * Runs 1 case through vanilla vs forgen-only arms, prints both final responses
 * + forgen events. Visible side-by-side comparison.
 *
 * Usage:
 *   FORGEN_EVAL_DATA_DIR=/tmp/forgen-eval-data \
 *   OLLAMA_DRIVER_MODEL=qwen2.5:14b \
 *   node dist/runners/demo-real.js [case-id]
 */

import { loadTestCases } from '../datasets/loader.js';
import { VanillaArm, ForgenOnlyArm } from '../arms/real-arms.js';
import type { ArmContext } from '../arms/types.js';

const DATA_DIR = process.env.FORGEN_EVAL_DATA_DIR ?? '/tmp/forgen-eval-data';

async function main() {
  const targetId = process.argv[2];
  const cases = loadTestCases({ rootDir: DATA_DIR, realRetroMinRatio: 0 });
  const target = targetId ? cases.find((c) => c.id === targetId) : cases[0];
  if (!target) {
    console.error(`Case not found. Available: ${cases.map((c) => c.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n=== DEMO: ${target.id} (${target.source}) ===`);
  console.log(`persona: ${target.personaId} | scenario: ${target.scenario}`);
  console.log(`correction sequence (${target.correctionSequence.length} turn):`);
  for (const t of target.correctionSequence) {
    console.log(`  user: ${t.userMsg}${t.expectedRule ? ` [rule: ${t.expectedRule}]` : ''}`);
  }
  console.log(`final trigger: ${target.trigger.prompt}`);
  console.log();

  const ctx: ArmContext = { armId: 'vanilla', workdir: '/tmp/demo-vanilla', turnDepth: 5 };

  console.log('--- VANILLA arm (no forgen, no claude-mem) ---');
  const vanilla = new VanillaArm();
  const t0 = Date.now();
  const vRes = await vanilla.runCase(target, ctx);
  console.log(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`final response:\n${vRes.finalResponse}\n`);

  console.log('--- FORGEN-ONLY arm (UserPromptSubmit + Stop hooks) ---');
  const forgen = new ForgenOnlyArm();
  const t1 = Date.now();
  const fRes = await forgen.runCase(target, { ...ctx, armId: 'forgen-only' });
  console.log(`elapsed: ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log(`forgen events:`);
  console.log(`  inject events: ${fRes.injectEvents.length}`);
  for (const e of fRes.injectEvents.slice(0, 3)) {
    console.log(`    [${e.ruleId}] ${e.injectedText.slice(0, 100)}...`);
  }
  console.log(`  block events: ${fRes.blockEvents.length}`);
  for (const e of fRes.blockEvents.slice(0, 3)) {
    console.log(`    [${e.ruleId}] ${e.reason.slice(0, 100)}...`);
  }
  console.log(`final response:\n${fRes.finalResponse}\n`);

  console.log('=== DIFFERENCE ===');
  if (vRes.finalResponse === fRes.finalResponse) {
    console.log('⚠ identical responses — forgen had no observable effect on this case');
  } else {
    console.log(`✓ responses differ (vanilla: ${vRes.finalResponse.length} chars, forgen: ${fRes.finalResponse.length} chars)`);
    console.log(`  forgen injected ${fRes.injectEvents.length} times, blocked ${fRes.blockEvents.length} times`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
