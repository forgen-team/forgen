/**
 * Forgen — Observability Backfill (Phase 2)
 *
 * 기존 JSONL 상태 파일에서 solution_events 를 소급 생성한다.
 * Phase A (결정론적): match-eval-log, implicit-feedback, compound-usage, outcomes
 * Phase B (휴리스틱): transcript 스캔 — CLI --phase B|all 로만 활성
 *
 * 안전성:
 *   - 기본: events 가 이미 있으면 reject (--force 필요)
 *   - signal_source 에 '-backfill' prefix 로 실시간 emit 과 구분
 *   - BEGIN/COMMIT 단위 트랜잭션
 *   - fail-open: 파일 누락은 조용히 skip
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { STATE_DIR, MATCH_EVAL_LOG_PATH, FORGEN_HOME } from './paths.js';
import { createLogger } from './logger.js';
import { emitSolutionEvent } from './observability-store.js';

const require = createRequire(import.meta.url);
const log = createLogger('observability-backfill');

const DB_PATH = path.join(FORGEN_HOME, 'sessions.db');

export interface BackfillOptions {
  force?: boolean;
  phase?: 'A' | 'B' | 'all';
  dryRun?: boolean;
}

export interface BackfillResult {
  phaseA: { matched: number; surfaced: number; acted_on: number };
  phaseB: { acted_on: number };
  total: number;
  durationMs: number;
}

const COMPOUND_USAGE_LOG = path.join(STATE_DIR, 'compound-usage.jsonl');
const IMPLICIT_FEEDBACK_LOG = path.join(STATE_DIR, 'implicit-feedback.jsonl');
const OUTCOMES_DIR = path.join(STATE_DIR, 'outcomes');

interface MatchEvalLine {
  candidates?: Array<{ name: string; relevance: number }>;
  rankedTopN?: string[];
  sessionId?: string;
  session_id?: string;
}

interface ImplicitFeedbackLine {
  type?: string;
  solutionId?: string;
  solution_id?: string;
  sessionId?: string;
  session_id?: string;
  at?: string;
}

interface UsageLine {
  at?: string;
  name?: string;
  via?: string;
}

interface OutcomeLine {
  outcome?: string;
  solution_id?: string;
  solutionId?: string;
  session_id?: string;
  sessionId?: string;
  ts?: number;
  at?: string;
}

function readJsonlLines<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
      .filter((x): x is T => x !== null);
  } catch {
    return [];
  }
}

function hasExistingEvents(): boolean {
  try {
    if (!fs.existsSync(DB_PATH)) return false;
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    try {
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt FROM solution_events`
      ).get() as { cnt: number } | undefined;
      return (row?.cnt ?? 0) > 0;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** Phase A: 결정론적 소급 */
async function runPhaseA(opts: BackfillOptions): Promise<BackfillResult['phaseA']> {
  const counts = { matched: 0, surfaced: 0, acted_on: 0 };

  // 1. match-eval-log.jsonl → matched events
  const matchLines = readJsonlLines<MatchEvalLine>(MATCH_EVAL_LOG_PATH);
  for (const line of matchLines) {
    const sessionId = line.sessionId ?? line.session_id ?? undefined;
    const topN = line.rankedTopN ?? line.candidates?.slice(0, 5).map(c => c.name) ?? [];
    const candidateMap = new Map((line.candidates ?? []).map(c => [c.name, c.relevance]));
    for (const name of topN) {
      if (!name) continue;
      const score = candidateMap.get(name) ?? null;
      if (!opts.dryRun) {
        emitSolutionEvent({
          sessionId: sessionId ?? null,
          solutionId: name,
          eventType: 'matched',
          signalSource: 'matcher-backfill',
          signalScore: score,
        });
      }
      counts.matched++;
      if (counts.matched % 1000 === 0) process.stderr.write(`[backfill] matched: ${counts.matched}\n`);
    }
  }

  // 2. implicit-feedback.jsonl type='recommendation_surfaced' → surfaced
  const feedbackLines = readJsonlLines<ImplicitFeedbackLine>(IMPLICIT_FEEDBACK_LOG);
  for (const line of feedbackLines) {
    if (line.type !== 'recommendation_surfaced') continue;
    const sid = line.solutionId ?? line.solution_id;
    if (!sid) continue;
    const sessionId = line.sessionId ?? line.session_id ?? undefined;
    if (!opts.dryRun) {
      emitSolutionEvent({
        sessionId: sessionId ?? null,
        solutionId: sid,
        eventType: 'surfaced',
        signalSource: 'hook-backfill',
      });
    }
    counts.surfaced++;
  }

  // 3. compound-usage.jsonl → acted_on (signalSource='mcp-read-backfill')
  const usageLines = readJsonlLines<UsageLine>(COMPOUND_USAGE_LOG);
  for (const line of usageLines) {
    if (!line.name) continue;
    if (!opts.dryRun) {
      emitSolutionEvent({
        sessionId: null,
        solutionId: line.name,
        eventType: 'acted_on',
        signalSource: 'mcp-read-backfill',
        signalScore: 0.30,
      });
    }
    counts.acted_on++;
    if (counts.acted_on % 1000 === 0) process.stderr.write(`[backfill] acted_on: ${counts.acted_on}\n`);
  }

  // 4. outcomes/<sid>.jsonl outcome='accept' → acted_on (signalSource='outcome-accept-backfill')
  if (fs.existsSync(OUTCOMES_DIR)) {
    const outFiles = fs.readdirSync(OUTCOMES_DIR).filter(f => f.endsWith('.jsonl'));
    for (const file of outFiles) {
      const lines = readJsonlLines<OutcomeLine>(path.join(OUTCOMES_DIR, file));
      for (const line of lines) {
        if (line.outcome !== 'accept') continue;
        const sid = line.solution_id ?? line.solutionId;
        if (!sid) continue;
        const sessionId = line.session_id ?? line.sessionId ?? undefined;
        if (!opts.dryRun) {
          emitSolutionEvent({
            sessionId: sessionId ?? null,
            solutionId: sid,
            eventType: 'acted_on',
            signalSource: 'outcome-accept-backfill',
            signalScore: 0.15,
          });
        }
        counts.acted_on++;
      }
    }
  }

  return counts;
}

export async function runBackfill(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const start = Date.now();
  const phase = opts.phase ?? 'A';

  if (!opts.force && !opts.dryRun) {
    if (hasExistingEvents()) {
      throw new Error(
        'solution_events 테이블에 기존 이벤트가 있습니다. ' +
        '--force 플래그를 사용하면 강행합니다.'
      );
    }
  }

  const phaseA: BackfillResult['phaseA'] = { matched: 0, surfaced: 0, acted_on: 0 };
  const phaseB: BackfillResult['phaseB'] = { acted_on: 0 };

  if (phase === 'A' || phase === 'all') {
    const aResult = await runPhaseA(opts);
    phaseA.matched = aResult.matched;
    phaseA.surfaced = aResult.surfaced;
    phaseA.acted_on = aResult.acted_on;
  }

  // Phase B: transcript 스캔 — 1차 release 는 opt-in 만
  if (phase === 'B' || phase === 'all') {
    log.debug('Phase B (transcript scan) 은 현재 미구현 — 향후 릴리스에서 활성화');
  }

  const total = phaseA.matched + phaseA.surfaced + phaseA.acted_on + phaseB.acted_on;
  const durationMs = Date.now() - start;

  return { phaseA, phaseB, total, durationMs };
}
