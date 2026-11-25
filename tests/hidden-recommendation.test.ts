/** 0.9.0 추천 숨김 표본 — 고르기·숨기기·원장 기록·훅 출력(permissionDecision 없음). */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-hidden-'));
process.env.FORGEN_HOME = path.join(HOME, '.forgen');
const h = await import('../src/core/hidden-recommendation.js');
const m = await import('../src/core/decision-ledger.js');
afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

const q = (question: string, labels: string[], multiSelect = false) => ({ question, header: 'h', multiSelect, options: labels.map((label) => ({ label, description: 'd' })) });
/** isSampled 가 참인 tool_use_id 를 찾는다(결정적). */
function sampledId(prefix: string, idx = 0): string { for (let i = 0; ; i++) if (h.isSampled(`${prefix}${i}`, idx)) return `${prefix}${i}`; }
function unsampledId(prefix: string, idx = 0): string { for (let i = 0; ; i++) if (!h.isSampled(`${prefix}${i}`, idx)) return `${prefix}${i}`; }

describe('고르기', () => {
  it('약 5번에 1번(결정적)', () => {
    let n = 0; for (let i = 0; i < 2000; i++) if (h.isSampled(`toolu_${i}`, 0)) n++;
    expect(n).toBeGreaterThan(330); expect(n).toBeLessThan(470);
    expect(h.isSampled('toolu_x', 0)).toBe(h.isSampled('toolu_x', 0));
  });
  it('되돌리기 어려운 질문·복수 선택·추천 없음·추천 둘은 고르지 않는다', () => {
    expect(h.eligible(q('점심 메뉴?', ['김치찌개 (추천)', '라면']))).toBe(true);
    expect(h.eligible(q('npm 에 배포할까요?', ['지금 배포 (추천)', '보류']))).toBe(false);
    expect(h.eligible(q('브랜치를 push 할까요?', ['push (추천)', '보류']))).toBe(false);
    expect(h.eligible(q('여럿?', ['A (추천)', 'B'], true))).toBe(false);
    expect(h.eligible(q('추천 없음', ['A', 'B']))).toBe(false);
    expect(h.eligible(q('둘', ['A (추천)', 'B (Recommended)']))).toBe(false);
  });
});

describe('숨기기', () => {
  it('뽑힌 질문만 추천 표시를 떼고 섞고 머리말을 바꾼다, 나머지는 그대로', () => {
    const id = sampledId('t', 0);
    const input = { questions: [q('점심?', ['김치찌개 (추천)', '라면', '샐러드']), q('저녁?', ['밥 (추천)', '면'])] };
    const r = h.hideRecommendations(input, id)!;
    expect(r).not.toBeNull();
    expect(r.hidden).toContain(0);
    const shown = (r.input.questions as Array<{ header: string; options: Array<{ label: string }> }>)[0];
    expect(shown.header).toBe(h.HIDDEN_HEADER);
    expect(shown.options.map((o) => o.label).sort()).toEqual(['김치찌개', '라면', '샐러드']);
    expect(shown.options.map((o) => o.label)).not.toEqual(['김치찌개', '라면', '샐러드']);
    if (!r.hidden.includes(1)) expect((r.input.questions as unknown[])[1]).toEqual(input.questions[1]);
    expect(input.questions[0].options[0].label).toBe('김치찌개 (추천)'); // 원본은 건드리지 않는다
  });
  it('안 뽑히면 null, tool_use_id 없으면 null, FORGEN_HIDDEN_SAMPLE=0 이면 null', () => {
    const input = { questions: [q('점심?', ['김치찌개 (추천)', '라면'])] };
    expect(h.hideRecommendations(input, unsampledId('u', 0))).toBeNull();
    expect(h.hideRecommendations(input, undefined)).toBeNull();
    expect(h.hideRecommendations(input, sampledId('t', 0), { FORGEN_HIDDEN_SAMPLE: '0' })).toBeNull();
  });
});

describe('원장 기록 — 실제 대화 기록 모양(원본 입력 + toolUseResult 에 보인 질문)', () => {
  it('숨긴 추천과 같은 답 / 다른 답 / 직접 입력, 그리고 점수', () => {
    const file = path.join(HOME, 'projects', 'p', 'H1.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const orig = [q('점심?', ['김치찌개 (추천)', '라면', '샐러드'])];
    const shown = [{ ...q('점심?', ['샐러드', '라면', '김치찌개']), header: h.HIDDEN_HEADER }];
    const line = (id: string, ans: string) => [
      JSON.stringify({ timestamp: '2026-11-25T00:00:00Z', cwd: '/w', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: orig } }] } }),
      JSON.stringify({ timestamp: 't', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id }] }, toolUseResult: { questions: shown, answers: { '점심?': ans }, annotations: {} } }),
    ].join('\n');
    fs.writeFileSync(file, [line('a1', '김치찌개'), line('a2', '라면'), line('a3', '아무거나')].join('\n') + '\n');
    expect(m.collectDecisions(file, 'H1')).toBe(3);
    const recs = m.readDecisions().filter((d) => d.session === 'H1');
    expect(recs.map((d) => d.kind)).toEqual(['hidden-accept', 'hidden-override', 'free']);
    expect(recs[0].hidden).toBe(true);
    expect(recs[0].hiddenRecommended).toEqual(['김치찌개']);
    expect(recs[0].options).toEqual(['샐러드', '라면', '김치찌개']);
    expect(recs[0].recommended).toEqual([]);
    const s = m.scoreDecisions(Date.parse('2026-11-24T00:00:00Z'));
    expect(s.hiddenN).toBe(3);
    expect(s.hiddenRate).toBeCloseTo(1 / 3);
    expect(s.judgeable).toBe(false);
  });
});

const DIST = path.resolve('dist');
describe.skipIf(!fs.existsSync(path.join(DIST, 'hooks', 'pre-tool-use.js')))('실제 훅 출력', () => {
  it('뽑힌 질문: updatedInput 만 있고 permissionDecision 은 없다(있으면 화면이 건너뛰어진다)', () => {
    const id = sampledId('toolu_hook', 0);
    const payload = { session_id: 'hs1', cwd: HOME, tool_name: 'AskUserQuestion', tool_use_id: id, tool_input: { questions: [q('점심?', ['김치찌개 (추천)', '라면'])] } };
    const r = spawnSync(process.execPath, [path.join(DIST, 'hooks', 'pre-tool-use.js')], { input: JSON.stringify(payload), encoding: 'utf-8', env: { ...process.env, HOME, FORGEN_HOME: path.join(HOME, '.forgen') }, timeout: 30000 });
    const out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
    expect(out.hookSpecificOutput?.updatedInput?.questions?.[0]?.header).toBe(h.HIDDEN_HEADER);
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });
  it('안 뽑힌 질문: 입력을 바꾸지 않는다', () => {
    const id = unsampledId('toolu_hook', 0);
    const payload = { session_id: 'hs2', cwd: HOME, tool_name: 'AskUserQuestion', tool_use_id: id, tool_input: { questions: [q('점심?', ['김치찌개 (추천)', '라면'])] } };
    const r = spawnSync(process.execPath, [path.join(DIST, 'hooks', 'pre-tool-use.js')], { input: JSON.stringify(payload), encoding: 'utf-8', env: { ...process.env, HOME, FORGEN_HOME: path.join(HOME, '.forgen') }, timeout: 30000 });
    const out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
    expect(out.hookSpecificOutput?.updatedInput).toBeUndefined();
  });
});
