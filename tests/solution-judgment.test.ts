/** 0.8.0 M3: 솔루션 사용 판정 — 노출된 솔루션만, 인용 검사 통과분만 기록(카운터 반영 없음). */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-judge-'));
process.env.FORGEN_HOME = path.join(HOME, '.forgen');
const sol = path.join(HOME, '.forgen', 'me', 'solutions');
fs.mkdirSync(sol, { recursive: true });
fs.writeFileSync(path.join(sol, 'isolated-copy-first.md'), '---\nname: "isolated-copy-first"\nversion: 1\nstatus: "candidate"\nconfidence: 0.5\ntype: "pattern"\nscope: "me"\ntags: ["a"]\nidentifiers: []\nevidence:\n  injected: 0\n  reflected: 0\n  negative: 0\n  sessions: 0\n  reExtracted: 0\ncreated: "2026-11-01"\nupdated: "2026-11-01"\nsupersedes: null\nextractedBy: "auto"\n---\n\n## Context\nc\n\n## Content\n실데이터 대신 복사본에서 먼저 실험한다.\n');
const m = await import('../src/engine/solution-judgment.js');
afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

const summary = '[user] 실데이터 말고 복사본으로 먼저 돌려 보고 결과를 보여 줘\n[assistant] 복사본에서 돌린 결과 원본과 차이가 없었습니다';
describe('M3 사용 판정', () => {
  it('노출된 솔루션이 없으면 판정 요청을 붙이지 않는다', () => expect(m.judgmentPromptSection([])).toBe(''));
  it('노출된 솔루션은 이름·한 줄과 함께 목록에 오른다', () => {
    const s = m.judgmentPromptSection(['isolated-copy-first', 'gone']);
    expect(s).toContain('isolated-copy-first: 실데이터 대신 복사본에서');
    expect(s).not.toContain('gone');
  });
  it('인용이 요약에 있고 노출된 솔루션인 판정만 기록한다', () => {
    const out = [
      'forgen judge "isolated-copy-first" "used" "assistant" "복사본에서 돌린 결과 원본과 차이가 없었습니다"',
      'forgen judge "isolated-copy-first" "wrong" "user" "대화에 없던 지어낸 문장이 여기에 있다"',
      'forgen judge "never-shown" "used" "user" "실데이터 말고 복사본으로 먼저 돌려 보고"',
    ].join('\n');
    expect(m.recordJudgments(out, summary, 'S1', ['isolated-copy-first'])).toEqual({ recorded: 1, dropped: 2 });
    expect(m.summarizeJudgments()).toEqual({ used: 1, ignored: 0, wrong: 0 });
  });
});
