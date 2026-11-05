import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const j = (o: unknown) => JSON.stringify(o);

async function load() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  process.env.FORGEN_HOME = home;
  vi.resetModules();
  const store = await import('../src/core/session-store.js');
  return { store, home };
}

describe('sessions.db 증분 인덱싱 (D9)', () => {
  it('실제 Claude 스키마(message.content)를 읽고, 재실행해도 중복 없고, 자란 부분만 추가한다', async () => {
    const { store, home } = await load();
    const t = path.join(home, 't.jsonl');
    fs.writeFileSync(t, [
      j({ type: 'user', message: { role: 'user', content: '캐시무효화 전략을 어떻게 할까' } }),
      j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '버전 키를 붙입니다' }] } }),
      j({ type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: 주입본문유니크' } }),
    ].join('\n') + '\n');

    const r1 = await store.indexTranscript('/proj', t, 'sess-1');
    expect(r1?.added).toBe(2);
    const r2 = await store.indexTranscript('/proj', t, 'sess-1');
    expect(r2?.added).toBe(0);

    fs.appendFileSync(t, j({ type: 'user', message: { role: 'user', content: '그다음 새발화유니크' } }) + '\n');
    const r3 = await store.indexTranscript('/proj', t, 'sess-1');
    expect(r3?.added).toBe(1);

    expect(store.searchSessions('캐시무효화').length).toBe(1);
    expect(store.searchSessions('새발화유니크').length).toBe(1);
    expect(store.searchSessions('주입본문유니크').length).toBe(0); // 주입 텍스트는 색인하지 않는다
    expect(store.searchSessions('버전').length).toBe(1);
  });

  it('Codex 스키마도 같은 경로로 인덱싱', async () => {
    const { store, home } = await load();
    const t = path.join(home, 'c.jsonl');
    fs.writeFileSync(t, [
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '코덱스질문유니크' }] } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '코덱스답유니크' }] } }),
    ].join('\n') + '\n');
    expect((await store.indexTranscript('/p', t, 'cx-1'))?.added).toBe(2);
    expect((await store.indexTranscript('/p', t, 'cx-1'))?.added).toBe(0);
    expect(store.searchSessions('코덱스답유니크').length).toBe(1);
  });

  it('<private> 범위는 색인하지 않는다', async () => {
    const { store, home } = await load();
    const t = path.join(home, 'p.jsonl');
    fs.writeFileSync(t, j({ type: 'user', message: { role: 'user', content: '공개문장 <private>비밀문장유니크</private>' } }) + '\n');
    await store.indexTranscript('/p', t, 'pv');
    expect(store.searchSessions('공개문장').length).toBe(1);
    expect(store.searchSessions('비밀문장유니크').length).toBe(0);
  });
});
