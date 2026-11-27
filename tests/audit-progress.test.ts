import { describe, expect, it } from 'vitest';
import { startProgress } from '../src/audit/judge.js';

const sink = (isTTY: boolean) => { const buf: string[] = []; return { buf, out: { isTTY, write: (s: string) => { buf.push(s); return true; } } }; };

describe('0.9.4 판정 진행 표시', () => {
  it('새로 물을 것이 있으면 시작 줄(개수·재사용·이어서 됨)과 끝 줄을 쓴다', () => {
    const { buf, out } = sink(false);
    const p = startProgress('n4-correction/2', 100, 40, out);
    for (let i = 0; i < 5; i++) p.tick(20);
    p.done();
    const all = buf.join('');
    expect(all).toContain('교정 찾기: 새로 판정할 것 100개 (저장된 판정 40개는 다시 묻지 않음)');
    expect(all).toContain('이어서 합니다');
    expect(all).toMatch(/교정 찾기 20\/100/);
    expect(all).toContain('교정 찾기 끝 (100개');
  });
  it('터미널이면 같은 줄을 고쳐 쓴다', () => {
    const { buf, out } = sink(true);
    const p = startProgress('n4-pair/9', 40, 0, out);
    p.tick(20);
    expect(buf.at(-1)).toMatch(/^\r\[forgen\] 같은 말인지 비교 20\/40/);
    p.done('claude 로그인 필요');
    expect(buf.at(-1)).toContain('멈춤 — claude 로그인 필요');
  });
  it('새로 물을 것이 없으면 아무것도 쓰지 않는다', () => {
    const { buf, out } = sink(true);
    const p = startProgress('n4-correction/2', 0, 500, out);
    p.done();
    expect(buf).toEqual([]);
  });
});
