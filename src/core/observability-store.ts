/**
 * Forgen — Observability Store (Phase 1)
 *
 * solution_events 테이블에 matched/surfaced/acted_on 이벤트를 기록.
 * Fail-open: 모든 함수는 내부 오류를 삼키고 절대 throw 하지 않는다.
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './logger.js';
import { FORGEN_HOME } from './paths.js';

const require = createRequire(import.meta.url);
const log = createLogger('observability');

const DB_PATH = path.join(FORGEN_HOME, 'sessions.db');

export type EventType = 'matched' | 'surfaced' | 'acted_on';

export interface EmitOptions {
  ts?: number;
  sessionId?: string | null;
  solutionId: string;
  eventType: EventType;
  signalSource: string;
  signalScore?: number | null;
  meta?: Record<string, unknown>;
}

export interface SurfacedEvent {
  id: number;
  ts: number;
  sessionId: string | null;
  solutionId: string;
  signalSource: string;
  signalScore: number | null;
  meta: Record<string, unknown> | null;
}

export interface HitRateRow {
  solutionId: string;
  matched_30d: number;
  surfaced_30d: number;
  acted_30d: number;
  matched_90d: number;
  surfaced_90d: number;
  acted_90d: number;
  matched_180d: number;
  surfaced_180d: number;
  acted_180d: number;
  last_event_ts: number;
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): { lastInsertRowid: number };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  close(): void;
}

const DEDUP_WINDOW_MS = 5 * 60 * 1000;

/** DB 파일을 열고 SqliteDb 반환. 실패 시 null. */
function openObsDb(): SqliteDb | null {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(DB_PATH) as SqliteDb;
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=1000;`);
    return db;
  } catch (e) {
    log.debug('openObsDb 실패', e);
    return null;
  }
}

/** solution_events 스키마 및 schema_version 초기화. idempotent. */
export function ensureObservabilitySchema(db: SqliteDb): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS solution_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_id TEXT,
        solution_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('matched','surfaced','acted_on')),
        signal_source TEXT,
        signal_score REAL,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_se_solution ON solution_events(solution_id, ts);
      CREATE INDEX IF NOT EXISTS idx_se_session  ON solution_events(session_id, ts);
      CREATE INDEX IF NOT EXISTS idx_se_type     ON solution_events(event_type, ts);
    `);
    const row = db.prepare(
      `SELECT version FROM schema_version WHERE component = 'observability'`
    ).get() as { version: number } | undefined;
    if (!row) {
      db.prepare(
        `INSERT INTO schema_version (component, version, applied_at) VALUES ('observability', 1, ?)`
      ).run(Date.now());
    }
  } catch (e) {
    log.debug('ensureObservabilitySchema 실패', e);
  }
}

/** solution_events 에 이벤트를 기록한다. fail-open (throw 없음). */
export function emitSolutionEvent(opts: EmitOptions): void {
  const ts = opts.ts ?? Date.now();
  let db: SqliteDb | null = null;
  try {
    db = openObsDb();
    if (!db) return;
    ensureObservabilitySchema(db);

    // dedup: 직전 5분 내 동일 (session, solution, source) 존재 시 skip
    if (opts.sessionId) {
      const dup = db.prepare(`
        SELECT id FROM solution_events
        WHERE session_id = ? AND solution_id = ? AND signal_source = ?
          AND ts > ?
        LIMIT 1
      `).get(opts.sessionId, opts.solutionId, opts.signalSource, ts - DEDUP_WINDOW_MS);
      if (dup) return;
    }

    db.prepare(`
      INSERT INTO solution_events (ts, session_id, solution_id, event_type, signal_source, signal_score, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      ts,
      opts.sessionId ?? null,
      opts.solutionId,
      opts.eventType,
      opts.signalSource,
      opts.signalScore ?? null,
      opts.meta ? JSON.stringify(opts.meta) : null,
    );
  } catch (e) {
    log.debug('emitSolutionEvent 실패', e);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** 특정 세션에서 지정 시간 window 내 surfaced 이벤트 조회. */
export function querySurfacedWithin(sessionId: string, minutesWindow: number): SurfacedEvent[] {
  let db: SqliteDb | null = null;
  try {
    db = openObsDb();
    if (!db) return [];
    ensureObservabilitySchema(db);
    const since = Date.now() - minutesWindow * 60 * 1000;
    const rows = db.prepare(`
      SELECT id, ts, session_id, solution_id, signal_source, signal_score, meta
      FROM solution_events
      WHERE session_id = ? AND event_type = 'surfaced' AND ts >= ?
      ORDER BY ts DESC
    `).all(sessionId, since) as Array<{
      id: number; ts: number; session_id: string | null;
      solution_id: string; signal_source: string;
      signal_score: number | null; meta: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      ts: r.ts,
      sessionId: r.session_id,
      solutionId: r.solution_id,
      signalSource: r.signal_source,
      signalScore: r.signal_score,
      meta: r.meta ? JSON.parse(r.meta) as Record<string, unknown> : null,
    }));
  } catch (e) {
    log.debug('querySurfacedWithin 실패', e);
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** 30/90/180일 hit-rate 집계. solutionId 지정 시 단일 솔루션만. */
export function queryHitRate(solutionId?: string): HitRateRow[] {
  let db: SqliteDb | null = null;
  try {
    db = openObsDb();
    if (!db) return [];
    ensureObservabilitySchema(db);
    const now = Date.now();
    const cutoff30  = now -  30 * 24 * 60 * 60 * 1000;
    const cutoff90  = now -  90 * 24 * 60 * 60 * 1000;
    const cutoff180 = now - 180 * 24 * 60 * 60 * 1000;
    const where = solutionId ? `WHERE solution_id = ?` : '';
    const baseParams: unknown[] = [
      cutoff30, cutoff30, cutoff30,
      cutoff90, cutoff90, cutoff90,
      cutoff180, cutoff180, cutoff180,
    ];
    const params: unknown[] = solutionId ? [...baseParams, solutionId] : baseParams;
    const rows = db.prepare(`
      SELECT
        solution_id,
        SUM(CASE WHEN event_type='matched'  AND ts > ? THEN 1 ELSE 0 END) AS matched_30d,
        SUM(CASE WHEN event_type='surfaced' AND ts > ? THEN 1 ELSE 0 END) AS surfaced_30d,
        SUM(CASE WHEN event_type='acted_on' AND ts > ? THEN 1 ELSE 0 END) AS acted_30d,
        SUM(CASE WHEN event_type='matched'  AND ts > ? THEN 1 ELSE 0 END) AS matched_90d,
        SUM(CASE WHEN event_type='surfaced' AND ts > ? THEN 1 ELSE 0 END) AS surfaced_90d,
        SUM(CASE WHEN event_type='acted_on' AND ts > ? THEN 1 ELSE 0 END) AS acted_90d,
        SUM(CASE WHEN event_type='matched'  AND ts > ? THEN 1 ELSE 0 END) AS matched_180d,
        SUM(CASE WHEN event_type='surfaced' AND ts > ? THEN 1 ELSE 0 END) AS surfaced_180d,
        SUM(CASE WHEN event_type='acted_on' AND ts > ? THEN 1 ELSE 0 END) AS acted_180d,
        MAX(ts) AS last_event_ts
      FROM solution_events
      ${where}
      GROUP BY solution_id
    `).all(...params) as Array<{
      solution_id: string;
      matched_30d: number; surfaced_30d: number; acted_30d: number;
      matched_90d: number; surfaced_90d: number; acted_90d: number;
      matched_180d: number; surfaced_180d: number; acted_180d: number;
      last_event_ts: number;
    }>;
    return rows.map(r => ({
      solutionId: r.solution_id,
      matched_30d:  r.matched_30d,
      surfaced_30d: r.surfaced_30d,
      acted_30d:    r.acted_30d,
      matched_90d:  r.matched_90d,
      surfaced_90d: r.surfaced_90d,
      acted_90d:    r.acted_90d,
      matched_180d:  r.matched_180d,
      surfaced_180d: r.surfaced_180d,
      acted_180d:    r.acted_180d,
      last_event_ts: r.last_event_ts,
    }));
  } catch (e) {
    log.debug('queryHitRate 실패', e);
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
