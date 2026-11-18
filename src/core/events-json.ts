/**
 * `forgen status --events --json [--since <ISO>] [--until <ISO>]` — 세션별 사건 (`forgen-events/v1`).
 * 설계: docs/plans/2026-11-18-forgen-own-metrics.md §7-1. 숫자 정의는 `--health` 와 같다. 문구는 넣지 않는다.
 * 읽기 전용(sessions.db 도 readOnly 로 연다).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { FORGEN_HOME, ME_BEHAVIOR, STATE_DIR } from './paths.js';
import { isConfirmedBypass, isRealBlock, readJsonlWindow } from '../engine/lifecycle/signals.js';

const require = createRequire(import.meta.url);

export const EVENTS_SCHEMA = 'forgen-events/v1';
export const EVENTS_MAX_DAYS = 400;
const DAY = 86_400_000;

export type EventKind =
  | 'block' | 'bypass' | 'false_positive' | 'correction_user' | 'correction_mined'
  | 'solution_matched' | 'solution_surfaced' | 'solution_acted_on';

export interface ForgenEvent { at: string; sessionId: string | null; kind: EventKind; ruleId: string | null }
export interface ForgenEventSession { id: string; cwd: string; startedAt: string }
export interface ForgenEvents {
  schema: typeof EVENTS_SCHEMA;
  generatedAt: string;
  since: string;
  until: string;
  sources: { enforcement: boolean; evidence: boolean; sessionsDb: boolean };
  events: ForgenEvent[];
  sessions: ForgenEventSession[];
}

interface Db { prepare(sql: string): { all(...a: unknown[]): unknown[] }; close(): void }

let warningFiltered = false;
/** node:sqlite 의 ExperimentalWarning 이 stderr 로 나가지 않게(session-store 와 같은 방식). stdout·stderr 를 합쳐 읽는 소비자의 JSON 파싱을 깨지 않도록. */
function filterSqliteWarning(): void {
  if (warningFiltered) return;
  warningFiltered = true;
  const original = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w.name === 'ExperimentalWarning') return;
    for (const l of original) (l as (x: Error) => void)(w);
  });
}

function openSessionsDb(): Db | null {
  const file = path.join(FORGEN_HOME, 'sessions.db');
  if (!fs.existsSync(file)) return null;
  filterSqliteWarning();
  try {
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string, o?: Record<string, unknown>) => Db };
    return new DatabaseSync(file, { readOnly: true });
  } catch { return null; }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function buildEvents(opts: { since?: number; until?: number; now?: number } = {}): ForgenEvents {
  const now = opts.now ?? Date.now();
  const until = Math.min(opts.until ?? now, now);
  const since = Math.max(opts.since ?? until - 30 * DAY, until - EVENTS_MAX_DAYS * DAY);
  const inWindow = (t: number) => Number.isFinite(t) && t >= since && t <= until;
  const days = Math.ceil((now - since) / DAY) + 1;
  const events: ForgenEvent[] = [];
  const sources = { enforcement: false, evidence: false, sessionsDb: false };

  // ── 차단·우회 (violations.jsonl) ──
  const enf = path.join(STATE_DIR, 'enforcement');
  sources.enforcement = fs.existsSync(enf);
  const violations = readJsonlWindow<Record<string, unknown>>(path.join(enf, 'violations.jsonl'), days, now);
  const sessionOfViolation = new Map<string, string | null>();
  for (const v of violations) {
    const id = str(v.violation_id);
    if (id) sessionOfViolation.set(id, str(v.session_id));
    const t = Date.parse(String(v.at ?? ''));
    if (!inWindow(t)) continue;
    const kind: EventKind | null = isRealBlock(v) ? 'block' : isConfirmedBypass(v) ? 'bypass' : null;
    if (kind) events.push({ at: new Date(t).toISOString(), sessionId: str(v.session_id), kind, ruleId: str(v.rule_id) });
  }

  // ── 오탐 판정 (verdicts.jsonl) — 세션은 판정이 가리키는 차단 기록에서 ──
  for (const v of readJsonlWindow<Record<string, unknown>>(path.join(enf, 'verdicts.jsonl'), days, now)) {
    if (v.verdict !== 'false_positive') continue;
    const t = Date.parse(String(v.at ?? ''));
    if (!inWindow(t)) continue;
    const vid = str(v.violation_id);
    events.push({ at: new Date(t).toISOString(), sessionId: vid ? sessionOfViolation.get(vid) ?? null : null, kind: 'false_positive', ruleId: str(v.rule_id) });
  }

  // ── 교정 (me/behavior explicit_correction) ──
  let files: string[] = [];
  try { files = fs.readdirSync(ME_BEHAVIOR).filter((f) => f.endsWith('.json')); sources.evidence = true; } catch { /* 없음 */ }
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(ME_BEHAVIOR, f), 'utf-8')) as Record<string, unknown>;
      if (e.type !== 'explicit_correction') continue;
      const t = Date.parse(String(e.timestamp ?? ''));
      if (!inWindow(t)) continue;
      const payload = (e.raw_payload ?? {}) as Record<string, unknown>;
      const refs = Array.isArray(e.candidate_rule_refs) ? e.candidate_rule_refs : [];
      events.push({
        at: new Date(t).toISOString(),
        sessionId: str(e.session_id),
        kind: e.source_component === 'auto-compound-miner' ? 'correction_mined' : 'correction_user',
        ruleId: str(payload.target_rule_id) ?? str(refs[0]),
      });
    } catch { /* 깨진 증거 건너뜀 */ }
  }

  // ── 솔루션 사건·세션 목록 (sessions.db) ──
  const sessions: ForgenEventSession[] = [];
  const db = openSessionsDb();
  if (db) {
    try {
      sources.sessionsDb = true;
      const rows = db.prepare('SELECT ts, session_id, event_type FROM solution_events WHERE ts >= ? AND ts <= ?').all(since, until) as Array<{ ts: number; session_id: string | null; event_type: string }>;
      for (const r of rows) {
        const kind = r.event_type === 'matched' ? 'solution_matched' : r.event_type === 'surfaced' ? 'solution_surfaced' : r.event_type === 'acted_on' ? 'solution_acted_on' : null;
        if (kind) events.push({ at: new Date(r.ts).toISOString(), sessionId: str(r.session_id), kind, ruleId: null });
      }
    } catch { /* 표 없음(옛 DB) */ }
    try {
      const referenced = new Set(events.map((e) => e.sessionId).filter((s): s is string => !!s));
      const rows = db.prepare('SELECT id, cwd, started_at FROM sessions').all() as Array<{ id: string; cwd: string; started_at: string }>;
      for (const r of rows) {
        const t = Date.parse(r.started_at);
        if (referenced.has(r.id) || inWindow(t)) sessions.push({ id: r.id, cwd: r.cwd, startedAt: Number.isFinite(t) ? new Date(t).toISOString() : r.started_at });
      }
    } catch { /* 표 없음 */ }
    try { db.close(); } catch { /* 무시 */ }
  }

  events.sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind));
  sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return { schema: EVENTS_SCHEMA, generatedAt: new Date(now).toISOString(), since: new Date(since).toISOString(), until: new Date(until).toISOString(), sources, events, sessions };
}
