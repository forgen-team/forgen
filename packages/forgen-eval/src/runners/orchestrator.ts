/**
 * Run orchestrator — common pipeline shared by smoke + full runners.
 *
 *   blind arms → exec arms → judge (panel × axis) → unblind → aggregate → pass-fail
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ArmResponse,
  JudgeScore,
  MetricBundle,
  RunReport,
  TestCase,
  Tier,
  Track,
  ArmId,
} from '../types.js';
import { buildArms, type ArmContext } from '../arms/index.js';
import { buildJudgePanel } from '../judges/index.js';
import { makeBlindingMap, blindResponses, unblindScores } from './blinding.js';
import { computeGamma } from '../metrics/gamma.js';
import { computeBeta } from '../metrics/beta.js';
import { computeDelta, computeEpsilon, computeZeta } from '../metrics/delta-epsilon-zeta.js';
import { computePhi } from '../metrics/phi.js';
import { computePsi } from '../metrics/psi.js';
import { fleissKappa, cohensKappa } from '../judges/kappa.js';
import { judgePassFail, renderMarkdownReport } from '../reports/pass-fail.js';
import { detectClaudeMemVersion, CLAUDE_MEM_TESTED_VERSION } from './worker-lifecycle.js';

export interface RunOptions {
  track: Track;
  tier: Tier;
  cases: TestCase[];
  outDir: string;
  datasetVersion: string;
  /** Turn depths to evaluate per case. Smoke: [5]. Full: [1,5,10] (1 anchor only). */
  turnDepths: (1 | 5 | 10)[];
}

export async function runTestbed(opts: RunOptions): Promise<RunReport> {
  const runId = `${opts.tier}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const arms = buildArms();
  const panel = buildJudgePanel(opts.track);
  const map = makeBlindingMap();
  const warnings: string[] = [];

  const detectedMem = detectClaudeMemVersion();
  if (detectedMem && !detectedMem.includes(CLAUDE_MEM_TESTED_VERSION)) {
    warnings.push(`claude-mem version mismatch: tested ${CLAUDE_MEM_TESTED_VERSION}, actual ${detectedMem}`);
  }

  // 1. Execute every arm × every case × every turn-depth
  const responses: ArmResponse[] = [];
  for (const arm of arms) {
    for (const td of opts.turnDepths) {
      const ctx: ArmContext = {
        armId: arm.id,
        workdir: join(opts.outDir, runId, arm.id, `td-${td}`),
        turnDepth: td,
      };
      mkdirSync(ctx.workdir, { recursive: true });
      try {
        await arm.beforeAll(ctx);
        for (const c of opts.cases) {
          responses.push(await arm.runCase(c, ctx));
        }
      } catch (err) {
        warnings.push(`arm=${arm.id} td=${td}: ${(err as Error).message}`);
      } finally {
        await arm.afterAll(ctx);
      }
    }
  }

  // 2. Blind arm labels before judging
  const blinded = blindResponses(responses, map);

  // 3. Judge each blinded response on each axis
  const rawScores: JudgeScore[] = [];
  for (const judge of panel) {
    for (const r of blinded) {
      for (const axis of ['gamma', 'beta', 'phi'] as const) {
        try {
          const score = await judge.judge({
            caseId: r.caseId,
            blindedArmId: r.armId,
            axis,
            material: { finalResponse: r.finalResponse },
          });
          rawScores.push(score);
        } catch (err) {
          warnings.push(`judge=${judge.id} case=${r.caseId} axis=${axis}: ${(err as Error).message}`);
        }
      }
    }
  }

  // 4. Unblind for aggregation
  const scores = unblindScores(rawScores, map);

  // 5. Aggregate metrics + κ
  const metrics = aggregateMetrics(scores, responses);
  const discardRate = warnings.length / Math.max(responses.length, 1);

  // 6. Pass/fail
  const verdict = judgePassFail(metrics, discardRate);

  const report: RunReport = {
    runId,
    track: opts.track,
    tier: opts.tier,
    startedAt,
    endedAt: new Date().toISOString(),
    claudeMemVersion: detectedMem ?? 'not-detected',
    datasetVersion: opts.datasetVersion,
    totalCases: opts.cases.length,
    discardedCases: warnings.length,
    metrics,
    passFail: verdict,
    costUsd: 0, // TODO: token accounting in v0.5.x
    warnings,
  };

  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, `${runId}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(opts.outDir, `${runId}.md`), renderMarkdownReport(report));
  return report;
}

function aggregateMetrics(scores: JudgeScore[], responses: ArmResponse[]): MetricBundle {
  const byArm = (arm: ArmId, axis: 'gamma' | 'beta' | 'phi') =>
    scores.filter((s) => s.blindedArmId === arm && s.axis === axis).map((s) => s.score);

  // γ — paired diff (forgen-on vs forgen-off slopes); placeholder uses arm averages
  const onG = byArm('forgen-only', 'gamma');
  const offG = byArm('vanilla', 'gamma');
  const gammaPairs = onG.slice(0, Math.min(onG.length, offG.length)).map((on, i) => ({
    onN5: on,
    onN10: on,
    offN5: offG[i],
    offN10: offG[i],
  }));
  const gamma = computeGamma({ pairs: gammaPairs });

  // β — paired diff (forgen-on β vs forgen-off β)
  const onB = byArm('forgen-only', 'beta');
  const offB = byArm('vanilla', 'beta');
  const betaPairs = onB.slice(0, Math.min(onB.length, offB.length)).map((on, i) => ({
    on,
    off: offB[i],
  }));
  const beta = computeBeta({ pairs: betaPairs });

  // δ/ε/ζ — counted from event traces in responses
  const arms: ArmId[] = ['vanilla', 'forgen-only', 'claude-mem-only', 'forgen-plus-mem', 'gstack-only'];
  const delta: Record<ArmId, number> = {} as Record<ArmId, number>;
  const epsilon: Record<ArmId, number> = {} as Record<ArmId, number>;
  const zeta: Record<ArmId, number> = {} as Record<ArmId, number>;
  for (const arm of arms) {
    const armResp = responses.filter((r) => r.armId === arm);
    const blocksAttempted = armResp.length;
    const blocksCaught = armResp.reduce((acc, r) => acc + r.blockEvents.length, 0);
    delta[arm] = computeDelta(blocksCaught, blocksAttempted).rate;
    epsilon[arm] = computeEpsilon(
      armResp.reduce((acc, r) => acc + r.injectEvents.length, 0),
      blocksAttempted,
    ).rate;
    // ζ requires N=50 turn-depth — placeholder: same as δ for now
    zeta[arm] = computeZeta(blocksCaught, blocksAttempted).rate;
  }

  // φ — false positive on phi-axis judgements
  const phiResult = computePhi({ judgements: scores.filter((s) => s.axis === 'phi').map((s) => s.score) });

  // ψ — composite scores per arm (normalize gamma/beta from 1-4 likert to 0-1)
  const norm = (avg: number) => Math.max(0, Math.min(1, (avg - 1) / 3));
  const psi = computePsi({
    scores: Object.fromEntries(
      arms.map((arm) => [
        arm,
        {
          gamma: norm(avg(byArm(arm, 'gamma'))),
          beta: norm(avg(byArm(arm, 'beta'))),
          delta: delta[arm],
          epsilon: epsilon[arm],
          zeta: zeta[arm],
        },
      ]),
    ) as Parameters<typeof computePsi>[0]['scores'],
  });

  // κ — judge agreement on β axis (most stable)
  const judgeIds = Array.from(new Set(scores.map((s) => s.judgeId)));
  const caseIds = Array.from(new Set(scores.map((s) => s.caseId)));
  let kappaDev = 0;
  let kappaPub = 0;
  if (judgeIds.length >= 3) {
    const matrix = caseIds.map((cid) =>
      judgeIds.map(
        (jid) =>
          scores.find((s) => s.caseId === cid && s.judgeId === jid && s.axis === 'beta')?.score ?? 0,
      ),
    );
    kappaDev = fleissKappa(matrix);
  }
  if (judgeIds.length >= 2) {
    const j1 = scores.filter((s) => s.judgeId === judgeIds[0] && s.axis === 'beta').map((s) => s.score);
    const j2 = scores.filter((s) => s.judgeId === judgeIds[1] && s.axis === 'beta').map((s) => s.score);
    kappaPub = cohensKappa(j1.slice(0, Math.min(j1.length, j2.length)), j2.slice(0, Math.min(j1.length, j2.length)));
  }

  return {
    gamma,
    beta,
    delta,
    epsilon,
    zeta,
    phi: phiResult.rate,
    psi: psi.psi,
    kappa: { dev: kappaDev, public: kappaPub },
    discardRate: 0, // set externally
  };
}

function avg(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}
