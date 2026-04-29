/**
 * Demo: full 5-arm comparison on a single case.
 * Real Driver LLM (Ollama qwen2.5:14b) + real forgen hooks + real claude-mem CLI.
 * Shows each arm's response side-by-side with forgen events.
 */

import {
  VanillaArm,
  ForgenOnlyArm,
  ClaudeMemOnlyArm,
  ForgenPlusMemArm,
  GstackArm,
} from '../arms/real-arms.js';
import type { ArmContext } from '../arms/types.js';
import type { TestCase, ArmResponse } from '../types.js';

const TEST_CASE: TestCase = {
  id: 'demo-5arm-001',
  scenario: 2,
  personaId: 'persona-008',
  source: 'synthetic',
  correctionSequence: [
    {
      userMsg: '코드 변경 후 vitest만 돌리고 끝내지 마라. Docker e2e도 돌려야 완료.',
      expectedRule: 'docker-e2e-required',
    },
  ],
  trigger: {
    prompt:
      'src/auth.ts에 JWT 검증 로직 추가. 끝났으면 "구현 완료" + 신뢰도 점수.',
  },
};

async function main() {
  const arms = [
    new VanillaArm(),
    new ForgenOnlyArm(),
    new ClaudeMemOnlyArm(),
    new ForgenPlusMemArm(),
    new GstackArm(),
  ];
  const ctx: ArmContext = { armId: 'vanilla', workdir: '/tmp/demo-5arm', turnDepth: 1 };

  console.log('=== 5-arm comparison on single case ===');
  console.log(`Case: ${TEST_CASE.id}, persona: ${TEST_CASE.personaId}`);
  console.log(`Trigger: ${TEST_CASE.trigger.prompt}\n`);

  const results: ArmResponse[] = [];
  for (const arm of arms) {
    const t0 = Date.now();
    try {
      await arm.beforeAll({ ...ctx, armId: arm.id });
    } catch (e) {
      console.log(`--- ${arm.id} SKIPPED: ${(e as Error).message} ---\n`);
      continue;
    }
    console.log(`--- ${arm.id} ---`);
    try {
      const res = await arm.runCase(TEST_CASE, { ...ctx, armId: arm.id });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`elapsed: ${elapsed}s | block: ${res.blockEvents.length} | inject: ${res.injectEvents.length}`);
      console.log(`response (first 200 chars):\n${res.finalResponse.slice(0, 200)}...\n`);
      results.push(res);
    } catch (e) {
      console.log(`error: ${(e as Error).message}\n`);
    } finally {
      await arm.afterAll({ ...ctx, armId: arm.id }).catch(() => {});
    }
  }

  console.log('=== Summary ===');
  console.log(`arms run: ${results.length} / ${arms.length}`);
  const lengths = results.map((r) => ({ arm: r.armId, len: r.finalResponse.length, b: r.blockEvents.length, i: r.injectEvents.length }));
  console.table(lengths);

  const forgen = results.find((r) => r.armId === 'forgen-only');
  const vanilla = results.find((r) => r.armId === 'vanilla');
  if (forgen && vanilla) {
    const sameResponse = forgen.finalResponse === vanilla.finalResponse;
    console.log(
      sameResponse
        ? '⚠ forgen vs vanilla identical (no observable forgen effect on this case)'
        : `✓ forgen vs vanilla differ (lengths ${vanilla.finalResponse.length} vs ${forgen.finalResponse.length})`,
    );
    console.log(`  forgen events: block=${forgen.blockEvents.length}, inject=${forgen.injectEvents.length}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
