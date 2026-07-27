/**
 * Persistence A/B 러너 (2026-07-27) — forgen δ 를 "거리를 둔 정책 준수"로 실증.
 *
 * 각 케이스: 정책 교정(turn0) → distractor 턴들(거리) → 정책 트리거. 두 arm(vanilla,
 * forgenOnly)을 돌려 최종 응답을 정책 gold 로 준수 판정. δ_persistence = complyRate 차이.
 * 1차 지표는 deterministic(저지 독립) — driver 호출만 쓰고 judge quota 불요.
 *
 * env:
 *   PERSISTENCE_CASES   — 케이스 jsonl 경로 (기본 datasets/persistence-ab/cases.jsonl)
 *   PERSISTENCE_DEPTH   — correctionSequence 를 몇 턴까지 재생할지 (기본: 전부)
 *   CLAUDE_CLI_DRIVER_MODEL — driver 모델 (claude-sonnet-5 / claude-opus-4-8)
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { VanillaArm, ForgenOnlyArm } from '../arms/real-arms.js';
import type { ArmContext } from '../arms/types.js';
import type { TestCase, ArmResponse, TurnDepth } from '../types.js';
import { scorePolicyCompliance, summarizePolicy, type PolicyScore } from '../metrics/policy.js';

const CASES_PATH = process.env.PERSISTENCE_CASES ?? './datasets/persistence-ab/cases.jsonl';
// TurnDepth ∈ {1,5,10,50}. 케이스가 정책+distractor 로 4~ 턴이므로 10 이면 전 턴 재생.
const VALID_DEPTHS: TurnDepth[] = [1, 5, 10, 50];
const DEPTH: TurnDepth = (() => {
  const d = Number(process.env.PERSISTENCE_DEPTH);
  return VALID_DEPTHS.includes(d as TurnDepth) ? (d as TurnDepth) : 10;
})();

function loadCases(path: string): TestCase[] {
  if (!existsSync(path)) throw new Error(`persistence cases not found: ${path}`);
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TestCase)
    .filter((c) => c.policyGold);
}

function bootstrapDiff95CI(
  forgen: number[],
  vanilla: number[],
  iters = 2000,
): { mean: number; lo: number; hi: number } {
  // per-case paired diff (같은 케이스의 forgen−vanilla)의 부트스트랩 CI.
  const diffs = forgen.map((x, i) => x - vanilla[i]);
  if (diffs.length === 0) return { mean: 0, lo: 0, hi: 0 };
  const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    let acc = 0;
    for (let j = 0; j < diffs.length; j++) acc += diffs[Math.floor(Math.random() * diffs.length)];
    samples.push(acc / diffs.length);
  }
  samples.sort((x, y) => x - y);
  return { mean, lo: samples[Math.floor(iters * 0.025)], hi: samples[Math.floor(iters * 0.975)] };
}

async function main() {
  const cases = loadCases(CASES_PATH);
  const driver = process.env.CLAUDE_CLI_DRIVER_MODEL ?? 'sonnet';
  console.log(`Persistence A/B — N=${cases.length} cases, driver=${driver}, depth=${DEPTH}`);

  const vanilla = new VanillaArm();
  const forgen = new ForgenOnlyArm();
  const perCase: Array<{
    id: string;
    vanilla: PolicyScore & { blocks: number; injects: number };
    forgen: PolicyScore & { blocks: number; injects: number };
    vanillaResp: string;
    forgenResp: string;
  }> = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const ctxV: ArmContext = { armId: 'vanilla', workdir: '/tmp/persistence', turnDepth: DEPTH };
    const ctxF: ArmContext = { armId: 'forgen-only', workdir: '/tmp/persistence', turnDepth: DEPTH };
    console.log(`\n[${i + 1}/${cases.length}] case=${c.id} (policy, ${c.correctionSequence.length} turns)`);
    let vr: ArmResponse | null = null;
    let fr: ArmResponse | null = null;
    try {
      vr = await vanilla.runCase(c, ctxV);
    } catch (e) {
      console.error(`  vanilla error: ${(e as Error).message}`);
    }
    try {
      fr = await forgen.runCase(c, ctxF);
    } catch (e) {
      console.error(`  forgen error: ${(e as Error).message}`);
    }
    if (!vr || !fr) {
      console.error('  → skip (arm failure)');
      continue;
    }
    const vs = scorePolicyCompliance(vr, c.policyGold!);
    const fs2 = scorePolicyCompliance(fr, c.policyGold!);
    perCase.push({
      id: c.id,
      vanilla: { ...vs, blocks: vr.blockEvents.length, injects: vr.injectEvents.length },
      forgen: { ...fs2, blocks: fr.blockEvents.length, injects: fr.injectEvents.length },
      vanillaResp: vr.finalResponse.slice(0, 600),
      forgenResp: fr.finalResponse.slice(0, 600),
    });
    console.log(
      `  vanilla comply=${vs.compliant} (v:${vs.matchedViolate.length} c:${vs.matchedComply.length}) | ` +
      `forgen comply=${fs2.compliant} (inj=${fr.injectEvents.length})`,
    );
  }

  const vScores = perCase.map((p) => p.vanilla);
  const fScores = perCase.map((p) => p.forgen);
  const vSum = summarizePolicy('vanilla', vScores);
  const fSum = summarizePolicy('forgenOnly', fScores);
  const vArr = vScores.map((s) => (s.compliant ? 1 : 0));
  const fArr = fScores.map((s) => (s.compliant ? 1 : 0));
  const ci = bootstrapDiff95CI(fArr, vArr);

  console.log('\n=== PERSISTENCE δ SUMMARY (deterministic policy compliance) ===');
  console.log(`N (effective)         = ${perCase.length}`);
  console.log(`vanilla    complyRate = ${vSum.complyRate.toFixed(3)} (${vSum.compliantCount}/${vSum.n})`);
  console.log(`forgenOnly complyRate = ${fSum.complyRate.toFixed(3)} (${fSum.compliantCount}/${fSum.n})`);
  console.log(`δ_persistence (paired)= ${ci.mean.toFixed(3)}  95% CI [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]`);
  console.log(`δ > 0 (CI 하한>0)     = ${ci.lo > 0 ? 'YES — forgen 이 거리에서 정책 준수를 높임' : 'NO (CI가 0을 지남 / null)'}`);
  console.log('\n⚠ deterministic 판정 — 준수/위반 샘플 사람 스팟체크 필수(문구 아티팩트 방지).');

  const out = {
    kind: 'persistence-ab',
    driverModel: driver,
    depth: DEPTH,
    N: perCase.length,
    vanillaComplyRate: vSum.complyRate,
    forgenComplyRate: fSum.complyRate,
    deltaPersistence: { mean: ci.mean, ci: [ci.lo, ci.hi] },
    perCase,
    generatedAt: new Date().toISOString(),
  };
  mkdirSync('./reports/persistence', { recursive: true });
  const fp = `./reports/persistence/persistence-${driver}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(`\nReport saved: ${fp}`);
  process.exit(ci.lo > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
