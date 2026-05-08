/**
 * Probe — mem injection capture for ψ analysis
 *
 * 2026-05-08: track-armfix N=10 sonnet 측정에서 음수 ψ 5케이스가 일관되게
 *   나왔다 (syn-002, syn-004, syn-005, syn-007, retro-001). 가설: claude-mem
 *   recall 이 페르소나-비특이적 일반 과거를 끌어와 forgen rule inject 가 만든
 *   특이 시그널을 dilute 한다.
 *
 * 본 probe 는 judge 호출을 건너뛰고 5케이스의 ForgenPlusMemArm 만 실행하여
 *   inject 된 [forgen rules] / [claude-mem recall] 텍스트를 콘솔에 덤프한다.
 *   질적 분석 → ADR / Driver determinism 결정 의 근거.
 */

import { ForgenPlusMemArm, ForgenOnlyArm } from '../arms/real-arms.js';
import { loadTestCases } from '../datasets/loader.js';
import type { ArmContext } from '../arms/types.js';

const DATA_DIR = process.env.FORGEN_EVAL_DATA_DIR ?? '/tmp/forgen-eval-data';
const TARGET_IDS = new Set([
  process.env.PROBE_CASES?.split(',') ?? ['syn-002', 'syn-004', 'syn-005', 'syn-007', 'retro-001'],
].flat());

async function main() {
  const all = loadTestCases({ rootDir: DATA_DIR, realRetroMinRatio: 0, limit: 100 });
  const cases = all.filter((c) => TARGET_IDS.has(c.id));
  console.log(`Probing ${cases.length} cases: ${cases.map((c) => c.id).join(', ')}`);

  const fullArm = new ForgenPlusMemArm();
  const forgenArm = new ForgenOnlyArm();
  const ctx: ArmContext = { armId: 'forgen-plus-mem', workdir: '/tmp/probe-mem', turnDepth: 1 };

  await fullArm.beforeAll({ ...ctx, armId: 'forgen-plus-mem' });
  await forgenArm.beforeAll({ ...ctx, armId: 'forgen-only' });

  for (const c of cases) {
    console.log(`\n${'='.repeat(80)}\nCASE ${c.id}  (persona=${c.personaId})`);
    console.log(`Trigger: ${c.trigger.prompt.slice(0, 200)}`);
    console.log(`Corrections: ${c.correctionSequence.length} turn(s)`);
    for (let i = 0; i < c.correctionSequence.length; i++) {
      console.log(`  [${i + 1}] ${c.correctionSequence[i].userMsg.slice(0, 120)}`);
    }

    // Forgen-only run for baseline inject comparison
    const fo = await forgenArm.runCase(c, { ...ctx, armId: 'forgen-only' });
    console.log(`\n--- forgenOnly inject events (${fo.injectEvents.length}) ---`);
    for (const ev of fo.injectEvents) {
      console.log(`[${ev.ruleId}] ${ev.injectedText.replace(/\n/g, ' ⏎ ').slice(0, 350)}`);
    }
    console.log(`\n--- forgenOnly response (${fo.finalResponse.length}ch) ---`);
    console.log(fo.finalResponse.slice(0, 400));

    // Full arm run with both inject paths
    const f = await fullArm.runCase(c, { ...ctx, armId: 'forgen-plus-mem' });
    console.log(`\n--- full inject events (${f.injectEvents.length}) ---`);
    for (const ev of f.injectEvents) {
      console.log(`[${ev.ruleId}] ${ev.injectedText.replace(/\n/g, ' ⏎ ').slice(0, 350)}`);
    }
    console.log(`\n--- full response (${f.finalResponse.length}ch) ---`);
    console.log(f.finalResponse.slice(0, 400));
  }

  await fullArm.afterAll(ctx).catch(() => {});
  await forgenArm.afterAll(ctx).catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
