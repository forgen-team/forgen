/**
 * forgen audit recurrence · forgen audit baseline (docs/plans/2026-11-25-v1.0-plan.md §2.1·§4.2·§9 0.9.0).
 *   forgen audit recurrence [--since <날짜>] [--until <날짜>] [--lookback 30d] [--limit N] [--no-model] [--json] [--claude-dir <경로>]
 *   forgen audit baseline [--freeze [--force]] [--until <날짜>] [--json] [--claude-dir <경로>]
 * 원천은 읽기만 한다. 쓰는 곳: <FORGEN_HOME>/audit/{recurrence/<회차>/, cache/, baseline.json, fingerprint-<날짜>.json, model-notice.json}.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FORGEN_HOME } from '../core/paths.js';
import { writeFingerprintIfFirst } from './fingerprint.js';
import { takeModelDisclosure } from './judge.js';
import { resolvePendingCorrections } from '../core/correction-ledger-judge.js';
import { maskQuote } from './quote.js';
import { recurrenceLine, runRecurrence, writeRecurrenceRun, type RecurrenceResult, type RecurrenceRun } from './recurrence.js';

const DAY = 86_400_000;
export const BASELINE_SCHEMA = 'forgen-audit-baseline/1' as const;
export const BASELINE_PATH = () => path.join(FORGEN_HOME, 'audit', 'baseline.json');

export function parseDate(s: string | undefined, name: string): Date | undefined {
  if (s === undefined) return undefined;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`${name} 날짜를 읽지 못함: ${s} (YYYY-MM-DD 또는 ISO)`);
  return d;
}

export function parseDays(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const m = /^(\d+)\s*d?$/.exec(s.trim());
  if (!m) throw new Error(`--lookback 은 30d 처럼 날 수: ${s}`);
  return Number(m[1]);
}

function value(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
}

const LABEL: Record<string, string> = { ignored: '세션에 실렸는데도 또 말함', notLoaded: '적혀 있지만 그 세션에 안 실려 또 말함', unwrittenRepeat: '어디에도 안 적혀 또 말함', deletedRepeat: '지운 기억을 다시 말함', written: '이미 적혀 있던 것(위 둘)', total: '같은 말 다시 하기 전체' };
const REASON: Record<string, string> = { scope: '다른 폴더 전용으로 적혀 있음', 'budget-or-other': 'forgen 룰 자리가 모자라 빠짐 등', 'topic-only': '메모 파일 본문에만 있음(세션 시작에 안 실림)', truncated: 'MEMORY.md 상한(200줄·25KB) 뒤에 있음', 'other-folder': '다른 폴더 기억에 있음', conditional: '특정 파일을 다룰 때만 실리는 룰(paths:)', 'cwd-missing': '그 폴더가 지금 없음', 'replay-unknown': '지금은 보관된 룰이라 확인 못 함', 'tier2-missed': '상황 맞춤 룰인데 그때 안 들어옴' };
const KIND: Record<string, string> = { 'forgen-rule': 'forgen 룰', 'memory-topic': '메모 파일', 'memory-index': 'MEMORY.md', 'host-md': 'CLAUDE.md 등 지침 파일' };
const pctOf = (per1000: number) => `${Math.round(per1000) / 10}%`;

export function summaryLines(r: RecurrenceResult): string[] {
  const out = [`같은 말 다시 하기 — ${r.window.since.slice(0, 10)} ~ ${r.window.until.slice(0, 10)} (${r.window.days}일, 그 앞 ${r.window.lookbackDays}일은 "전에 한 말"을 찾는 데만 씀) · 판정: 내 컴퓨터의 claude CLI${r.judge ? '(교정 찾기 Haiku · 같은 말인지 Sonnet)' : ''}`];
  out.push(`  ${recurrenceLine(r)}`);
  if (r.statusNote) out.push(`  ${r.statusNote}`);
  if (r.status === 'model-off' || r.status === 'no-data') return out;
  const p = r.prompts;
  out.push(`  센 요청: AI 답 바로 뒤에 내가 한 말 ${p.window}개${p.limit ? ` 중 ${p.sampled}개를 뽑음` : ''} · 판정 ${p.judged}${p.unjudged ? ` · 판정 못 함 ${p.unjudged}` : ''}`);
  out.push(`  교정 ${r.corrections.total}개 (그 작업에만 해당 ${r.corrections.taskSpecific} · 그 뒤 기억으로 남은 것 ${r.corrections.becameMemory})`);
  out.push('  종류                                   번   요청 중 비율   30일로 치면');
  for (const k of ['ignored', 'notLoaded', 'unwrittenRepeat', 'deletedRepeat', 'written', 'total'] as const) {
    out.push(`    ${LABEL[k].padEnd(30)} ${String(r.counts[k]).padStart(4)}   ${pctOf(r.per1000[k]).padStart(8)}   ${String(r.per30d[k]).padStart(8)}`);
  }
  out.push(`  오차 범위(95%): 같은 말 다시 하기 전체 ${pctOf(r.ci95per1000.total[0])}~${pctOf(r.ci95per1000.total[1])} · 이미 적혀 있던 것 ${pctOf(r.ci95per1000.written[0])}~${pctOf(r.ci95per1000.written[1])}`);
  const reasons = new Map<string, number>();
  for (const it of r.items) if (it.branch === 'not-loaded' && it.match?.reason) reasons.set(it.match.reason, (reasons.get(it.match.reason) ?? 0) + 1);
  if (reasons.size) out.push(`  적혀 있는데 안 실린 까닭: ${[...reasons].map(([k, n]) => `${REASON[k] ?? k} ${n}`).join(' · ')}`);
  const kinds = new Map<string, number>();
  for (const it of r.items) if (it.match && (it.branch === 'ignored' || it.branch === 'not-loaded')) kinds.set(it.match.kind, (kinds.get(it.match.kind) ?? 0) + 1);
  if (kinds.size) out.push(`  적혀 있던 곳: ${[...kinds].map(([k, n]) => `${KIND[k] ?? k} ${n}`).join(' · ')}`);
  for (const it of r.items.filter((x) => x.branch === 'ignored' || x.branch === 'not-loaded').slice(0, 3)) {
    out.push(`    예: ${it.ts.slice(0, 10)} "${maskQuote(it.utterance || it.gist, 80)}" — ${it.match ? `${KIND[it.match.kind] ?? it.match.kind}에 "${maskQuote(it.match.text, 50)}"` : ''}`);
  }
  out.push(`  비교한 기억 ${r.memory.items}개 (${Object.entries(r.memory.byKind).map(([k, n]) => `${KIND[k] ?? k} ${n}`).join(' · ')}) · 지운 기억 ${r.memory.deleted}개`);
  if (r.biweekly?.length) {
    out.push('  2주씩: 기간 · 센 요청 · 교정 · 같은 말 다시 하기(요청 중 비율) · 그중 상황 맞춤 룰이 안 들어와서');
    for (const b of r.biweekly) out.push(`    ${b.from.slice(0, 10)}~${b.to.slice(0, 10)}  ${String(b.prompts).padStart(5)}  ${String(b.corrections).padStart(4)}  ${String(b.total).padStart(4)} (${pctOf(b.per1000)})  ${b.tier2Missed}`);
  }
  for (const n of r.notes) out.push(`  · ${n}`);
  return out;
}

function statsLine(run: RecurrenceRun, ms: number): string {
  const s = run.judgeStats;
  return `${Math.round(ms / 1000)}초 · 모델 호출 ${s?.calls ?? 0}번 (실패 ${s?.failedCalls ?? 0}, 저장된 판정 ${s?.cacheHits ?? 0}개 재사용)`;
}

function disclose(json: boolean): void {
  const d = takeModelDisclosure();
  if (!d) return;
  if (json) process.stderr.write(`${d}\n\n`);
  else console.log(`${d}\n`);
}

export async function handleRecurrence(args: string[], claudeDir: string | undefined): Promise<void> {
  const json = args.includes('--json');
  const model = !args.includes('--no-model');
  const limitRaw = value(args, '--limit');
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error(`--limit 은 양의 정수: ${limitRaw}`);
  if (model) disclose(json);
  const started = Date.now();
  const run = await runRecurrence({ claudeDir, since: parseDate(value(args, '--since'), '--since'), until: parseDate(value(args, '--until'), '--until'), lookbackDays: parseDays(value(args, '--lookback')), limit, model });
  const out = writeRecurrenceRun(run);
  const fp = writeFingerprintIfFirst(run.memoryFiles, new Date(), run.result.forgenVersion);
  // 0.9.0 두 층: 재발·2층 미발동 이력을 두 층 색인에 합친다 — 2층 미발동 룰은 다음 세션부터 1층(자동 복귀)
  let tier2: { updated: number; tier2Missed: string[] } | null = null;
  try { tier2 = (await import('./tier2-replay.js')).mergeRecurrence(run.result.items); } catch (e) {
    // 재생 결과는 막지 않되 조용히 넘기지 않는다 — 실패하면 2층 미발동 룰이 1층으로 돌아오지 못한다.
    process.stderr.write(`[forgen] ⚠ 두 층 색인 갱신 실패 — 2층에서 놓친 룰이 1층으로 돌아오지 않았습니다: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  const ms = Date.now() - started;
  // 교정 원장의 판정 대기도 같은 판정기로 푼다 — 세션 학습(Haiku 동의)이 꺼진 사용자도 여기서 풀린다.
  let ledger: Awaited<ReturnType<typeof resolvePendingCorrections>> | null = null;
  if (model) {
    try { ledger = await resolvePendingCorrections({ max: 500 }); } catch (e) {
      process.stderr.write(`[forgen] ⚠ 교정 원장 판정 대기를 풀지 못했습니다: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  if (json) {
    console.log(JSON.stringify({ ...run.result, runId: out.runId, dir: out.dir, sourcesDigest: run.manifest.sourcesDigest, resultDigest: run.manifest.resultDigest, judgeStats: run.judgeStats, timing: run.timing, ledger, tier2 }, null, 2));
    return;
  }
  for (const l of summaryLines(run.result)) console.log(l);
  if (tier2?.tier2Missed.length) console.log(`  상황 맞춤 룰 ${tier2.tier2Missed.length}개가 필요한 순간에 안 들어와, 다음 세션부터 세션마다 실리게 바꿈`);
  console.log(`\n${statsLine(run, ms)}`);
  if (ledger && (ledger.resolved || ledger.left)) console.log(`아직 판정 안 된 교정 기록 ${ledger.resolved}개를 판정함${ledger.left ? ` · 남은 것 ${ledger.left}${ledger.stopped ? ` (${ledger.stopped})` : ''}` : ''}`);
  if (run.result.pairsJudged) console.log('모델 판정이 맞는지 직접 확인: forgen audit review (25개를 내 컴퓨터에서만 여는 페이지로)');
  if (fp) console.log(`처음 재서 지금 기억 상태를 적어 둠: ${fp}`);
  console.log(`✓ [forgen] 결과: ${path.join(out.dir, 'result.json')}`);
}

interface BaselinePart { runId: string; window: RecurrenceResult['window']; status: RecurrenceResult['status']; statusNote: string; prompts: RecurrenceResult['prompts']; corrections: RecurrenceResult['corrections']; counts: RecurrenceResult['counts']; per1000: RecurrenceResult['per1000']; per30d: RecurrenceResult['per30d']; ci95per1000: RecurrenceResult['ci95per1000']; unknown: number; memory: RecurrenceResult['memory']; sourcesDigest: string; resultDigest: string }

const part = (run: RecurrenceRun, runId: string): BaselinePart => {
  const r = run.result;
  return { runId, window: r.window, status: r.status, statusNote: r.statusNote, prompts: r.prompts, corrections: r.corrections, counts: r.counts, per1000: r.per1000, per30d: r.per30d, ci95per1000: r.ci95per1000, unknown: r.unknown, memory: r.memory, sourcesDigest: run.manifest.sourcesDigest, resultDigest: run.manifest.resultDigest };
};

/** 기준값: 배포 직전 6주(앞 30일 조회 전용) + 12주 전체(§4.2-5). --freeze 면 baseline.json 에 고정(덮어쓰기는 --force). */
export async function handleBaseline(args: string[], claudeDir: string | undefined): Promise<void> {
  const json = args.includes('--json');
  const freeze = args.includes('--freeze');
  const force = args.includes('--force');
  if (args.includes('--limit')) throw new Error('기준값은 표본(--limit) 없이 전체로 잰다 — 표본으로 보려면 forgen audit recurrence --limit');
  if (args.includes('--no-model')) throw new Error('기준값은 모델 판정이 필요하다 — --no-model 로는 잴 수 없다');
  const bp = BASELINE_PATH();
  if (freeze && fs.existsSync(bp) && !force) {
    throw new Error(`기준값이 이미 고정돼 있다: ${bp} — 다시 고정하려면 --freeze --force (이전 값은 baseline-<시각>.json 으로 남긴다)`);
  }
  disclose(json);
  const until = parseDate(value(args, '--until'), '--until') ?? new Date();
  const started = Date.now();
  const six = await runRecurrence({ claudeDir, since: new Date(until.getTime() - 42 * DAY), until, lookbackDays: 30, now: until });
  const twelve = await runRecurrence({ claudeDir, since: new Date(until.getTime() - 84 * DAY), until, lookbackDays: 30, now: until });
  const o6 = writeRecurrenceRun(six);
  const o12 = writeRecurrenceRun(twelve);
  writeFingerprintIfFirst([...new Set([...six.memoryFiles, ...twelve.memoryFiles])], new Date(), six.result.forgenVersion);
  const body = {
    schema: BASELINE_SCHEMA, frozenAt: new Date().toISOString(), forgenVersion: six.result.forgenVersion, claudeDir: six.result.claudeDir,
    judge: six.manifest.judge,
    sixWeeks: part(six, o6.runId), twelveWeeks: part(twelve, o12.runId),
  };
  const bad = [six.result, twelve.result].find((r) => r.status === 'incomplete' || r.status === 'no-data' || r.status === 'model-off');
  if (json) console.log(JSON.stringify({ ...body, frozen: false }, null, 2));
  else {
    console.log('같은 말 다시 하기 기준값 — 배포 직전 6주 · 12주 전체\n');
    for (const l of summaryLines(six.result)) console.log(l);
    console.log('');
    for (const l of summaryLines(twelve.result)) console.log(l);
    console.log(`\n시간 ${Math.round((Date.now() - started) / 1000)}초 · 모델 호출 ${(six.judgeStats?.calls ?? 0) + (twelve.judgeStats?.calls ?? 0)}회 · 캐시 적중 ${(six.judgeStats?.cacheHits ?? 0) + (twelve.judgeStats?.cacheHits ?? 0)}`);
  }
  if (!freeze) { if (!json) console.log('고정하지 않았다 — 이 값으로 고정하려면 forgen audit baseline --freeze'); return; }
  if (bad) throw new Error(`고정하지 않음: ${bad.statusNote}`);
  fs.mkdirSync(path.dirname(bp), { recursive: true, mode: 0o700 });
  if (fs.existsSync(bp)) fs.renameSync(bp, bp.replace(/\.json$/, `-${Date.now()}.json`));
  fs.writeFileSync(bp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  if (!json) console.log(`✓ [forgen] 기준값 고정: ${bp}`);
}

