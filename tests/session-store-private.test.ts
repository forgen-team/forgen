/**
 * session-store W2-5 통합 테스트 — <private> 범위가 FTS 인덱스로 새어
 * session-search 에 노출되지 않는지 실측 검증 (flow-reviewer SEV-2 회귀).
 *
 * node:sqlite 런타임 필요. FORGEN_HOME 을 임시 디렉터리로 격리한다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TMP = path.join(os.tmpdir(), 'forgen-test-session-store-private');

describe('session-store <private> 제외 (W2-5)', () => {
  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    vi.resetModules();
    process.env.FORGEN_HOME = TMP;
  });

  afterEach(() => {
    delete process.env.FORGEN_HOME;
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('private 범위는 FTS 인덱싱되지 않아 search 로 나오지 않는다', async () => {
    const { indexSession, searchSessions } = await import('../src/core/session-store.js');

    const transcript = path.join(TMP, 'transcript.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', content: 'public marker PUBLICTOKEN123 in the clear' }),
      JSON.stringify({ type: 'user', content: 'here is <private>PRIVATESECRET999 do not index</private> tail' }),
    ];
    fs.writeFileSync(transcript, lines.join('\n'));

    await indexSession(TMP, transcript, 'sess-priv-1');

    const publicHits = searchSessions('PUBLICTOKEN123', 10);
    const privateHits = searchSessions('PRIVATESECRET999', 10);

    // 공개 토큰은 인덱싱됨(정상 동작 회귀 방지), 비공개 토큰은 나오면 안 됨.
    expect(publicHits.length).toBeGreaterThan(0);
    expect(privateHits.length).toBe(0);
  });

  it('통째 private 메시지는 인덱싱 자체가 스킵된다', async () => {
    const { indexSession, searchSessions } = await import('../src/core/session-store.js');

    const transcript = path.join(TMP, 'transcript2.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', content: '<private>ENTIRELYSECRET777</private>' }),
    ];
    fs.writeFileSync(transcript, lines.join('\n'));

    await indexSession(TMP, transcript, 'sess-priv-2');
    expect(searchSessions('ENTIRELYSECRET777', 10).length).toBe(0);
  });
});
