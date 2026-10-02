/**
 * claude-mem 과의 계약 — forgen-eval 이 실제로 의존하는 것만 고정한다.
 *
 * 실측 근거 (2026-10-02, 격리 HOME 에서 claude-mem 13.12.4 와 13.28.0 을 각각 설치해 비교):
 *   - `claude-mem status` 는 꺼져 있을 때 "Worker is not running" 을 출력한다.
 *   - `claude-mem search` stdout 은 `{"content":[{"type":"text","text":"…| #1 | …"}]}`.
 *   - DB 컬럼 observations(id,title,narrative,text), session_summaries(id,request,learned,completed) 는 두 버전에서 동일.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectMemReadBackend, parseSearchHits, readMemFragments } from '../src/arms/mem-recall.js';
import { CLAUDE_MEM_TESTED_VERSION, parseWorkerRunning } from '../src/runners/worker-lifecycle.js';

// node:sqlite 는 Node 22.13+ 에서 플래그 없이 쓸 수 있다. 없는 런타임에서는 DB 테스트를 건너뛴다
// (정적 import 는 Node 20 에서 테스트 파일 전체의 로드를 실패시킨다).
const sqlite = await import('node:sqlite').catch(() => null);
const DatabaseSync = sqlite?.DatabaseSync as typeof import('node:sqlite').DatabaseSync;

/** 두 버전에서 실제로 받은 search 출력 (seed: observation #1 "zebraquartz retry policy") */
const REAL_SEARCH_OUTPUT = JSON.stringify({
  content: [{
    type: 'text',
    text: [
      'Found 1 result(s) matching "zebraquartz" (1 obs, 0 sessions, 0 prompts)',
      '',
      '### Oct 2, 2026',
      '',
      '**General**',
      '| ID | Time | T | Title | Read |',
      '|----|------|---|-------|------|',
      '| #1 | 9:13 AM | ○ | zebraquartz retry policy | ~25 |',
      '',
    ].join('\n'),
  }],
}, null, 2);

describe('parseWorkerRunning', () => {
  it('"Worker is not running" 을 실행 중으로 판정하지 않는다', () => {
    expect(parseWorkerRunning('Worker is not running')).toBe(false);
    expect(parseWorkerRunning('Worker stopped')).toBe(false);
    expect(parseWorkerRunning('')).toBe(false);
  });

  it('실행 중일 때의 실제 status 출력은 running', () => {
    expect(parseWorkerRunning('Worker is running\n  PID: 123\n  Port: 37701\n  Version: 13.28.0\n  Uptime: 6s')).toBe(true);
  });
});

describe('parseSearchHits', () => {
  it('실제 search 출력에서 observation id 를 뽑는다', () => {
    expect(parseSearchHits(REAL_SEARCH_OUTPUT)).toEqual([{ table: 'observations', id: 1 }]);
  });

  it('session summary 행(`#S12` — 13.x 포매터의 형태; 공백이 낀 `#S 12` 도 허용), 중복 제거, topN', () => {
    const out = JSON.stringify({ content: [{ text: '| #7 | a |\n| #S12 | b |\n| #S 13 | c |\n| #7 | dup |\n| #9 | d |' }] });
    expect(parseSearchHits(out, 10)).toEqual([
      { table: 'observations', id: 7 },
      { table: 'session_summaries', id: 12 },
      { table: 'session_summaries', id: 13 },
      { table: 'observations', id: 9 },
    ]);
    expect(parseSearchHits(out, 2)).toHaveLength(2);
  });

  it('결과 없음 / JSON 아님 / 형식 다름 → 빈 배열', () => {
    expect(parseSearchHits(JSON.stringify({ content: [{ type: 'text', text: 'No results found matching "x"' }] }))).toEqual([]);
    expect(parseSearchHits('not json')).toEqual([]);
    expect(parseSearchHits('{}')).toEqual([]);
  });
});

describe.skipIf(!sqlite)('readMemFragments (실 SQLite DB)', () => {
  function makeDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-eval-mem-'));
    const dbPath = path.join(dir, 'claude-mem.db');
    const db = new DatabaseSync(dbPath);
    // claude-mem 13.x 스키마 중 forgen-eval 이 읽는 컬럼
    db.exec(`CREATE TABLE observations (id INTEGER PRIMARY KEY, title TEXT, narrative TEXT, text TEXT);
             CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, request TEXT, learned TEXT, completed TEXT);`);
    db.prepare('INSERT INTO observations (id,title,narrative,text) VALUES (?,?,?,?)').run(1, 'zebraquartz retry policy', 'Retries use exponential backoff with jitter.', 'short');
    db.prepare('INSERT INTO observations (id,title,narrative,text) VALUES (?,?,?,?)').run(2, 'no narrative', null, 'fallback text');
    db.prepare('INSERT INTO session_summaries (id,request,learned,completed) VALUES (?,?,?,?)').run(5, 'fix flaky test', '한국어 학습 내용', 'done');
    db.close();
    return dbPath;
  }

  it('node:sqlite 가 있는 런타임에서는 그것을 쓴다 (sqlite3 CLI 없이도 recall 이 동작)', () => {
    expect(detectMemReadBackend()).toBe('node:sqlite');
  });

  it('observation 은 title + narrative, narrative 가 없으면 text; session summary 는 request/learned/completed', () => {
    const dbPath = makeDb();
    const out = readMemFragments(dbPath, [
      { table: 'observations', id: 1 },
      { table: 'observations', id: 2 },
      { table: 'session_summaries', id: 5 },
    ]);
    expect(out).toBe([
      '[#1]\nzebraquartz retry policy\nRetries use exponential backoff with jitter.',
      '[#2]\nno narrative\nfallback text',
      '[#S5]\nfix flaky test\n한국어 학습 내용\ndone',
    ].join('\n\n'));
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('없는 id / 없는 DB / hit 없음 은 빈 문자열, 한 조각은 600자로 자른다', () => {
    const dbPath = makeDb();
    expect(readMemFragments(dbPath, [{ table: 'observations', id: 999 }])).toBe('');
    expect(readMemFragments(dbPath, [])).toBe('');
    expect(readMemFragments(path.join(os.tmpdir(), 'nope', 'x.db'), [{ table: 'observations', id: 1 }])).toBe('');
    const db = new DatabaseSync(dbPath);
    db.prepare('INSERT INTO observations (id,title,narrative,text) VALUES (?,?,?,?)').run(3, 't', 'x'.repeat(2000), null);
    db.close();
    const long = readMemFragments(dbPath, [{ table: 'observations', id: 3 }]);
    expect(long.length).toBe('[#3]\n'.length + 600);
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('실제 search 출력 → hit → DB 본문까지 한 번에', () => {
    const dbPath = makeDb();
    expect(readMemFragments(dbPath, parseSearchHits(REAL_SEARCH_OUTPUT))).toContain('exponential backoff');
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });
});

describe('claude-mem 버전 핀', () => {
  it('CLAUDE_MEM_TESTED_VERSION 은 package.json 의 devDependency 핀과 같다 (따로 놀지 않게)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies['claude-mem']).toBe(CLAUDE_MEM_TESTED_VERSION);
    expect(pkg.devDependencies['claude-mem']).toMatch(/^\d+\.\d+\.\d+$/); // 범위가 아닌 정확한 핀
  });
});
