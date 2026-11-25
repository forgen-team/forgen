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

const LABEL: Record<string, string> = { ignored: '실렸는데 무시', notLoaded: '적혀는 있는데 안 실림', unwrittenRepeat: '적히지 않은 채 반복', deletedRepeat: '지운 뒤 다시 말함', written: '적혀 있는데도 또 말함(위 둘)', total: '반복 교정 전체' };
const REASON: Record<string, string> = { scope: '다른 폴더 전용', 'budget-or-other': 'forgen 예산 탈락 등', 'topic-only': '주제 파일에만', truncated: '잘림 뒤', 'other-folder': '다른 폴더', conditional: 'paths: 조건부', 'cwd-missing': '폴더 없음', 'replay-unknown': '지금은 보관된 룰이라 재생으로 확인 못 함' };

export function summaryLines(r: RecurrenceResult): string[] {
  const out = [`같은 말 다시 하기 (N4) ${r.window.since.slice(0, 10)} ~ ${r.window.until.slice(0, 10)} (${r.window.days}일, 앞 ${r.window.lookbackDays}일 조회 전용) · 판정자 ${r.judge.model ?? '없음'} (${r.judge.versions.correction}, ${r.judge.versions.pair})`];
  out.push(`  ${recurrenceLine(r)}`);
  if (r.statusNote) out.push(`  ${r.statusNote}`);
  if (r.status === 'model-off' || r.status === 'no-data') return out;
  const p = r.prompts;
  out.push(`  분모: 직전에 AI 응답이 있는 사용자 발화 ${p.window}개${p.limit ? ` 중 표본 ${p.sampled}` : ''} · 판정 ${p.judged}${p.unjudged ? ` · 판정 못 함 ${p.unjudged}` : ''} · 30일 환산 ${p.per30d}개`);
  out.push(`  교정 ${r.corrections.total}개 (1,000개당 ${r.corrections.per1000}, 이 작업에만 해당 ${r.corrections.taskSpecific}, 그 뒤 기억이 된 것 ${r.corrections.becameMemory}) · 조회 구간 교정 ${r.corrections.lookback}`);
  out.push('  갈래                          건수   1,000개당   30일 환산');
  for (const k of ['ignored', 'notLoaded', 'unwrittenRepeat', 'deletedRepeat', 'written', 'total'] as const) {
    out.push(`    ${LABEL[k].padEnd(24)} ${String(r.counts[k]).padStart(5)}   ${String(r.per1000[k]).padStart(8)}   ${String(r.per30d[k]).padStart(8)}`);
  }
  out.push(`  95% 구간(1,000개당): 반복 전체 ${r.ci95per1000.total[0]}~${r.ci95per1000.total[1]} · 적혀 있던 것 ${r.ci95per1000.written[0]}~${r.ci95per1000.written[1]} · 순서 바꿔 갈린 쌍 ${r.splits}(세지 않음, 검수 대상)`);
  const reasons = new Map<string, number>();
  for (const it of r.items) if (it.branch === 'not-loaded' && it.match?.reason) reasons.set(it.match.reason, (reasons.get(it.match.reason) ?? 0) + 1);
  if (reasons.size) out.push(`  안 실린 까닭: ${[...reasons].map(([k, n]) => `${REASON[k] ?? k} ${n}`).join(' · ')}`);
  const kinds = new Map<string, number>();
  for (const it of r.items) if (it.match && (it.branch === 'ignored' || it.branch === 'not-loaded')) kinds.set(it.match.kind, (kinds.get(it.match.kind) ?? 0) + 1);
  if (kinds.size) out.push(`  적혀 있던 곳: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  out.push(`  기억 ${r.memory.items}개 (${Object.entries(r.memory.byKind).map(([k, n]) => `${k} ${n}`).join(' · ')}) · 시점 모름 ${r.memory.unknownTime} · 지움 표시 ${r.memory.deleted}`);
  for (const n of r.notes) out.push(`  · ${n}`);
  return out;
}

function statsLine(run: RecurrenceRun, ms: number): string {
  const s = run.judgeStats;
  const t = run.timing;
  return `시간 ${Math.round(ms / 1000)}초 (기록 ${t.transcripts ?? 0}ms · 기억 ${t.memory ?? 0}ms · 교정 판정 ${t.correctionJudge ?? 0}ms · 쌍 판정 ${t.pairJudge ?? 0}ms) · 모델 호출 ${s?.calls ?? 0}회(실패 ${s?.failedCalls ?? 0}) · 캐시 적중 ${s?.cacheHits ?? 0}`;
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
  const ms = Date.now() - started;
  if (json) {
    console.log(JSON.stringify({ ...run.result, runId: out.runId, dir: out.dir, sourcesDigest: run.manifest.sourcesDigest, resultDigest: run.manifest.resultDigest, judgeStats: run.judgeStats, timing: run.timing }, null, 2));
    return;
  }
  for (const l of summaryLines(run.result)) console.log(l);
  console.log(`\n${statsLine(run, ms)}`);
  if (fp) console.log(`첫 감사 — 기억 지문을 남김: ${fp}`);
  console.log(`✓ [forgen] ${path.join(out.dir, 'result.json')}`);
}

interface BaselinePart { runId: string; window: RecurrenceResult['window']; status: RecurrenceResult['status']; statusNote: string; prompts: RecurrenceResult['prompts']; corrections: RecurrenceResult['corrections']; counts: RecurrenceResult['counts']; per1000: RecurrenceResult['per1000']; per30d: RecurrenceResult['per30d']; ci95per1000: RecurrenceResult['ci95per1000']; splits: number; sourcesDigest: string; resultDigest: string }

const part = (run: RecurrenceRun, runId: string): BaselinePart => {
  const r = run.result;
  return { runId, window: r.window, status: r.status, statusNote: r.statusNote, prompts: r.prompts, corrections: r.corrections, counts: r.counts, per1000: r.per1000, per30d: r.per30d, ci95per1000: r.ci95per1000, splits: r.splits, sourcesDigest: run.manifest.sourcesDigest, resultDigest: run.manifest.resultDigest };
};

/** 기준값: 배포 직전 6주(앞 30일 조회 전용) + 12주 전체(§4.2-5). --freeze 면 baseline.json 에 고정(덮어쓰기는 --force). */
export async function handleBaseline(args: string[], claudeDir: string | undefined): Promise<void> {
  const json = args.includes('--json');
  const freeze = args.includes('--freeze');
  const force = args.includes('--force');
  if (args.includes('--limit')) throw new Error('기준값은 표본(--limit) 없이 전체로 잰다 — 표본으로 보려면 forgen audit recurrence --limit');
  if (args.includes('--no-model')) throw new Error('기준값(N4)은 모델 판정이 필요하다 — --no-model 로는 잴 수 없다');
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
    judge: { model: six.manifest.judge.model, versions: six.manifest.judge.versions },
    sixWeeks: part(six, o6.runId), twelveWeeks: part(twelve, o12.runId),
  };
  const bad = [six.result, twelve.result].find((r) => r.status === 'incomplete' || r.status === 'no-data' || r.status === 'model-off');
  if (json) console.log(JSON.stringify({ ...body, frozen: false }, null, 2));
  else {
    console.log('기준값 (N4) — 배포 직전 6주 · 12주 전체\n');
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

