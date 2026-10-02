/**
 * claude-mem 콘텐츠 recall — `claude-mem search` 가 검색 결과 *테이블* (ID + 제목) 만 반환하므로
 * LLM 컨텍스트로는 사실상 메타-noise. 검색 후 상위 N hit 의 ID 를 파싱 → 로컬
 * `~/.claude-mem/claude-mem.db` 의 observations.narrative / session_summaries.learned 를 직접 조회해
 * 실제 콘텐츠를 inject 한다 (v0.4.5, 2026-05-08).
 *
 * 0.5.9: real-arms.ts 에서 분리. DB 조회를 `sqlite3` CLI 전용에서 `node:sqlite`(내장) 우선으로 바꿨다 —
 * CLI 가 없는 머신에서는 recall 이 조용히 빈 문자열이 되어 forgen+mem arm 이 forgen-only 와 같아졌다.
 *
 * claude-mem 과의 계약 (13.12.4 / 13.28.0 에서 실측 동일):
 *   - `claude-mem search <q>` stdout = `{"content":[{"type":"text","text":"…| #12 | … |…"}]}`
 *     (observation 은 `#N`, session summary 는 `#SN` — 공백이 끼어도 허용한다)
 *   - DB: `observations(id,title,narrative,text)`, `session_summaries(id,request,learned,completed)`
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';

export interface MemHit {
  table: 'observations' | 'session_summaries';
  id: number;
}

/** `claude-mem search` stdout → 상위 topN hit. 형식이 다르면 빈 배열 (graceful). */
export function parseSearchHits(searchOut: string, topN = 2): MemHit[] {
  let parsed: { content?: Array<{ text?: string }> };
  try {
    parsed = JSON.parse(searchOut);
  } catch {
    return [];
  }
  const rawText = parsed?.content?.[0]?.text ?? '';
  if (!rawText) return [];
  // Match table rows: `| #NNN | ... |` or `| #SNNN | ... |` (공백 허용). Digits only → SQL-safe.
  const seen = new Set<string>();
  const hits: MemHit[] = [];
  for (const m of rawText.matchAll(/\|\s*#(S?)\s*(\d+)\s*\|/g)) {
    const key = `${m[1]}${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ table: m[1] === 'S' ? 'session_summaries' : 'observations', id: Number.parseInt(m[2], 10) });
    if (hits.length >= topN) break;
  }
  return hits;
}

function sqlFor(hit: MemHit): string {
  return hit.table === 'observations'
    ? `SELECT coalesce(title,'') || char(10) || coalesce(narrative, text, '') AS body FROM observations WHERE id=${hit.id}`
    : `SELECT coalesce(request,'') || char(10) || coalesce(learned,'') || char(10) || coalesce(completed,'') AS body FROM session_summaries WHERE id=${hit.id}`;
}

type SqliteModule = { DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => { prepare(sql: string): { get(): unknown }; close(): void } };

/** 내장 sqlite — Node 22.13+ 에서 플래그 없이 사용 가능. 없으면 null (→ sqlite3 CLI 폴백). */
function builtinSqlite(): SqliteModule | null {
  try {
    const get = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    return (get?.('node:sqlite') as SqliteModule | undefined) ?? null;
  } catch {
    return null;
  }
}

export type MemReadBackend = 'node:sqlite' | 'sqlite3-cli' | 'none';

/** 이 환경에서 DB 를 읽을 수 있는 방법. 'none' 이면 recall 은 항상 빈 문자열이다 — preflight 에서 알린다. */
export function detectMemReadBackend(): MemReadBackend {
  if (builtinSqlite()) return 'node:sqlite';
  try {
    execSync('sqlite3 -version', { stdio: 'pipe', timeout: 3000 });
    return 'sqlite3-cli';
  } catch {
    return 'none';
  }
}

/** hit 들의 실제 콘텐츠를 DB 에서 읽어 `[#id]\n본문` 조각으로 이어 붙인다. 실패한 hit 은 건너뛴다. */
export function readMemFragments(dbPath: string, hits: MemHit[]): string {
  if (hits.length === 0 || !fs.existsSync(dbPath)) return '';
  const fragments: string[] = [];
  const push = (hit: MemHit, body: string): void => {
    const out = body.trim();
    if (out) fragments.push(`[${hit.table === 'observations' ? `#${hit.id}` : `#S${hit.id}`}]\n${out.slice(0, 600)}`);
  };

  const sqlite = builtinSqlite();
  if (sqlite) {
    let db: InstanceType<SqliteModule['DatabaseSync']> | null = null;
    try {
      db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      for (const hit of hits) {
        try {
          const row = db.prepare(sqlFor(hit)).get() as { body?: string } | undefined;
          if (row?.body) push(hit, row.body);
        } catch { /* skip this hit */ }
      }
      return fragments.join('\n\n');
    } catch {
      /* DB 를 열지 못함 — CLI 폴백 */
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  for (const hit of hits) {
    try {
      push(hit, execSync(`sqlite3 ${JSON.stringify(dbPath)} ${JSON.stringify(sqlFor(hit))}`, { encoding: 'utf-8', timeout: 3000 }));
    } catch { /* skip this hit */ }
  }
  return fragments.join('\n\n');
}

/**
 * claude-mem 실제 콘텐츠 recall. 어떤 실패에도 '' 를 반환한다 (graceful).
 */
export function claudeMemRecallActual(userMsg: string, topN = 2): string {
  let searchOut: string;
  try {
    searchOut = execSync(
      `npx --no-install claude-mem search ${JSON.stringify(userMsg.slice(0, 80))} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
  } catch {
    return '';
  }
  if (!searchOut) return '';
  const dbPath = process.env.CLAUDE_MEM_DB ?? `${os.homedir()}/.claude-mem/claude-mem.db`;
  return readMemFragments(dbPath, parseSearchHits(searchOut, topN));
}
