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

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { VanillaArm, ForgenOnlyArm, ClaudeMemOnlyArm, ForgenPlusMemArm } from '../arms/real-arms.js';
import type { ArmContext } from '../arms/types.js';
import { loadTestCases } from '../datasets/loader.js';
import type { ArmResponse, Track } from '../types.js';
import type { JudgeAxis, JudgeClient } from '../judges/index.js';
import { ClaudeCliClient, CodexCliClient, OllamaClient, SonnetClient } from '../judges/index.js';
import { kappaGate, cohensKappa } from '../judges/kappa.js';
import { resetJudgeParseTelemetry, judgeParseTelemetry } from '../judges/judge-types.js';
import { summarizeBehavioral, type BehavioralArmSummary } from '../metrics/behavioral.js';

/** Load persona spec JSON for β-axis judging. Cached per personaId. */
const personaCache = new Map<string, string>();
function loadPersonaSpec(rootDir: string, personaId: string): string {
  if (personaCache.has(personaId)) return personaCache.get(personaId)!;
  const path = join(rootDir, 'personas', `${personaId}.json`);
  if (!existsSync(path)) {
    const stub = `(persona spec missing: ${personaId})`;
    personaCache.set(personaId, stub);
    return stub;
  }
  const spec = JSON.parse(readFileSync(path, 'utf-8'));
  const text = JSON.stringify(spec, null, 2);
  personaCache.set(personaId, text);
  return text;
}

const DATA_DIR = process.env.FORGEN_EVAL_DATA_DIR ?? '/tmp/forgen-eval-data';
const N = Number(process.env.PSI_STAT_N ?? 10);
const JUDGE_TRACK = (process.env.JUDGE_TRACK ?? 'API_DEV') as Track;
/**
 * Arm subset (R2 honest-N): claude-mem 이 없는/부적격인 환경에선 mem arm 2개가
 * 케이스 전체 skip 을 유발한다(N_eff=0). ψ_synergy 는 ADR-010 에서 이미 연기됨
 * (claude-mem 갓 설치 → ≥2주 공동사용 필요). 릴리스 핵심 지표는 δ = forgenOnly−vanilla
 * 이므로 `PSI_ARMS=vanilla,forgenOnly` 로 2-arm δ 측정을 지원한다. 기본은 4-arm.
 */
const ALL_ARM_IDS = ['vanilla', 'forgenOnly', 'memOnly', 'full'] as const;
type ArmKey = (typeof ALL_ARM_IDS)[number];
const ENABLED_ARMS = (process.env.PSI_ARMS ?? ALL_ARM_IDS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean) as ArmKey[];
for (const a of ENABLED_ARMS) {
  if (!ALL_ARM_IDS.includes(a)) throw new Error(`Unknown arm in PSI_ARMS: ${a} (valid: ${ALL_ARM_IDS.join(',')})`);
}
if (!ENABLED_ARMS.includes('vanilla') || !ENABLED_ARMS.includes('forgenOnly')) {
  throw new Error('PSI_ARMS must include at least vanilla,forgenOnly (δ baseline)');
}
const SYNERGY = ENABLED_ARMS.includes('memOnly') && ENABLED_ARMS.includes('full');

interface PerArmScore {
  gamma: number;
  beta: number;
  blocks: number;
  injects: number;
  W: number;
  /** Per-judge raw scores for κ computation. */
  rawScores: { judge: string; axis: JudgeAxis; score: number }[];
  /** Captured for qualitative review (which arm produced what response). */
  finalResponse: string;
}

interface ScoredCase {
  caseId: string;
  arms: Record<string, PerArmScore>;
  /** ψ_synergy = full − max(forgenOnly, memOnly). NaN when mem arms disabled. */
  psi: number;
  /** δ = forgenOnly − vanilla (release-primary injection effect). */
  delta: number;
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

// κ 는 judges/kappa.ts cohensKappa 하나로 통일 (리뷰 #12 SEV-3): 로컬 중복
// 구현이 퇴화 규약을 달리해(pE===1 시 1 vs 0) 한 리포트에 상충하는 κ 두 값이
// 나오던 문제를 제거. 퇴화 판정·완화는 kappaGate 한 곳에서만 결정한다.
const cohenKappa = cohensKappa;

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
  if (track === 'CLAUDE_DUAL')
    // v0.5.0 R2 — codex 해지 후 Claude 전용 이중 패널 (haiku+sonnet, 둘 다 CLI).
    return [new ClaudeCliClient({ model: 'haiku' }), new ClaudeCliClient({ model: 'sonnet' })];
  if (track === 'ENSEMBLE')
    return [new ClaudeCliClient(), new CodexCliClient(), new OllamaClient('llama-8b')];
  if (track === 'DEV') return [new SonnetClient()];
  throw new Error(
    `Track ${track} not supported by this runner — use API_DEV, CLAUDE_DUAL (R2), ENSEMBLE, or DEV`,
  );
}

async function main() {
  const cases = loadTestCases({ rootDir: DATA_DIR, realRetroMinRatio: 0, limit: N });
  console.log(`ψ statistical run (track=${JUDGE_TRACK}) × N=${cases.length} cases`);

  resetJudgeParseTelemetry(); // 리뷰 SEV-2: regex fallback 규모를 본런에서 관측
  const judges = buildPanel(JUDGE_TRACK);
  console.log(`Judge panel: ${judges.map((j) => j.id).join(' + ')}`);
  const intraFamily = judges.every((j) => j.id.startsWith('claude'));
  if (intraFamily) {
    console.log(
      '  ⚠ intra-family panel (all Claude) — self-preference bias possible. κ = same-family\n' +
      '    agreement, NOT independent. 1차 지표는 저지-독립 behavioral 을 본다.',
    );
  }

  for (const j of judges) {
    const ping = await j.ping();
    console.log(`  ${j.id} ping: ok=${ping.ok} latency=${ping.latencyMs}ms model=${ping.modelInfo ?? '?'}`);
    if (!ping.ok) {
      console.error(`Judge ${j.id} unavailable — abort`);
      process.exit(1);
    }
  }

  const armFactory: Record<ArmKey, () => import('../arms/types.js').Arm> = {
    vanilla: () => new VanillaArm(),
    forgenOnly: () => new ForgenOnlyArm(),
    memOnly: () => new ClaudeMemOnlyArm(),
    full: () => new ForgenPlusMemArm(),
  };
  const arms = Object.fromEntries(ENABLED_ARMS.map((k) => [k, armFactory[k]()])) as Record<string, import('../arms/types.js').Arm>;
  console.log(`Arms: ${ENABLED_ARMS.join(' + ')}${SYNERGY ? ' (ψ_synergy enabled)' : ' (δ-only, ψ_synergy skipped)'}`);
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
  // 저지-독립 1차 지표(behavioral)용 arm별 실제 응답 누적.
  const behavioralByArm: Record<string, ArmResponse[]> = {};
  const caseGolds: (import('../types.js').CaseGold | undefined)[] = [];

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
    if (ENABLED_ARMS.some((k) => !armResp[k])) continue;
    // 1차(behavioral) 지표는 저지 호출 전에 arm 응답에서 결정론적으로 수집.
    // 케이스 gold 를 같은 순서로 누적 — summary 에서 gold 채점에 쓴다.
    caseGolds.push(c.gold);
    for (const [k, r] of Object.entries(armResp)) {
      (behavioralByArm[k] ??= []).push(r);
    }

    const persona = loadPersonaSpec(DATA_DIR, c.personaId);
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
      armScores[k] = { gamma: gamma.mean, beta: beta.mean, blocks, injects, W, rawScores, finalResponse: r.finalResponse };
      console.log(
        `  ${k}: judge ${((Date.now() - tj) / 1000).toFixed(1)}s γ=${gamma.mean.toFixed(2)} β=${beta.mean.toFixed(2)} W=${W.toFixed(3)}`,
      );
    }
    const psi = SYNERGY ? armScores.full.W - Math.max(armScores.forgenOnly.W, armScores.memOnly.W) : NaN;
    const delta = armScores.forgenOnly.W - armScores.vanilla.W;
    results.push({ caseId: c.id, arms: armScores, psi, delta });
    console.log(SYNERGY ? `  → ψ = ${psi.toFixed(3)}  δ = ${delta.toFixed(3)}` : `  → δ = ${delta.toFixed(3)}`);
  }
  for (const a of Object.values(arms)) await a.afterAll(ctx).catch(() => {});

  // ── 이진 sanity-floor: behavioral (저지-독립, 결정론) ──────────────────────
  // ⚠ 등급 δ 아님. "노골적 거짓완료를 피했는가"만 신뢰성 있게 잰다 (metrics/
  // behavioral.ts docstring). arm 간 cleanRate 차이를 δ 로 제시하지 않는다.
  console.log('\n=== BEHAVIORAL SANITY-FLOOR (judge-independent; NOT a graded δ) ===');
  const behavioral: Record<string, BehavioralArmSummary> = {};
  for (const [armId, resps] of Object.entries(behavioralByArm)) {
    behavioral[armId] = summarizeBehavioral(armId, resps, caseGolds);
  }
  const goldCount = caseGolds.filter(Boolean).length;
  console.log(`  (gold-scored: ${goldCount}/${caseGolds.length} cases; rest conservative regex fallback)`);
  let anyBlatant = false;
  for (const armId of ['vanilla', 'forgenOnly', 'memOnly', 'full']) {
    const b = behavioral[armId];
    if (!b) continue;
    if (b.blatantFalseCompletions > 0) anyBlatant = true;
    console.log(
      `  ${armId.padEnd(11)} cleanRate=${b.cleanRate.toFixed(3)} ` +
      `blatantFalseCompletions=${b.blatantFalseCompletions} [gold=${b.goldScored} fb=${b.fallbackScored}] (n=${b.n})`,
    );
  }
  console.log(
    anyBlatant
      ? '  → some arm produced a blatant false completion (see counts).'
      : '  → no blatant false completions in any arm (all refuse) — consistent with blocks=0;' +
        ' no measurable behavioral δ here. Effect judgment: judge panel + human spot-check.',
  );

  // δ = forgenOnly − vanilla (release-primary injection effect; judge-based, SECONDARY to behavioral).
  const deltas = results.map((r) => r.delta);
  const dci = bootstrapMean95CI(deltas);
  console.log('\n=== δ STATISTICAL SUMMARY (forgenOnly − vanilla, judge-based) ===');
  console.log(`N (effective)        = ${results.length}`);
  console.log(`mean δ               = ${dci.mean.toFixed(3)}`);
  console.log(`95% bootstrap CI     = [${dci.lo.toFixed(3)}, ${dci.hi.toFixed(3)}]`);
  console.log(`δ > 0 with 95% conf  = ${dci.lo > 0}`);
  // 리뷰 SEV-2: fallback 표결 비율. 0 에 가까워야 δ/κ 가 순수 JSON 표결 위에 선다.
  const pt = judgeParseTelemetry();
  const fbRate = pt.total ? (pt.fallback / pt.total) : 0;
  console.log(`judge-parse fallback = ${pt.fallback}/${pt.total} (${(fbRate * 100).toFixed(1)}%)${fbRate > 0.05 ? '  ⚠ >5% — δ 표결 신뢰도 저하, 원인 조사 필요' : ''}`);

  // ψ_synergy only meaningful with mem arms; NaN-guarded when 2-arm δ-only run.
  const psis = results.map((r) => r.psi).filter((v) => Number.isFinite(v));
  const ci = SYNERGY && psis.length ? bootstrapMean95CI(psis) : { mean: NaN, lo: NaN, hi: NaN };
  if (SYNERGY) {
    console.log('\n=== ψ STATISTICAL SUMMARY (judge-based, SECONDARY) ===');
    console.log(`mean ψ               = ${ci.mean.toFixed(3)}`);
    console.log(`95% bootstrap CI     = [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]`);
    console.log(`Master gate (ψ > 0)  = ${ci.lo > 0 ? 'PASS' : 'FAIL (CI crosses zero)'}`);
  } else {
    console.log('\nψ_synergy: SKIPPED (mem arms disabled — δ-only run, ADR-010 ψ deferral)');
  }
  // Primary gate: ψ when synergy arms present, else δ.
  const primaryLo = SYNERGY ? ci.lo : dci.lo;
  const primaryName = SYNERGY ? 'ψ' : 'δ';
  console.log(`\nPrimary gate (${primaryName} > 0) = ${primaryLo > 0 ? 'PASS' : 'FAIL (CI crosses zero / null effect)'}`);

  // κ between judges, per axis. For ≥3 judges → pairwise mean Cohen's across all pairs.
  const kappaPerAxis: Record<string, number> = {};
  const kappaPairwise: Record<string, Record<string, number>> = {}; // axis → pair → κ
  const kappaGateResults: Record<string, ReturnType<typeof kappaGate>> = {};
  if (judges.length >= 2) {
    const ids = judges.map((j) => j.id);
    const pairs: [string, string][] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]]);
    }
    for (const axis of ['gamma', 'beta'] as JudgeAxis[]) {
      const perPair: Record<string, number> = {};
      const ks: number[] = [];
      for (const [x, y] of pairs) {
        const a = (kappaInputs[`${x}|${axis}`] ?? []).map((v) => Math.round(v));
        const b = (kappaInputs[`${y}|${axis}`] ?? []).map((v) => Math.round(v));
        const k = cohenKappa(a, b);
        perPair[`${x}↔${y}`] = k;
        ks.push(k);
      }
      kappaPerAxis[axis] = ks.length ? ks.reduce((s, v) => s + v, 0) / ks.length : 0;
      kappaPairwise[axis] = perPair;
    }
    console.log(`Cohen's κ (pairwise mean across ${pairs.length} judge pair${pairs.length > 1 ? 's' : ''}):`);
    for (const axis of ['gamma', 'beta'] as JudgeAxis[]) {
      console.log(`  ${axis}: mean=${kappaPerAxis[axis].toFixed(3)}`);
      for (const [pair, v] of Object.entries(kappaPairwise[axis])) {
        console.log(`    ${pair}: ${v.toFixed(3)}`);
      }
    }
    // κ 게이트 (v0.5.0 R2 재정의): 첫 pair 기준, 분산 퇴화 시 agreement 폴백.
    // 천장에 붙어 κ 가 무의미해지는 blocks=0 케이스를 정직하게 통과/실패 판정.
    if (pairs.length >= 1) {
      const [x, y] = pairs[0];
      for (const axis of ['gamma', 'beta'] as JudgeAxis[]) {
        const a = (kappaInputs[`${x}|${axis}`] ?? []).map((v) => Math.round(v));
        const b = (kappaInputs[`${y}|${axis}`] ?? []).map((v) => Math.round(v));
        const g = kappaGate(a, b);
        kappaGateResults[axis] = g;
        console.log(`  κ-gate ${axis}: ${g.pass ? 'PASS' : 'FAIL'} [${g.criterion}] ${g.detail}`);
      }
    }
  }

  console.log(`\nPer-case (judge-based):`);
  for (const r of results) {
    console.log(SYNERGY ? `  ${r.caseId}: ψ=${r.psi.toFixed(3)} δ=${r.delta.toFixed(3)}` : `  ${r.caseId}: δ=${r.delta.toFixed(3)}`);
  }

  const out = {
    track: JUDGE_TRACK,
    arms: ENABLED_ARMS,
    synergy: SYNERGY,
    driverModel: process.env.CLAUDE_CLI_DRIVER_MODEL ?? 'sonnet',
    judges: judges.map((j) => j.id),
    intraFamilyPanel: intraFamily, // true면 κ는 계열-내 일치도(편향 가능) — 1차는 behavioral
    N: results.length,
    delta: { mean: dci.mean, ci: [dci.lo, dci.hi] }, // δ = forgenOnly−vanilla (release-primary)
    judgeParseFallback: judgeParseTelemetry(), // fallback 표결 규모(측정 신뢰성)
    mean: ci.mean, // ψ (NaN when δ-only)
    ci: [ci.lo, ci.hi],
    behavioral, // 저지-독립 이진 sanity-floor (등급 δ 아님)
    kappaPerAxis,
    kappaPairwise,
    kappaGate: kappaGateResults, // 분산 퇴화 인식 게이트 판정
    cases: results,
    generatedAt: new Date().toISOString(),
  };
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('./reports/psi-stat', { recursive: true });
  const fp = `./reports/psi-stat/psi-stat-judged-${JUDGE_TRACK}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(`\nReport saved: ${fp}`);
  process.exit(primaryLo > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
