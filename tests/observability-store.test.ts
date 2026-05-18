/**
 * Observability Store — Phase 1 unit tests
 *
 * 격리: FORGEN_HOME env 를 임시 디렉토리로 override 하여 실 DB 를 건드리지 않음.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── 격리 FORGEN_HOME 설정 ───────────────────────────────────────────────────
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-obs-test-'));
process.env.FORGEN_HOME = TMP_HOME;

// FORGEN_HOME 설정 후 모듈 import (paths.ts 가 env 를 읽음)
const { ensureObservabilitySchema, emitSolutionEvent, querySurfacedWithin, queryHitRate } =
  await import('../src/core/observability-store.js');

// ── 헬퍼 ───────────────────────────────────────────────────────────────────
function openFreshDb() {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(TMP_HOME, 'sessions.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=1000;`);
  return db;
}

afterAll(() => {
  // 경로만 출력. rm -rf 는 사용자 confirm 필요이므로 생략.
  console.log(`[test] tmp dir: ${TMP_HOME} (수동 정리 필요)`);
});

// ── 테스트 ─────────────────────────────────────────────────────────────────
describe('observability-store', () => {

  it('1. ensureObservabilitySchema — 첫 호출 시 schema 생성', () => {
    const db = openFreshDb();
    try {
      ensureObservabilitySchema(db as any);
      const tables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
      ).all() as Array<{ name: string }>;
      const names = tables.map(t => t.name);
      expect(names).toContain('solution_events');
      expect(names).toContain('schema_version');
    } finally {
      db.close();
    }
  });

  it('2. ensureObservabilitySchema — 재호출 idempotent (schema_version row 1개)', () => {
    const db = openFreshDb();
    try {
      ensureObservabilitySchema(db as any);
      ensureObservabilitySchema(db as any); // 2nd call
      const rows = db.prepare(
        `SELECT * FROM schema_version WHERE component = 'observability'`
      ).all() as Array<{ version: number }>;
      expect(rows.length).toBe(1);
      expect(rows[0].version).toBe(1);
    } finally {
      db.close();
    }
  });

  it('3. emitSolutionEvent — 단일 INSERT', () => {
    emitSolutionEvent({
      sessionId: 'sess-a',
      solutionId: 'sol-x',
      eventType: 'matched',
      signalSource: 'matcher',
      signalScore: 0.8,
      meta: { matchedTags: ['tdd'] },
    });
    const db = openFreshDb();
    try {
      const rows = db.prepare(
        `SELECT * FROM solution_events WHERE solution_id = 'sol-x'`
      ).all() as Array<{ event_type: string; signal_score: number }>;
      expect(rows.length).toBe(1);
      expect(rows[0].event_type).toBe('matched');
      expect(rows[0].signal_score).toBeCloseTo(0.8);
    } finally {
      db.close();
    }
  });

  it('4. dedup — 동일 (session, solution, source) 5분 내 중복 skip', () => {
    const ts = Date.now();
    emitSolutionEvent({ sessionId: 'sess-dedup', solutionId: 'sol-dedup', eventType: 'surfaced', signalSource: 'hook-prepend', ts });
    emitSolutionEvent({ sessionId: 'sess-dedup', solutionId: 'sol-dedup', eventType: 'surfaced', signalSource: 'hook-prepend', ts: ts + 1000 }); // 1초 후 = dedup 구간
    const db = openFreshDb();
    try {
      const rows = db.prepare(
        `SELECT * FROM solution_events WHERE session_id = 'sess-dedup' AND solution_id = 'sol-dedup'`
      ).all();
      expect(rows.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('5. dedup — signal_source 다르면 emit OK', () => {
    const ts = Date.now();
    emitSolutionEvent({ sessionId: 'sess-dedup2', solutionId: 'sol-dedup2', eventType: 'matched', signalSource: 'matcher', ts });
    emitSolutionEvent({ sessionId: 'sess-dedup2', solutionId: 'sol-dedup2', eventType: 'surfaced', signalSource: 'hook-prepend', ts: ts + 100 }); // source 다름
    const db = openFreshDb();
    try {
      const rows = db.prepare(
        `SELECT * FROM solution_events WHERE session_id = 'sess-dedup2'`
      ).all();
      expect(rows.length).toBe(2);
    } finally {
      db.close();
    }
  });

  it('6. queryHitRate — matched/surfaced/acted count 정확', () => {
    const now = Date.now();
    emitSolutionEvent({ sessionId: 's1', solutionId: 'sol-hr', eventType: 'matched',   signalSource: 'matcher',      ts: now });
    emitSolutionEvent({ sessionId: 's2', solutionId: 'sol-hr', eventType: 'surfaced',  signalSource: 'hook-prepend', ts: now + 1000 });
    emitSolutionEvent({ sessionId: 's3', solutionId: 'sol-hr', eventType: 'acted_on',  signalSource: 'outcome',      ts: now + 2000 });
    const rows = queryHitRate('sol-hr');
    expect(rows.length).toBe(1);
    expect(rows[0].matched_30d).toBeGreaterThanOrEqual(1);
    expect(rows[0].surfaced_30d).toBeGreaterThanOrEqual(1);
    expect(rows[0].acted_30d).toBeGreaterThanOrEqual(1);
  });

  it('7. querySurfacedWithin — 시간 window 정확', () => {
    const now = Date.now();
    // 5분 이내 surfaced
    emitSolutionEvent({ sessionId: 'sess-win', solutionId: 'sol-win1', eventType: 'surfaced', signalSource: 'hook-prepend', ts: now - 2 * 60 * 1000 });
    // 30분 전 = window 밖
    emitSolutionEvent({ sessionId: 'sess-win', solutionId: 'sol-win2', eventType: 'surfaced', signalSource: 'hook-prepend', ts: now - 30 * 60 * 1000 });
    const events = querySurfacedWithin('sess-win', 10); // 10분 window
    const ids = events.map(e => e.solutionId);
    expect(ids).toContain('sol-win1');
    expect(ids).not.toContain('sol-win2');
  });

  it('8. WAL 모드 활성화 검증', () => {
    const db = openFreshDb();
    try {
      const row = db.prepare(`PRAGMA journal_mode`).get() as { journal_mode: string };
      expect(row.journal_mode).toBe('wal');
    } finally {
      db.close();
    }
  });

  it('9. fail-open — invalid eventType CHECK 위반 시 throw X', () => {
    // emitSolutionEvent 는 내부에서 try/catch — 절대 throw 안 함
    expect(() => {
      emitSolutionEvent({
        sessionId: 'sess-fail',
        solutionId: 'sol-fail',
        eventType: 'invalid_type' as any,
        signalSource: 'test',
      });
    }).not.toThrow();
  });

  it('10. meta JSON round-trip', () => {
    const meta = { matchedTags: ['tdd', 'typescript'], count: 42, nested: { ok: true } };
    emitSolutionEvent({
      sessionId: 'sess-meta',
      solutionId: 'sol-meta',
      eventType: 'surfaced',
      signalSource: 'hook-prepend',
      meta,
    });
    const events = querySurfacedWithin('sess-meta', 60);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const found = events.find(e => e.solutionId === 'sol-meta');
    expect(found).toBeDefined();
    expect(found!.meta).toEqual(meta);
  });

});
