/**
 * Observability Phase 2 — heuristic acted_on signal 통합 테스트
 *
 * 격리: FORGEN_HOME + ME_SOLUTIONS 를 tmp 디렉토리로 override.
 * 실제 DB write → openFreshDb 로 읽어 검증.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── 격리 환경 설정 ─────────────────────────────────────────────────────────
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-obs-heuristic-'));
const TMP_SOLUTIONS = path.join(TMP_HOME, 'me', 'solutions');
process.env.FORGEN_HOME = TMP_HOME;

// FORGEN_HOME 설정 후 import
const { emitSolutionEvent, querySurfacedWithin } =
  await import('../src/core/observability-store.js');

// ── 헬퍼 ──────────────────────────────────────────────────────────────────
function openFreshDb() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(TMP_HOME, 'sessions.db'));
  db.exec(`PRAGMA journal_mode=WAL;`);
  return db;
}

function countEvents(opts: { sessionId?: string; solutionId?: string; eventType?: string; signalSource?: string }): number {
  const db = openFreshDb();
  try {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.sessionId)    { clauses.push('session_id = ?');   params.push(opts.sessionId); }
    if (opts.solutionId)   { clauses.push('solution_id = ?');  params.push(opts.solutionId); }
    if (opts.eventType)    { clauses.push('event_type = ?');   params.push(opts.eventType); }
    if (opts.signalSource) { clauses.push('signal_source = ?'); params.push(opts.signalSource); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM solution_events ${where}`).get(...params) as { cnt: number };
    return row.cnt;
  } finally {
    db.close();
  }
}

/** 솔루션 .md 파일을 tmp solutions 디렉토리에 생성 */
function createSolutionFile(name: string, tags: string[], identifiers: string[] = []): void {
  fs.mkdirSync(TMP_SOLUTIONS, { recursive: true });
  const content = [
    '---',
    `name: ${name}`,
    'version: 1',
    'status: experiment',
    'confidence: 0.3',
    'type: pattern',
    'scope: me',
    `tags: [${tags.map(t => `"${t}"`).join(', ')}]`,
    `identifiers: [${identifiers.map(i => `"${i}"`).join(', ')}]`,
    'evidence:',
    '  injected: 0',
    '  reflected: 0',
    '  negative: 0',
    '  sessions: 0',
    '  reExtracted: 0',
    `created: "2026-05-18"`,
    `updated: "2026-05-18"`,
    'supersedes: null',
    'extractedBy: auto',
    '---',
    '## Context',
    'Test context.',
    '## Content',
    'Test content.',
  ].join('\n');
  fs.writeFileSync(path.join(TMP_SOLUTIONS, `${name}.md`), content);
}

afterAll(() => {
  console.log(`[test] tmp dir: ${TMP_HOME} (수동 정리 필요)`);
});

// ── 테스트 ────────────────────────────────────────────────────────────────
describe('observability-heuristic — acted_on signal', () => {

  it('1. prompt-keyword: surface 후 매칭 keyword prompt → acted_on 생성', async () => {
    const sessionId = 'sess-pk-1';
    createSolutionFile('tdd-pattern', ['tdd', 'typescript']);

    // surface emit (5분 이내)
    emitSolutionEvent({
      sessionId,
      solutionId: 'tdd-pattern',
      eventType: 'surfaced',
      signalSource: 'hook-prepend',
      ts: Date.now() - 60_000, // 1분 전
    });

    // solution-injector 의 detectActOnFromPriorSurface 로직을 직접 재현
    const surfaces = querySurfacedWithin(sessionId, 5);
    expect(surfaces.length).toBeGreaterThanOrEqual(1);

    const promptLower = 'tdd 방식으로 테스트를 작성해주세요';
    for (const surf of surfaces) {
      const filePath = path.join(TMP_SOLUTIONS, `${surf.solutionId}.md`);
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { parseSolutionV3 } = await import('../src/engine/solution-format.js');
      const sol = parseSolutionV3(raw);
      if (!sol) continue;
      const tags = sol.frontmatter.tags ?? [];
      const hit = tags.some(t => promptLower.includes(t.toLowerCase()));
      if (!hit) continue;
      emitSolutionEvent({
        sessionId,
        solutionId: surf.solutionId,
        eventType: 'acted_on',
        signalSource: 'prompt-keyword',
        signalScore: 0.20,
        meta: { surface_ts: surf.ts },
      });
    }

    const count = countEvents({ sessionId, solutionId: 'tdd-pattern', eventType: 'acted_on', signalSource: 'prompt-keyword' });
    expect(count).toBe(1);
  });

  it('2. prompt-keyword: 매칭 없으면 acted_on 미생성', async () => {
    const sessionId = 'sess-pk-2';
    createSolutionFile('docker-pattern', ['docker', 'container']);

    emitSolutionEvent({
      sessionId,
      solutionId: 'docker-pattern',
      eventType: 'surfaced',
      signalSource: 'hook-prepend',
      ts: Date.now() - 30_000,
    });

    const surfaces = querySurfacedWithin(sessionId, 5);
    const promptLower = 'typescript 타입을 수정해주세요'; // docker/container 없음
    for (const surf of surfaces) {
      const filePath = path.join(TMP_SOLUTIONS, `${surf.solutionId}.md`);
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { parseSolutionV3 } = await import('../src/engine/solution-format.js');
      const sol = parseSolutionV3(raw);
      if (!sol) continue;
      const tags = sol.frontmatter.tags ?? [];
      const hit = tags.some(t => promptLower.includes(t.toLowerCase()));
      if (!hit) continue;
      emitSolutionEvent({
        sessionId,
        solutionId: surf.solutionId,
        eventType: 'acted_on',
        signalSource: 'prompt-keyword',
        signalScore: 0.20,
      });
    }

    const count = countEvents({ sessionId, solutionId: 'docker-pattern', eventType: 'acted_on', signalSource: 'prompt-keyword' });
    expect(count).toBe(0);
  });

  it('3. tool-pattern: tool name 매칭 → acted_on emit', async () => {
    const sessionId = 'sess-tp-1';
    createSolutionFile('bash-pattern', ['bash', 'shell']);

    emitSolutionEvent({
      sessionId,
      solutionId: 'bash-pattern',
      eventType: 'surfaced',
      signalSource: 'hook-prepend',
      ts: Date.now() - 60_000,
    });

    const surfaces = querySurfacedWithin(sessionId, 5);
    const toolNameLower = 'bash'; // tool name 매칭
    for (const surf of surfaces) {
      const filePath = path.join(TMP_SOLUTIONS, `${surf.solutionId}.md`);
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { parseSolutionV3 } = await import('../src/engine/solution-format.js');
      const sol = parseSolutionV3(raw);
      if (!sol) continue;
      const tags = sol.frontmatter.tags ?? [];
      const hit = tags.some(t => toolNameLower.includes(t.toLowerCase()));
      if (!hit) continue;
      emitSolutionEvent({
        sessionId,
        solutionId: surf.solutionId,
        eventType: 'acted_on',
        signalSource: 'tool-pattern',
        signalScore: 0.30,
        meta: { tool: 'Bash', surface_ts: surf.ts },
      });
    }

    const count = countEvents({ sessionId, solutionId: 'bash-pattern', eventType: 'acted_on', signalSource: 'tool-pattern' });
    expect(count).toBe(1);
  });

  it('4. commit-diff: sha hash 12char prefix 검증', () => {
    const sessionId = 'sess-cd-1';
    const fakeSha = 'a1b2c3d4e5f6789012345678901234567890abcd';
    const shaHash = require('node:crypto').createHash('sha1').update(fakeSha).digest('hex').slice(0, 12);

    // sha hash 는 12자
    expect(shaHash).toHaveLength(12);
    expect(shaHash).toMatch(/^[0-9a-f]{12}$/);

    emitSolutionEvent({
      sessionId,
      solutionId: 'commit-sol',
      eventType: 'acted_on',
      signalSource: 'commit-diff',
      signalScore: 0.30,
      meta: { commit_sha_hash: shaHash, surface_ts: Date.now() },
    });

    const count = countEvents({ sessionId, solutionId: 'commit-sol', eventType: 'acted_on', signalSource: 'commit-diff' });
    expect(count).toBe(1);

    // meta 에서 sha hash 검증
    const db = openFreshDb();
    try {
      const row = db.prepare(
        `SELECT meta FROM solution_events WHERE session_id = ? AND solution_id = 'commit-sol'`
      ).get(sessionId) as { meta: string } | undefined;
      expect(row).toBeDefined();
      const meta = JSON.parse(row!.meta);
      expect(meta.commit_sha_hash).toBe(shaHash);
      expect(meta.commit_sha_hash).toHaveLength(12);
    } finally {
      db.close();
    }
  });

  it('5. compound-extract: body mention → acted_on emit', () => {
    const sessionId = 'sess-ce-1';
    createSolutionFile('existing-sol', ['existing', 'pattern']);

    emitSolutionEvent({
      sessionId,
      solutionId: 'existing-sol',
      eventType: 'acted_on',
      signalSource: 'compound-extract',
      signalScore: 0.20,
      meta: { new_solution: 'new-sol', via: 'body-mention' },
    });

    const count = countEvents({ sessionId, solutionId: 'existing-sol', eventType: 'acted_on', signalSource: 'compound-extract' });
    expect(count).toBe(1);

    // meta via 검증
    const db = openFreshDb();
    try {
      const row = db.prepare(
        `SELECT meta FROM solution_events WHERE session_id = ? AND solution_id = 'existing-sol' AND signal_source = 'compound-extract'`
      ).get(sessionId) as { meta: string } | undefined;
      expect(row).toBeDefined();
      const meta = JSON.parse(row!.meta);
      expect(meta.via).toBe('body-mention');
    } finally {
      db.close();
    }
  });

  it('6. compound-extract: supersedes → acted_on emit with via=supersedes', () => {
    const sessionId = 'sess-ce-2';

    emitSolutionEvent({
      sessionId,
      solutionId: 'old-sol',
      eventType: 'acted_on',
      signalSource: 'compound-extract',
      signalScore: 0.20,
      meta: { new_solution: 'new-sol-v2', via: 'supersedes' },
    });

    const db = openFreshDb();
    try {
      const row = db.prepare(
        `SELECT meta FROM solution_events WHERE session_id = ? AND solution_id = 'old-sol' AND signal_source = 'compound-extract'`
      ).get(sessionId) as { meta: string } | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(row!.meta).via).toBe('supersedes');
    } finally {
      db.close();
    }
  });

  it('7. dedup: 동일 (session, solution, source) 5분 내 중복 X', () => {
    const sessionId = 'sess-dedup-p2';
    const ts = Date.now();

    emitSolutionEvent({ sessionId, solutionId: 'dedup-sol', eventType: 'acted_on', signalSource: 'prompt-keyword', signalScore: 0.20, ts });
    emitSolutionEvent({ sessionId, solutionId: 'dedup-sol', eventType: 'acted_on', signalSource: 'prompt-keyword', signalScore: 0.20, ts: ts + 1000 });

    const count = countEvents({ sessionId, solutionId: 'dedup-sol', signalSource: 'prompt-keyword' });
    expect(count).toBe(1);
  });

  it('8. dedup: 다른 signal_source 는 별도 emit OK', () => {
    const sessionId = 'sess-dedup-p2-src';
    const ts = Date.now();

    emitSolutionEvent({ sessionId, solutionId: 'multi-src-sol', eventType: 'acted_on', signalSource: 'prompt-keyword', ts });
    emitSolutionEvent({ sessionId, solutionId: 'multi-src-sol', eventType: 'acted_on', signalSource: 'tool-pattern', ts: ts + 100 });
    emitSolutionEvent({ sessionId, solutionId: 'multi-src-sol', eventType: 'acted_on', signalSource: 'commit-diff', ts: ts + 200 });

    const count = countEvents({ sessionId, solutionId: 'multi-src-sol', eventType: 'acted_on' });
    expect(count).toBe(3);
  });

});
