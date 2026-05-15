/**
 * v0.4.8 (A1): Codex transcript FTS5 인덱싱 round-trip.
 *
 * SQLite 의존 (Node 22+ node:sqlite). 미지원 시 openDb() null → 함수 silent
 * return 이라 테스트도 skip 처리.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let sandbox: string;
let originalHome: string | undefined;

function hasNodeSqlite(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-codex-fts-'));
  originalHome = process.env.FORGEN_HOME;
  process.env.FORGEN_HOME = sandbox;
  // session-store / paths 가 모듈 로드 시점에 DB_PATH/FORGEN_HOME 을 잡으므로,
  // 매 케이스마다 fresh import 로 sandbox 가 반영되게 한다.
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.FORGEN_HOME;
  else process.env.FORGEN_HOME = originalHome;
});

describe('A1: Codex transcript FTS5 round-trip', () => {
  it.skipIf(!hasNodeSqlite())('Codex transcript 를 인덱싱하고 검색으로 회수 가능', async () => {
    const transcriptPath = path.join(sandbox, 'rollout-2026-05-15-codex-fts-test.jsonl');
    const codexLines = [
      // session-meta / event_msg 같은 다른 entry 는 skip 되어야.
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-fts-test' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'UNIQUEMARKER_USER_PROMPT codex fts indexing 확인' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'UNIQUEMARKER_ASSISTANT_REPLY 답변' }],
        },
      }),
      // malformed line — skip.
      'not-json-broken',
    ];
    fs.writeFileSync(transcriptPath, codexLines.join('\n'));

    const store = await import('../src/core/session-store.js');
    await store.indexCodexSession(sandbox, transcriptPath, 'codex-fts-test');

    const hits = store.searchSessions('UNIQUEMARKER_USER_PROMPT', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain('UNIQUEMARKER_USER_PROMPT');

    const hitsAssistant = store.searchSessions('UNIQUEMARKER_ASSISTANT_REPLY', 5);
    expect(hitsAssistant.length).toBeGreaterThan(0);
    expect(hitsAssistant[0].role).toBe('assistant');
  });

  it.skipIf(!hasNodeSqlite())('동일 sessionId 재인덱싱은 idempotent (중복 insert 없음)', async () => {
    const transcriptPath = path.join(sandbox, 'rollout-2026-05-15-codex-idem.jsonl');
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'IDEM_MARKER message' }] },
      }),
    );

    const store = await import('../src/core/session-store.js');
    await store.indexCodexSession(sandbox, transcriptPath, 'codex-idem-test');
    await store.indexCodexSession(sandbox, transcriptPath, 'codex-idem-test'); // 두 번째 호출.

    const hits = store.searchSessions('IDEM_MARKER', 5);
    expect(hits.length).toBe(1);
  });
});
