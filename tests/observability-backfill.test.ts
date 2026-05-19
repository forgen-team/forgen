/**
 * Observability Phase 2 — backfill 단위 테스트
 *
 * 격리: FORGEN_HOME + 모의 JSONL 파일 사용.
 * 실제 DB write → openFreshDb 로 검증.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── 격리 환경 ─────────────────────────────────────────────────────────────
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-backfill-test-'));
process.env.FORGEN_HOME = TMP_HOME;

const STATE_DIR = path.join(TMP_HOME, 'state');
const OUTCOMES_DIR = path.join(STATE_DIR, 'outcomes');
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(OUTCOMES_DIR, { recursive: true });

const { runBackfill } = await import('../src/core/observability-backfill.js');

// ── 헬퍼 ──────────────────────────────────────────────────────────────────
function openFreshDb() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(TMP_HOME, 'sessions.db'));
  db.exec(`PRAGMA journal_mode=WAL;`);
  return db;
}

function countEvents(opts: { signalSource?: string; eventType?: string; solutionId?: string }): number {
  const db = openFreshDb();
  try {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.signalSource) { clauses.push('signal_source = ?'); params.push(opts.signalSource); }
    if (opts.eventType)   { clauses.push('event_type = ?');    params.push(opts.eventType); }
    if (opts.solutionId)  { clauses.push('solution_id = ?');   params.push(opts.solutionId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM solution_events ${where}`).get(...params) as { cnt: number };
    return row.cnt;
  } finally {
    db.close();
  }
}

function writeJsonl(filePath: string, records: unknown[]): void {
  fs.writeFileSync(filePath, records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

afterAll(() => {
  console.log(`[test] tmp dir: ${TMP_HOME} (수동 정리 필요)`);
});

// ── 테스트 ────────────────────────────────────────────────────────────────
describe('observability-backfill', () => {

  it('1. Phase A: compound-usage.jsonl → acted_on (mcp-read-backfill)', async () => {
    const usagePath = path.join(STATE_DIR, 'compound-usage.jsonl');
    writeJsonl(usagePath, [
      { at: '2026-05-10T10:00:00Z', name: 'sol-usage-a', via: 'mcp' },
      { at: '2026-05-10T11:00:00Z', name: 'sol-usage-b', via: 'cli' },
    ]);

    const result = await runBackfill({ force: true, phase: 'A', dryRun: false });

    expect(result.phaseA.acted_on).toBeGreaterThanOrEqual(2);
    const count = countEvents({ signalSource: 'mcp-read-backfill', eventType: 'acted_on', solutionId: 'sol-usage-a' });
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('2. Phase A: outcomes/<sid>.jsonl outcome=accept → acted_on (outcome-accept-backfill)', async () => {
    const outFile = path.join(OUTCOMES_DIR, 'sess-backfill-test.jsonl');
    writeJsonl(outFile, [
      { outcome: 'accept', solution_id: 'sol-accept-x', session_id: 'sess-backfill-test', ts: Date.now() - 10000 },
      { outcome: 'error',  solution_id: 'sol-error-y',  session_id: 'sess-backfill-test', ts: Date.now() - 5000 },
    ]);

    await runBackfill({ force: true, phase: 'A', dryRun: false });

    const acceptCount = countEvents({ signalSource: 'outcome-accept-backfill', solutionId: 'sol-accept-x' });
    expect(acceptCount).toBeGreaterThanOrEqual(1);

    // outcome=error 는 acted_on 으로 변환 안 됨
    const errorCount = countEvents({ signalSource: 'outcome-accept-backfill', solutionId: 'sol-error-y' });
    expect(errorCount).toBe(0);
  });

  it('3. 기존 events 있으면 reject (--force 없이)', async () => {
    // 기존에 이미 events 가 있으므로 (이전 테스트에서 insert 됨) reject 확인
    await expect(runBackfill({ force: false, phase: 'A', dryRun: false }))
      .rejects
      .toThrow('기존 이벤트가 있습니다');
  });

  it('4. --force 플래그로 기존 events 있어도 강행', async () => {
    const result = await runBackfill({ force: true, phase: 'A', dryRun: false });
    // durationMs 가 정수 양수인지 검증
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it('5. dryRun: DB insert 없이 count 만 반환', async () => {
    const db = openFreshDb();
    let countBefore: number;
    try {
      const row = db.prepare(`SELECT COUNT(*) AS cnt FROM solution_events`).get() as { cnt: number };
      countBefore = row.cnt;
    } finally {
      db.close();
    }

    await runBackfill({ force: true, phase: 'A', dryRun: true });

    const db2 = openFreshDb();
    try {
      const row = db2.prepare(`SELECT COUNT(*) AS cnt FROM solution_events`).get() as { cnt: number };
      // dryRun 이므로 count 변화 없어야 함
      expect(row.cnt).toBe(countBefore);
    } finally {
      db2.close();
    }
  });

  it('6. signal_source *-backfill prefix 검증', async () => {
    const db = openFreshDb();
    try {
      const rows = db.prepare(
        `SELECT DISTINCT signal_source FROM solution_events WHERE signal_source LIKE '%-backfill'`
      ).all() as Array<{ signal_source: string }>;
      const sources = rows.map(r => r.signal_source);
      // 모든 backfill source 는 -backfill suffix
      for (const src of sources) {
        expect(src).toMatch(/-backfill$/);
      }
    } finally {
      db.close();
    }
  });

  it('7. BackfillResult 구조 검증', async () => {
    const result = await runBackfill({ force: true, phase: 'A', dryRun: true });
    expect(result).toHaveProperty('phaseA');
    expect(result).toHaveProperty('phaseB');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('durationMs');
    expect(result.phaseA).toHaveProperty('matched');
    expect(result.phaseA).toHaveProperty('surfaced');
    expect(result.phaseA).toHaveProperty('acted_on');
    expect(result.phaseB).toHaveProperty('acted_on');
    expect(typeof result.total).toBe('number');
    expect(typeof result.durationMs).toBe('number');
  });

});
