/**
 * Forgen — Session Store (Node.js built-in SQLite)
 *
 * 세션 대화를 SQLite에 저장하여 과거 세션을 전문 검색할 수 있게 함.
 * MCP session-search 도구가 이 데이터를 조회.
 * 외부 의존성 없음 — Node.js 22+ 내장 node:sqlite 사용.
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './logger.js';
import { FORGEN_HOME } from './paths.js';
import { ensureObservabilitySchema } from './observability-store.js';
import { stripPrivate } from '../engine/private-filter.js';

const require = createRequire(import.meta.url);

// Suppress ExperimentalWarning for node:sqlite (Node.js 22+)
{
  const origWarningListeners = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning') return;
    for (const listener of origWarningListeners) {
      (listener as (w: Error) => void)(warning);
    }
  });
}

const log = createLogger('session-store');

const DB_PATH = path.join(FORGEN_HOME, 'sessions.db');

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): { lastInsertRowid: number };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  close(): void;
}

interface SessionRow {
  session_id: string;
  role: string;
  content: string;
  timestamp: string;
  cwd: string;
}

let fts5Available = false;

function openDb(): SqliteDb | null {
  try {
    // Node.js 22+ experimental node:sqlite
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA busy_timeout=8000;'); // 다른 러너가 쓰는 중이어도 최대 8초 대기 (WAL 전환·스키마 생성 포함이라 가장 먼저)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        started_at TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        indexed_offset INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
    `);

    // 구버전 DB: 증분 인덱싱용 컬럼 추가 (이미 있으면 실패 → 무시)
    try { db.exec('ALTER TABLE sessions ADD COLUMN indexed_offset INTEGER'); } catch { /* exists */ }

    // FTS5 가상 테이블 생성 (미지원 시 LIKE 폴백)
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          content,
          content=messages,
          content_rowid=id,
          tokenize='unicode61 remove_diacritics 2'
        );
      `);
      fts5Available = true;
    } catch (e) {
      log.debug('FTS5 미지원 — LIKE 폴백 사용', e);
      fts5Available = false;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ensureObservabilitySchema(db as any);

    return db;
  } catch (e) {
    log.debug('SQLite 초기화 실패 (Node.js 22+ 필요)', e);
    return null;
  }
}

/**
 * Transcript JSONL 을 SQLite 에 **증분** 인덱싱 (Claude·Codex 스키마 공통, D9).
 *
 * - sessions.indexed_offset 바이트부터 스트림으로 읽어 새 메시지만 추가한다 → 긴 세션을 여러 번
 *   돌려도 중복 없음(멱등). 파일이 줄었으면(교체) 그 세션을 지우고 처음부터.
 * - 주입 텍스트(스킬 본문·system-reminder 등)는 classifyEntry 가 걸러 검색 잡음을 만들지 않는다.
 * - 이전 구현은 Claude 의 실제 스키마(`message.content`)가 아니라 top-level `content` 만 읽어
 *   직접 실행·래퍼 구분 없이 메시지가 0건이었다.
 * - 호출처: 러너(auto-compound-runner, SessionEnd/Stop/SessionStart 어느 경로든) + 래퍼 종료 후.
 */
export async function indexTranscript(cwd: string, transcriptPath: string, sessionId: string): Promise<{ added: number; offset: number } | null> {
  const db = openDb();
  if (!db) return null;
  try {
    const { streamTranscriptLines, classifyEntry } = await import('./transcript-summary.js');
    const size = fs.statSync(transcriptPath).size;
    // 쓰기 잠금을 먼저 잡고 오프셋을 읽는다 — 러너 2개가 같은 세션을 동시에 돌려도 중복 삽입 없음.
    db.exec('BEGIN IMMEDIATE');
    let inTx = true;
    try {
    const existing = db.prepare('SELECT indexed_offset AS off, message_count AS n FROM sessions WHERE id = ?').get(sessionId) as { off: number | null; n: number } | undefined;
    let from = 0;
    if (existing) {
      if (existing.off === null || existing.off === undefined || existing.off > size) {
        // 구버전 행(오프셋 없음) 또는 파일 교체: 이 세션의 메시지를 지우고 처음부터.
        deleteSessionMessages(db, sessionId);
        db.prepare('UPDATE sessions SET message_count = 0, indexed_offset = 0 WHERE id = ?').run(sessionId);
      } else {
        from = existing.off;
      }
    } else {
      db.prepare('INSERT INTO sessions (id, cwd, started_at, message_count, indexed_offset) VALUES (?, ?, ?, 0, 0)')
        .run(sessionId, cwd, new Date().toISOString());
    }
    if (from >= size) { db.exec('COMMIT'); inTx = false; return { added: 0, offset: from }; }

    const insertMsg = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
    const insertFts = fts5Available ? db.prepare('INSERT INTO messages_fts(rowid, content) VALUES (?, ?)') : null;
    let added = 0;
    let endOffset = from;
    {
      endOffset = await streamTranscriptLines(transcriptPath, from, (line) => {
        if (!line || !(line.includes('"type":"user"') || line.includes('"type":"assistant"')
          || line.includes('"type":"queue-operation"') || line.includes('"type":"response_item"'))) return;
        try {
          const entry = JSON.parse(line);
          const c = classifyEntry(entry);
          if (!c) return;
          // W2-5 (private 태그): FTS 인덱스는 session-search 로 재노출되므로 <private> 범위를 제거 후 인덱싱.
          const text = stripPrivate(c.text).cleaned;
          if (!text.trim()) return;
          const truncated = text.slice(0, 10000);
          const ts = typeof entry.timestamp === 'string' ? entry.timestamp : '';
          const result = insertMsg.run(sessionId, c.role, truncated, ts);
          if (insertFts) {
            try { insertFts.run(result.lastInsertRowid, truncated); } catch { /* FTS sync failure */ }
          }
          added++;
        } catch { /* skip malformed lines */ }
      });
      db.prepare('UPDATE sessions SET message_count = message_count + ?, indexed_offset = ? WHERE id = ?').run(added, endOffset, sessionId);
      db.exec('COMMIT');
      inTx = false;
    }
    log.debug(`세션 인덱싱: ${sessionId} +${added} messages (offset ${from}→${endOffset})`);
    return { added, offset: endOffset };
    } finally {
      if (inTx) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } }
    }
  } catch (e) {
    log.debug('세션 인덱싱 실패', e);
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function deleteSessionMessages(db: SqliteDb, sessionId: string): void {
  if (fts5Available) {
    const rows = db.prepare('SELECT id, content FROM messages WHERE session_id = ?').all(sessionId) as Array<{ id: number; content: string }>;
    const del = db.prepare("INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', ?, ?)");
    for (const r of rows) { try { del.run(r.id, r.content); } catch { /* ignore */ } }
  }
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
}

/** 하위 호환 이름 (Claude/Codex 공통 구현으로 위임). */
export async function indexSession(cwd: string, transcriptPath: string, sessionId: string): Promise<void> {
  await indexTranscript(cwd, transcriptPath, sessionId);
}
export async function indexCodexSession(cwd: string, transcriptPath: string, sessionId: string): Promise<void> {
  await indexTranscript(cwd, transcriptPath, sessionId);
}

/**
 * 과거 세션 검색.
 * FTS5 MATCH 우선 사용 (전문 검색, 순위 정렬).
 * FTS5 미지원 시 LIKE 기반 폴백.
 */
export function searchSessions(query: string, limit = 10): Array<{
  sessionId: string;
  role: string;
  content: string;
  timestamp: string;
  cwd: string;
  tokens: string[];
}> {
  const db = openDb();
  if (!db) return [];

  const tokens = query
    .split(/\s+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 2);

  if (tokens.length === 0) return [];

  try {
    let results: SessionRow[];

    if (fts5Available) {
      // FTS5 MATCH — 전문 검색 + BM25 순위 정렬
      const ftsQuery = tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' AND ');
      results = db.prepare(`
        SELECT m.session_id, m.role, m.content, m.timestamp, s.cwd
        FROM messages_fts fts
        JOIN messages m ON fts.rowid = m.id
        JOIN sessions s ON m.session_id = s.id
        WHERE messages_fts MATCH ?
        ORDER BY fts.rank
        LIMIT ?
      `).all(ftsQuery, limit) as SessionRow[];
    } else {
      // LIKE 폴백
      const conditions = tokens.map(() => "LOWER(m.content) LIKE ? ESCAPE '\\'").join(' AND ');
      const escapedTokens = tokens.map(t => t.replace(/%/g, '\\%').replace(/_/g, '\\_'));
      const params: (string | number)[] = escapedTokens.map(t => `%${t}%`);
      params.push(limit);

      results = db.prepare(`
        SELECT m.session_id, m.role, m.content, m.timestamp, s.cwd
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        WHERE ${conditions}
        ORDER BY m.id DESC
        LIMIT ?
      `).all(...params) as SessionRow[];
    }

    return results.map((r: SessionRow) => ({
      sessionId: r.session_id,
      role: r.role,
      content: r.content,
      timestamp: r.timestamp,
      cwd: r.cwd,
      tokens,
    }));
  } catch (e) {
    log.debug('세션 검색 실패', e);
    return [];
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * 매칭 토큰 위치를 기준으로 컨텍스트 윈도우를 추출.
 */
export function extractContextWindow(content: string, tokens: string[], windowSize = 120): string {
  const lower = content.toLowerCase();
  const positions: number[] = [];
  for (const token of tokens) {
    const idx = lower.indexOf(token);
    if (idx !== -1) positions.push(idx);
  }
  if (positions.length === 0) return content.slice(0, 200);
  positions.sort((a, b) => a - b);
  const center = positions[0];
  const start = Math.max(0, center - windowSize);
  const end = Math.min(content.length, center + windowSize);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';
  return `${prefix}${content.slice(start, end)}${suffix}`;
}
