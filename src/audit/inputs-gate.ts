/**
 * forgen audit inputs — B1 보고 관문(Claude Code Stop 훅) 판정 기록 집계. **읽기만 한다.**
 *
 * 원천: <claude-dir>/hooks/state/report-gate.jsonl — 판정마다 한 줄
 *   { at, session, cwd, problems[], missing[], judgeNone, decision: block|pass|cap-pass, n } (보고 본문은 없음)
 * 꺼짐 의심(north-star §3 공통 조건 4 "꺼지면 사람에게 보인다"):
 *   파일이 없으면 no-file. 첫 기록 이후 구간에 완료 보고가 있는데 판정이 0 이면 maybe-off.
 *   구간이 첫 기록보다 앞이면 before-first-record(관문을 켜기 전이라 경고하지 않음).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GateEntry { ms: number; session: string; decision: string; problems: string[]; missing: string[]; judgeNone: boolean }
export interface GateLog { path: string; exists: boolean; entries: GateEntry[]; firstMs: number | null; unreadableLines: number }

export type GateStatus = 'no-file' | 'before-first-record' | 'ok' | 'maybe-off';
export interface GateCounts {
  status: GateStatus;
  judged: number;
  byDecision: Record<string, number>;
  byProblem: Record<string, number>;
  byMissing: Record<string, number>;
  judgeNone: number;
  /** 판정 중 기본 집계에 든 세션(일반 폴더·사람 발화 있음)의 것 */
  inCountedSessions: number;
  /** 막힌 비율 = block ÷ (block + pass + cap-pass). 관문은 완료 보고로 판정한 때에만 기록한다 */
  blockedRatio: number | null;
}

export const GATE_OFF_NOTE = '보고 관문이 꺼졌을 수 있음';

export function gatePath(claudeDir: string): string { return path.join(claudeDir, 'hooks', 'state', 'report-gate.jsonl'); }

const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);

export function readGate(claudeDir: string): GateLog {
  const p = gatePath(claudeDir);
  const log: GateLog = { path: p, exists: false, entries: [], firstMs: null, unreadableLines: 0 };
  let raw: string;
  try { raw = fs.readFileSync(p, 'utf8'); log.exists = true; } catch { return log; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as Record<string, unknown>;
      const ms = typeof d.at === 'string' ? Date.parse(d.at) : Number.NaN;
      if (Number.isNaN(ms)) { log.unreadableLines++; continue; }
      log.entries.push({ ms, session: typeof d.session === 'string' ? d.session : '', decision: typeof d.decision === 'string' ? d.decision : 'unknown', problems: strs(d.problems), missing: strs(d.missing), judgeNone: d.judgeNone === true });
    } catch { log.unreadableLines++; }
  }
  log.entries.sort((a, b) => a.ms - b.ms);
  log.firstMs = log.entries[0]?.ms ?? null;
  return log;
}

function blockedRatio(E: GateEntry[]): number | null {
  const block = E.filter((e) => e.decision === 'block').length;
  const all = E.filter((e) => e.decision === 'block' || e.decision === 'pass' || e.decision === 'cap-pass').length;
  return all ? Math.round((block / all) * 1000) / 1000 : null;
}

function tally(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys.sort()) out[k] = (out[k] ?? 0) + 1;
  return out;
}

/** 구간 [fromMs, toMs) 의 관문 판정을 센다. doneClaimMs = 그 구간 완료 보고 시각들(꺼짐 의심 판정에만 씀). */
export function countGate(g: GateLog, fromMs: number, toMs: number, doneClaimMs: number[], countedSessions: ReadonlySet<string>): GateCounts {
  const E = g.entries.filter((e) => e.ms >= fromMs && e.ms < toMs);
  const sinceOn = g.firstMs === null ? [] : doneClaimMs.filter((ms) => ms >= (g.firstMs as number) && ms >= fromMs && ms < toMs);
  let status: GateStatus;
  if (!g.exists) status = 'no-file';
  else if (g.firstMs === null || toMs <= g.firstMs) status = g.firstMs === null && doneClaimMs.length ? 'maybe-off' : 'before-first-record';
  else status = sinceOn.length > 0 && E.length === 0 ? 'maybe-off' : 'ok';
  return {
    status,
    judged: E.length,
    byDecision: tally(E.map((e) => e.decision)),
    byProblem: tally(E.flatMap((e) => e.problems)),
    byMissing: tally(E.flatMap((e) => e.missing)),
    judgeNone: E.filter((e) => e.judgeNone).length,
    inCountedSessions: E.filter((e) => countedSessions.has(e.session)).length,
    blockedRatio: blockedRatio(E),
  };
}

export function gateWarns(c: GateCounts): boolean { return c.status === 'no-file' || c.status === 'maybe-off'; }
