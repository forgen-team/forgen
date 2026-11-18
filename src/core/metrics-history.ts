/**
 * 일별 지표 보관 — `state/metrics/daily/YYYY-MM-DD.json` (`forgen-daily/v1`). 설계: docs/plans/2026-11-18-forgen-own-metrics.md §2.
 *
 * 왜: 일별 숫자의 원천 일부가 오래 남지 않는다(violations.jsonl 10MB 회전 + 회전본 3개·60일, checks 7일).
 * 닫힌 날(UTC)의 숫자를 고정해 두면 원천이 지워져도 남고, 재계산으로 흔들리지 않는다.
 *
 * - 닫힌 날만 쓴다(오늘은 늘 원천 계산). 빠진 날을 한 번의 computeRuleHealth 로 같이 계산한다 — 그 기간 끝(어제 끝) 기준이라
 *   그 뒤 날짜 파일에 늦게 기록된 lifecycle 이벤트도 ts 로 제 날짜에 들어간다(파일 이름 하한만 거르므로).
 * - 룰별 누적 카운터는 과거 시점 값을 알 수 없어 쓰는 순간 값(asOf)을 가장 최근 날 파일에만 넣는다.
 * - 보관 400일. 정의 번호(DEFINITION)가 다른 저장값은 원천으로 다시 계산할 수 있을 때 무시한다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR, ME_RULES, ME_RULES_ARCHIVE } from './paths.js';
import { withFileLockSync } from '../hooks/shared/file-lock.js';
import { atomicWriteJSON, safeReadJSON } from '../hooks/shared/atomic-write.js';
import { blocksByDay, computeRuleHealth, readRealBlocks, sortedCounts, type RuleHealth, type RuleHealthDay } from './rule-health.js';
import { readRuleFiles } from './rule-list-json.js';

export const DAILY_SCHEMA = 'forgen-daily/v1';
export const HISTORY_SCHEMA = 'forgen-rule-history/v1';
export const RETENTION_DAYS = 400;
export const MAX_QUERY_DAYS = 365;
/** rule-health 일별 정의 번호. 정의를 바꾸면 올린다(0.6.13 기준 = 1). */
export const DEFINITION = 1;
/** 이 기간 안의 날은 원천(violations 회전본 60일 등)이 온전하다고 보고 'closed', 그보다 오래된 날을 처음 쓰면 'backfill'. */
const CLOSED_WITHIN_DAYS = 7;
const DAY = 86_400_000;

export type DayTotals = Omit<RuleHealthDay, 'day' | 'source'>;
export interface DailyFile {
  schema: typeof DAILY_SCHEMA;
  day: string;
  definition: number;
  writtenAt: string;
  forgenVersion: string | null;
  source: 'closed' | 'backfill';
  totals: DayTotals;
  /** 0.7.2: 그날 룰별 차단 수(차단 0 인 룰은 없음). 0.7.1 파일엔 없다 — 그 날은 원천으로 센다. */
  blocksByRule?: Record<string, number>;
  rules: { asOf: string; columns: string[]; rows: Array<Array<string | number | null>> } | null;
}

export function dailyDir(): string { return path.join(STATE_DIR, 'metrics', 'daily'); }
const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10);
const endOfDay = (day: string): number => Date.parse(`${day}T23:59:59.999Z`);

export function readDaily(day: string): DailyFile | null {
  const f = safeReadJSON<DailyFile | null>(path.join(dailyDir(), `${day}.json`), null);
  return f && f.schema === DAILY_SCHEMA && f.day === day ? f : null;
}

export function listDailyDays(): string[] {
  try { return fs.readdirSync(dailyDir()).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort(); } catch { return []; }
}

function forgenVersion(): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version?: string };
    return pkg.version ?? null;
  } catch { return null; }
}

export const SNAPSHOT_COLUMNS = ['id', 'status', 'phase', 'inject', 'violation', 'bypass'];

function ruleSnapshotRows(): Array<Array<string | number | null>> {
  return readRuleFiles(ME_RULES).map((r) => [
    r.rule_id, r.status, r.lifecycle?.phase ?? null,
    r.lifecycle?.inject_count ?? 0, r.lifecycle?.violation_count ?? 0, r.lifecycle?.bypass_count ?? 0,
  ]);
}

function totalsOf(d: RuleHealthDay): DayTotals {
  const { day: _d, source: _s, ...rest } = d;
  return rest;
}

export interface RecordResult { written: string[]; pruned: number; skipped?: 'locked' | 'up-to-date' }

/**
 * 어제까지 빠진 닫힌 날을 채운다(최대 `limit` 일 전까지). 세션 시작은 limit 7, CLI 는 365.
 * 이미 어제 파일이 있고 정의가 같으면 아무것도 하지 않는다(파일 하나 stat — 세션 시작 비용 최소).
 */
export function recordClosedDays(opts: { limit?: number; now?: number } = {}): RecordResult {
  const now = opts.now ?? Date.now();
  const limit = Math.max(1, Math.min(MAX_QUERY_DAYS, opts.limit ?? 7));
  const yesterday = utcDay(now - DAY);
  const existingY = readDaily(yesterday);
  if (existingY && existingY.definition === DEFINITION && limit <= CLOSED_WITHIN_DAYS) return { written: [], pruned: 0, skipped: 'up-to-date' };
  fs.mkdirSync(dailyDir(), { recursive: true });
  try {
    return withFileLockSync(path.join(dailyDir(), '.write'), () => {
      const missing: string[] = [];
      // forgen 을 쓰기 전 날짜는 채우지 않는다 — 가장 오래된 개인 룰 생성일이 하한(0 으로 채운 365일이 '기록'처럼 보이지 않게).
      const born = [...readRuleFiles(ME_RULES), ...readRuleFiles(ME_RULES_ARCHIVE)]
        .map((r) => Date.parse(r.created_at)).filter((t) => Number.isFinite(t));
      const floor = born.length ? utcDay(Math.min(...born)) : utcDay(now - DAY);
      for (let i = limit; i >= 1; i--) {
        const d = utcDay(now - i * DAY);
        if (d < floor) continue;
        const f = readDaily(d);
        if (!f || f.definition !== DEFINITION) missing.push(d);
      }
      const written: string[] = [];
      if (missing.length > 0) {
        const span = Math.round((endOfDay(yesterday) - endOfDay(missing[0])) / DAY) + 1;
        const h = computeRuleHealth({ days: span, now: endOfDay(yesterday) });
        const byDay = new Map(h.days.map((d) => [d.day, d]));
        const blockDays = blocksByDay(readRealBlocks(span, endOfDay(yesterday)), endOfDay(yesterday) - span * DAY);
        const writtenAt = new Date(now).toISOString();
        const version = forgenVersion();
        for (const d of missing) {
          const day = byDay.get(d);
          if (!day) continue;
          const prev = readDaily(d);
          const file: DailyFile = {
            schema: DAILY_SCHEMA, day: d, definition: DEFINITION, writtenAt, forgenVersion: version,
            source: now - endOfDay(d) <= CLOSED_WITHIN_DAYS * DAY ? 'closed' : 'backfill',
            totals: totalsOf(day),
            blocksByRule: Object.fromEntries(blockDays.get(d) ?? new Map()),
            // 룰 스냅샷은 가장 최근 날에만(쓰는 순간 값). 다시 쓰는 경우 예전 스냅샷은 보존.
            rules: d === yesterday ? { asOf: writtenAt, columns: SNAPSHOT_COLUMNS, rows: ruleSnapshotRows() } : prev?.rules ?? null,
          };
          atomicWriteJSON(path.join(dailyDir(), `${d}.json`), file);
          written.push(d);
        }
      }
      return { written, pruned: pruneDaily(now) };
    }, { timeoutMs: 200, staleMs: 120_000 });
  } catch {
    return { written: [], pruned: 0, skipped: 'locked' };
  }
}

export function pruneDaily(now: number = Date.now()): number {
  const cutoff = utcDay(now - RETENTION_DAYS * DAY);
  let n = 0;
  for (const d of listDailyDays()) {
    if (d >= cutoff) continue;
    try { fs.unlinkSync(path.join(dailyDir(), `${d}.json`)); n++; } catch { /* 다음에 */ }
  }
  return n;
}

export interface HealthWithHistory extends RuleHealth {
  history: { retentionDays: number; oldestDay: string | null; definition: number };
}

/**
 * `--health` 의 일별 표에 보관값을 합친다. 오늘은 원천 계산(live), 닫힌 날은 정의가 같은 보관 파일이 있으면 그 값.
 * flow·top·rules 는 원천 기준 그대로(정의 변경 없음).
 */
export function healthWithHistory(opts: { days?: number; now?: number; record?: boolean } = {}): HealthWithHistory {
  const now = opts.now ?? Date.now();
  const days = Math.max(1, Math.min(MAX_QUERY_DAYS, opts.days ?? 14));
  if (opts.record !== false) recordClosedDays({ limit: MAX_QUERY_DAYS, now });
  let rawBlocks: Array<Record<string, unknown>> = [];
  const h = computeRuleHealth({ days, now, onBlocks: (b) => { rawBlocks = b; } });
  const today = utcDay(now);
  h.days = h.days.map((d) => {
    if (d.day === today) return { ...d, source: 'live' as const };
    const f = readDaily(d.day);
    if (f && f.definition === DEFINITION) return { day: d.day, ...f.totals, source: f.source };
    return { ...d, source: 'live' as const };
  });
  // 룰별 차단 수: 닫힌 날은 보관값(0.7.2 이후 파일), 없으면 원천, 오늘은 원천.
  const raw = blocksByDay(rawBlocks, now - days * DAY);
  const merged = new Map<string, Map<string, number>>();
  for (const d of h.days) {
    const f = d.day === today ? null : readDaily(d.day);
    if (f?.blocksByRule && f.definition === DEFINITION) merged.set(d.day, new Map(Object.entries(f.blocksByRule)));
    else if (raw.has(d.day)) merged.set(d.day, raw.get(d.day) as Map<string, number>);
  }
  h.top = { ...h.top, blockingAll: sortedCounts(merged) };
  const all = listDailyDays();
  return { ...h, history: { retentionDays: RETENTION_DAYS, oldestDay: all[0] ?? null, definition: DEFINITION } };
}

export interface RuleHistory {
  schema: typeof HISTORY_SCHEMA;
  generatedAt: string;
  columns: string[];
  days: Array<{ day: string; asOf: string; rows: Array<Array<string | number | null>> }>;
}

/** `forgen status --history --json [--days N] [--rule <id>]` — 룰별 하루 스냅숏. */
export function buildRuleHistory(opts: { days?: number; rule?: string; now?: number } = {}): RuleHistory {
  const now = opts.now ?? Date.now();
  const days = Math.max(1, Math.min(MAX_QUERY_DAYS, opts.days ?? 30));
  const from = utcDay(now - days * DAY);
  const out: RuleHistory['days'] = [];
  for (const d of listDailyDays()) {
    if (d < from) continue;
    const f = readDaily(d);
    if (!f?.rules) continue;
    const rows = opts.rule ? f.rules.rows.filter((r) => typeof r[0] === 'string' && (r[0] as string).startsWith(opts.rule as string)) : f.rules.rows;
    out.push({ day: d, asOf: f.rules.asOf, rows });
  }
  return { schema: HISTORY_SCHEMA, generatedAt: new Date(now).toISOString(), columns: SNAPSHOT_COLUMNS, days: out };
}
