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
import { PolicyJudge, type PolicyVerdict } from '../judges/policy-judge.js';

// judge 채점 on/off (기본 on). regex 는 secondary screen 으로만 병기.
const JUDGE = process.env.PERSISTENCE_JUDGE !== '0';

/** 정책 텍스트 = 이전 세션 교정(priorSession) 또는 첫 correction 턴. */
function policyText(c: TestCase): string {
  const t = c.correctionSequence.find((x) => x.priorSession) ?? c.correctionSequence[0];
  return t?.userMsg ?? '';
}

/** 2-judge 합의: 둘 다 compliant → true. 불일치 기록. */
function judgeCompliance(verdicts: PolicyVerdict[]): { compliant: boolean; agree: boolean } {
  const yes = verdicts.filter((v) => v.compliant).length;
  return { compliant: yes === verdicts.length, agree: yes === 0 || yes === verdicts.length };
}

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
    // policy 케이스 = policyGold(regex screen) 또는 priorSession 교정(judge 채점) 보유.
    // judge 가 primary 라 신규 케이스는 policyGold 없이 priorSession 만으로 충분.
    .filter((c) => c.policyGold || c.correctionSequence.some((t) => t.priorSession));
}

const EMPTY_SCORE: PolicyScore = { compliant: false, matchedComply: [], matchedViolate: [] };

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
  const judges = JUDGE ? [new PolicyJudge({ model: 'sonnet' }), new PolicyJudge({ model: 'haiku' })] : [];
  if (JUDGE) {
    for (const j of judges) {
      const ok = await j.ping();
      console.log(`  policy-judge ${j.id} ping: ${ok}`);
      if (!ok) {
        console.error(`judge ${j.id} unavailable — abort (set PERSISTENCE_JUDGE=0 to skip)`);
        process.exit(1);
      }
    }
    console.log('  ⚠ judges 는 Claude 계열(intra-family) — 자기선호 편향 가능, 사람 스팟체크 병행.');
  }
  type ArmCell = PolicyScore & {
    blocks: number;
    injects: number;
    judge?: { compliant: boolean; agree: boolean; verdicts: PolicyVerdict[] };
  };
  const perCase: Array<{
    id: string;
    vanilla: ArmCell;
    forgen: ArmCell;
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
    const vs = c.policyGold ? scorePolicyCompliance(vr, c.policyGold) : EMPTY_SCORE;
    const fs2 = c.policyGold ? scorePolicyCompliance(fr, c.policyGold) : EMPTY_SCORE;
    const vCell: ArmCell = { ...vs, blocks: vr.blockEvents.length, injects: vr.injectEvents.length };
    const fCell: ArmCell = { ...fs2, blocks: fr.blockEvents.length, injects: fr.injectEvents.length };
    if (JUDGE) {
      const pol = policyText(c);
      // arm-blind: judge 는 policy/request/response 만 받음(어느 arm 인지 모름).
      const vV = await Promise.all(judges.map((j) => j.judge(pol, c.trigger.prompt, vr!.finalResponse).catch((e) => ({ compliant: false, rationale: `err:${(e as Error).message}`, judgeId: j.id }))));
      const fV = await Promise.all(judges.map((j) => j.judge(pol, c.trigger.prompt, fr!.finalResponse).catch((e) => ({ compliant: false, rationale: `err:${(e as Error).message}`, judgeId: j.id }))));
      vCell.judge = { ...judgeCompliance(vV), verdicts: vV };
      fCell.judge = { ...judgeCompliance(fV), verdicts: fV };
    }
    perCase.push({
      id: c.id,
      vanilla: vCell,
      forgen: fCell,
      vanillaResp: vr.finalResponse.slice(0, 900),
      forgenResp: fr.finalResponse.slice(0, 900),
    });
    console.log(
      `  vanilla: regex=${vs.compliant}${vCell.judge ? ` judge=${vCell.judge.compliant}(agree=${vCell.judge.agree})` : ''} | ` +
      `forgen: regex=${fs2.compliant}${fCell.judge ? ` judge=${fCell.judge.compliant}(agree=${fCell.judge.agree})` : ''} (inj=${fr.injectEvents.length})`,
    );
  }

  const vScores = perCase.map((p) => p.vanilla);
  const fScores = perCase.map((p) => p.forgen);
  const vSum = summarizePolicy('vanilla', vScores);
  const fSum = summarizePolicy('forgenOnly', fScores);
  const vArr = vScores.map((s) => (s.compliant ? 1 : 0));
  const fArr = fScores.map((s) => (s.compliant ? 1 : 0));
  const ci = bootstrapDiff95CI(fArr, vArr);

  // ── judge-based δ (PRIMARY when JUDGE on) ──────────────────────────────────
  let judgeSummary: Record<string, unknown> | null = null;
  if (JUDGE) {
    const vJ: number[] = perCase.map((p) => (p.vanilla.judge?.compliant ? 1 : 0));
    const fJ: number[] = perCase.map((p) => (p.forgen.judge?.compliant ? 1 : 0));
    const vRate = vJ.reduce((a, b) => a + b, 0) / (vJ.length || 1);
    const fRate = fJ.reduce((a, b) => a + b, 0) / (fJ.length || 1);
    const jci = bootstrapDiff95CI(fJ, vJ);
    // inter-judge 합의율(2-judge): 각 응답에서 두 judge 가 일치한 비율.
    const cells = perCase.flatMap((p) => [p.vanilla.judge, p.forgen.judge]).filter(Boolean) as { agree: boolean }[];
    const agreeRate = cells.length ? cells.filter((c) => c.agree).length / cells.length : 0;
    console.log('\n=== PERSISTENCE δ SUMMARY (judge-based, PRIMARY) ===');
    console.log(`N (effective)         = ${perCase.length}  (judges: ${judges.map((j) => j.id).join('+')}, intra-family)`);
    console.log(`vanilla    complyRate = ${vRate.toFixed(3)}`);
    console.log(`forgenOnly complyRate = ${fRate.toFixed(3)}`);
    console.log(`δ_persistence (paired)= ${jci.mean.toFixed(3)}  95% CI [${jci.lo.toFixed(3)}, ${jci.hi.toFixed(3)}]`);
    console.log(`δ > 0 (CI 하한>0)     = ${jci.lo > 0 ? 'YES — forgen 이 cross-session 정책 준수를 높임' : 'NO (CI가 0을 지남 / null)'}`);
    console.log(`inter-judge 합의율     = ${agreeRate.toFixed(3)} (낮으면 사람 스팟체크 가중)`);
    judgeSummary = { vanillaComplyRate: vRate, forgenComplyRate: fRate, delta: { mean: jci.mean, ci: [jci.lo, jci.hi] }, interJudgeAgreement: agreeRate };
  }

  console.log('\n=== PERSISTENCE δ (deterministic regex, SECONDARY screen — 한국어 stance 과소집계 주의) ===');
  console.log(`vanilla    complyRate = ${vSum.complyRate.toFixed(3)} (${vSum.compliantCount}/${vSum.n})`);
  console.log(`forgenOnly complyRate = ${fSum.complyRate.toFixed(3)} (${fSum.compliantCount}/${fSum.n})`);
  console.log(`δ_regex (paired)      = ${ci.mean.toFixed(3)}  95% CI [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]`);
  console.log('\n⚠ deterministic 판정 — 준수/위반 샘플 사람 스팟체크 필수(문구 아티팩트 방지).');

  const out = {
    kind: 'persistence-ab',
    driverModel: driver,
    depth: DEPTH,
    N: perCase.length,
    primary: JUDGE ? 'judge' : 'regex',
    judge: judgeSummary, // judge-based δ (PRIMARY)
    regexScreen: {
      vanillaComplyRate: vSum.complyRate,
      forgenComplyRate: fSum.complyRate,
      delta: { mean: ci.mean, ci: [ci.lo, ci.hi] },
    },
    perCase,
    generatedAt: new Date().toISOString(),
  };
  mkdirSync('./reports/persistence', { recursive: true });
  const fp = `./reports/persistence/persistence-${driver}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(`\nReport saved: ${fp}`);
  // exit 0 = primary δ CI 하한 > 0. JUDGE on 이면 judge δ, 아니면 regex.
  const primaryLo = JUDGE && judgeSummary ? (judgeSummary.delta as { ci: number[] }).ci[0] : ci.lo;
  process.exit(primaryLo > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
