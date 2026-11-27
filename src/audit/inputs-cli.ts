/**
 * forgen audit inputs [--since YYYY-MM-DD|Nd] [--until YYYY-MM-DD] [--top N] [--json] [--save] [--claude-dir <경로>]
 *
 * 읽기 전용·모델 호출 없음. 기본은 stdout 만. --save 일 때만 <FORGEN_HOME>/audit/inputs/<주 또는 구간>.json 에 쓴다.
 * 기본 기간 = KST 기준 직전 완결 주(월~일).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FORGEN_HOME } from '../core/paths.js';
import { defaultEnv } from './sources.js';
import { GATE_OFF_NOTE, gateWarns, type GateCounts } from './inputs-gate.js';
import { kstDay, kstDayStartMs, mondayOf, parseKstDate, runInputs, type InputsResult, type WeekRow } from './inputs.js';

export const INPUTS_HELP = `  forgen audit inputs [--since YYYY-MM-DD|Nd] [--until YYYY-MM-DD] [--top N] [--json] [--save] [--claude-dir <경로>]
      대화 기록을 읽기만 해서 사람 발화를 주 단위(월~일, KST)로 센다 — 모델 호출 없음, 결정적 규칙(A0 §1)
      유형별(재촉·언어·완료 확인·조작 대행·결함 보고·그 외, 다중 분류) · 세션별 상위 N · 언어 누수(전체/턴 마지막)
      · 결함 보고 ÷ 완료 보고 주간 추이(M2) · 스스로 찾은 결함 [근사] · 판단할 것 라벨(M3) — 지난 주와 비교
      기본 기간: 직전 완결 주. --until 은 그날까지 포함. --save 일 때만 ~/.forgen/audit/inputs/<주>.json 에 쓴다`;

const KNOWN = new Set(['--since', '--until', '--top', '--json', '--save', '--claude-dir', '--help', '-h']);
const WITH_VALUE = new Set(['--since', '--until', '--top', '--claude-dir']);

function value(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} 뒤에 값이 필요`);
  return v;
}

/** [sinceMs, untilMs) — untilMs 는 배타 */
export function resolveRange(args: string[], now = new Date()): { sinceMs: number; untilMs: number } {
  const s = value(args, '--since');
  const u = value(args, '--until');
  const today = kstDay(now.getTime());
  const sinceDay = (x: string) => (/^\d+\s*d$/.test(x.trim()) ? today - Number.parseInt(x, 10) : parseKstDate(x));
  if (s === undefined && u === undefined) {
    const mon = mondayOf(now.getTime());
    return { sinceMs: kstDayStartMs(mon - 7), untilMs: kstDayStartMs(mon) };
  }
  const untilMs = u !== undefined ? kstDayStartMs(parseKstDate(u) + 1) : s !== undefined ? now.getTime() : 0;
  const sinceMs = s !== undefined ? kstDayStartMs(sinceDay(s)) : untilMs - 7 * 86_400_000;
  if (sinceMs >= untilMs) throw new Error('--since 가 --until 보다 앞이어야 한다');
  return { sinceMs, untilMs };
}

export function saveName(r: InputsResult): string {
  const one = r.weeks.length === 1 && r.weeks[0].days === 7;
  return one ? `${r.weeks[0].week}.json` : `${r.range.since}_${r.range.until}.json`;
}

export function saveInputs(r: InputsResult): string {
  const dir = path.join(FORGEN_HOME, 'audit', 'inputs');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, saveName(r));
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`);
  fs.renameSync(tmp, p);
  return p;
}

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 1000) / 10}%`);
const pad = (s: string | number, n: number) => String(s).padStart(n);
const delta = (a: number, b: number | undefined) => (b === undefined ? '' : a === b ? ' ±0' : ` ${a > b ? '+' : '−'}${Math.abs(a - b)}`);

function row(label: string, w: Omit<WeekRow, 'week' | 'days'>): string {
  const t = w.types;
  return `  ${label.padEnd(16)}${pad(w.human, 5)}${pad(t.nudge, 5)}${pad(t.lang, 5)}${pad(t.done, 7)}${pad(t.proxy, 5)}${pad(t.defect, 5)}${pad(t.other, 6)}${pad(w.simple, 6)}`
    + `  ${pad(pct(w.lang.all.ratio), 6)}/${pct(w.lang.final.ratio).padEnd(6)}${pad(w.m2.doneClaims, 5)}${pad(w.m2.defectPerDoneClaim ?? '—', 8)}${pad(w.selfFound.doneClaimsWithSelfFound, 6)}${pad(`${w.m3.overturned}/${w.m3.withNext}`, 7)}`;
}

export function renderInputs(r: InputsResult): string[] {
  const x = r.excluded;
  const out = [
    `forgen audit inputs — ${r.range.since} ~ ${r.range.until} (KST, 월~일 주) · 대화 기록 읽기 전용 · 모델 호출 없음`,
    `사람 발화 ${r.total.human} [실측] · 세션 ${r.total.sessions} · 읽은 파일 ${r.source.filesRead}`,
    `  뺀 것 [실측]: Handoff 폴더 사람 ${x.handoff.human}/무인 ${x.handoff.unattended} · 스크래치패드 폴더 사람 ${x.scratchpad.human}/무인 ${x.scratchpad.unattended} · 일반 폴더 무인(sdk-cli 등) ${x.mainUnattended} · 대기열 중복 ${x.queuedDuplicates}`,
    '',
    `  ${'주(월요일)'.padEnd(16)} 사람 재촉 언어 완료확인 조작 결함  그외  단순  언어누수 전체/마지막 완료 결함/완료 스스로 뒤집기`,
  ];
  const prev = r.previousWeek;
  if (prev) out.push(row(`${prev.week} 지난주`, prev));
  let before: WeekRow | null = prev;
  for (const w of r.weeks) {
    out.push(row(`${w.week}${w.days < 7 ? ` (${w.days}일)` : ''}`, w));
    if (before) out.push(`  ${''.padEnd(16)}${pad(delta(w.human, before.human), 5)}${pad(delta(w.types.nudge, before.types.nudge), 5)}${pad(delta(w.types.lang, before.types.lang), 5)}${pad(delta(w.types.done, before.types.done), 7)}${pad(delta(w.types.proxy, before.types.proxy), 5)}${pad(delta(w.types.defect, before.types.defect), 5)}${pad(delta(w.types.other, before.types.other), 6)}${pad(delta(w.simple, before.simple), 6)}   (앞 줄 대비)`);
    before = w;
  }
  if (r.weeks.length > 1) out.push(row('합계', r.total));
  const t = r.total;
  out.push('');
  out.push(`  유형 [근사, 다중 분류 — 한 발화가 여러 칸에 들 수 있음, ${t.multiLabeled}건이 둘 이상]. 단순 = 재촉·언어·완료확인·조작 중 하나라도`);
  out.push(`  언어 누수 [실측] 저한글 비율: 전체 ${t.lang.all.low}/${t.lang.all.n} · 턴 마지막 ${t.lang.final.low}/${t.lang.final.n}`);
  const a = t.m2.afterDone;
  out.push(`  M2 [근사] 주 지표 결함 보고 ÷ 완료 보고 = ${t.m2.defectReports}/${t.m2.doneClaims} = ${t.m2.defectPerDoneClaim ?? '—'} · 주간 추이 ${r.trend.defectPerDoneClaim.map((x) => `${x.week.slice(5)} ${x.value ?? '—'}`).join(' → ')}`);
  out.push(`    보조: 완료 보고 바로 다음 발화가 결함 ${a.nextDefect}/${a.doneWithNext} (${pct(a.ratio)}) · 대조(완료 아닌 턴) ${pct(a.control.ratio)}`);
  out.push(`  스스로 찾은 결함 [근사] 완료 보고 ${t.m2.doneClaims} 중 ${t.selfFound.doneClaimsWithSelfFound} (블록 ${t.selfFound.blocks})`);
  out.push(`  M3 "판단할 것" 라벨 보고 ${t.m3.labeled} [실측] (없음 ${t.m3.labeledNone} · 항목 있음 ${t.m3.labeledItem}) → 다음 발화가 뒤집거나 고침 ${t.m3.overturned}/${t.m3.withNext} (${pct(t.m3.ratio)}) [근사] · 예전 키워드 근사 ${t.m3.legacy.overturned}/${t.m3.legacy.withNext}`);
  const g = r.source.reportGate;
  const kv = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(' · ') || '없음';
  const gateLine = (label: string, c: GateCounts) => `    ${label.padEnd(16)}판정 ${c.judged} (${kv(c.byDecision)}) · judgeNone ${c.judgeNone} · 막힌 비율 ${pct(c.blockedRatio)}${c.status === 'before-first-record' ? ' · 첫 기록 전' : ''}${gateWarns(c) ? ` · ⚠ ${GATE_OFF_NOTE}` : ''}`;
  out.push('');
  out.push(`  보고 관문 [실측, 막힌 비율 = block ÷ (block + pass + cap-pass)] ${g.exists ? `첫 기록 ${g.firstRecord?.slice(0, 16).replace('T', ' ') ?? '없음'}Z` : `⚠ ${GATE_OFF_NOTE} — 기록 파일 없음`}`);
  if (g.exists) {
    if (r.previousWeek) out.push(gateLine(`${r.previousWeek.week} 지난주`, r.previousWeek.gate));
    for (const w of r.weeks) out.push(gateLine(w.week, w.gate));
    out.push(`    problems: ${kv(r.total.gate.byProblem)} · missing: ${kv(r.total.gate.byMissing)} · 기본 집계 세션의 판정 ${r.total.gate.inCountedSessions}/${r.total.gate.judged}`);
  }
  if (r.sessions.top.length) {
    out.push('');
    out.push(`  세션 상위 ${Math.min(5, r.sessions.top.length)} (사람 발화 점유 상위1 ${pct(r.sessions.share.top1)} · 상위3 ${pct(r.sessions.share.top3)}) — 재촉/언어/완료확인/조작/결함/그외 · 단순 · 압축`);
    for (const s of r.sessions.top.slice(0, 5)) {
      const y = s.types;
      out.push(`    ${s.session} ${s.folder.padEnd(34)} ${s.first}~${s.last} ${pad(s.human, 4)}  ${y.nudge}/${y.lang}/${y.done}/${y.proxy}/${y.defect}/${y.other} · ${s.simple} · ${s.compactions}`);
    }
  }
  out.push('');
  out.push('  정의·한계: --json 의 notes · 숫자별 라벨: fieldLabels');
  return out;
}

export async function handleInputs(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(INPUTS_HELP); return; }
  try {
    const bad = args.filter((a, i) => a.startsWith('-') && !KNOWN.has(a) && !(i > 0 && WITH_VALUE.has(args[i - 1])));
    if (bad.length) throw new Error(`알 수 없는 옵션: ${bad.join(' ')}\n${INPUTS_HELP}`);
    const { sinceMs, untilMs } = resolveRange(args);
    const topArg = value(args, '--top');
    const top = topArg === undefined ? 15 : Number.parseInt(topArg, 10);
    if (!Number.isFinite(top) || top < 0) throw new Error(`--top 은 0 이상의 수: ${topArg}`);
    const r = await runInputs({ claudeDir: defaultEnv(value(args, '--claude-dir')).claudeDir, sinceMs, untilMs, top });
    const saved = args.includes('--save') ? saveInputs(r) : null;
    if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else for (const l of renderInputs(r)) console.log(l);
    if (saved) process.stderr.write(`✓ [forgen] 저장: ${saved}\n`);
  } catch (e) {
    console.error(`[forgen] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

