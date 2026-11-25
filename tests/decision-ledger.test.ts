/** 0.8.0 결정 원장 수집 — 실제 형식의 대화 기록 픽스처로 결정적 추출을 검증한다(모델 호출 없음). */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-decisions-'));
process.env.FORGEN_HOME = path.join(HOME, '.forgen');
const m = await import('../src/core/decision-ledger.js');
afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

const q = (question: string, labels: string[], multiSelect = false) => ({ question, header: 'h', multiSelect, options: labels.map((label) => ({ label, description: 'd' })) });
const ask = (id: string, ts: string, questions: unknown[]) => JSON.stringify({ timestamp: ts, cwd: '/w/x', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] } });
const res = (id: string, answers: Record<string, string> | null) => JSON.stringify({ timestamp: 't', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Your questions have been answered' }] }, toolUseResult: answers ? { questions: [], answers } : null });

const projects = path.join(HOME, 'projects');
const file = path.join(projects, 'p', 'S1.jsonl');
fs.mkdirSync(path.dirname(file), { recursive: true });

describe('결정 원장', () => {
  it('분류: 추천 그대로 / 다르게 / 직접 입력 / 복수 / 추천 없음, 답 없는 사본은 답 있는 사본을 기다린다', () => {
    fs.writeFileSync(file, [
      ask('t1', '2026-11-20T00:00:00Z', [q('Q1', ['A (추천)', 'B']), q('Q2', ['A (추천)', 'B']), q('Q3', ['A (추천)', 'B'])]),
      res('t1', null), // 답이 빠진 사본이 먼저 온다
      res('t1', { Q1: 'A (추천)', Q2: 'B', Q3: '둘 다 아니고 C 로 해 줘' }),
      ask('t2', '2026-11-21T00:00:00Z', [q('Q4', ['X', 'Y'], true), q('Q5', ['X', 'Y'])]),
      res('t2', { Q4: 'X, Y', Q5: 'Y' }),
    ].join('\n') + '\n');
    expect(m.collectDecisions(file, 'S1')).toBe(5);
    const kinds = Object.fromEntries(m.readDecisions().map((d) => [d.question, d.kind]));
    expect(kinds).toEqual({ Q1: 'accept', Q2: 'override', Q3: 'free', Q4: 'multi', Q5: 'no-recommendation' });
    const d1 = m.readDecisions().find((d) => d.question === 'Q1')!;
    expect(d1).toMatchObject({ options: ['A (추천)', 'B'], recommended: ['A (추천)'], cwd: '/w/x', session: 'S1' });
  });
  it('증분: 다시 읽어도 중복 없음, 이어 쓴 줄만 읽고, 답이 다음 실행에 와도 잡는다', () => {
    expect(m.collectDecisions(file, 'S1')).toBe(0);
    fs.appendFileSync(file, ask('t3', '2026-11-22T00:00:00Z', [q('Q6', ['A (추천)', 'B'])]) + '\n');
    expect(m.collectDecisions(file, 'S1')).toBe(0); // 아직 답이 없다
    fs.appendFileSync(file, res('t3', { Q6: 'B' }) + '\n');
    expect(m.collectDecisions(file, 'S1')).toBe(1);
    expect(m.readDecisions().find((d) => d.question === 'Q6')?.kind).toBe('override');
  });
  it('세션 끝(final)에 끝내 답이 없으면 unanswered', () => {
    fs.appendFileSync(file, ask('t4', '2026-11-23T00:00:00Z', [q('Q7', ['A (추천)'])]) + '\n' + res('t4', null) + '\n');
    expect(m.collectDecisions(file, 'S1', { final: true })).toBe(1);
    expect(m.readDecisions().find((d) => d.question === 'Q7')?.kind).toBe('unanswered');
  });
  it('소급은 한 번만, 서브에이전트 폴더는 제외', () => {
    const sub = path.join(projects, 'p', 'S2', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), ask('ts', '2026-11-24T00:00:00Z', [q('SUB', ['A'])]) + '\n' + res('ts', { SUB: 'A' }) + '\n');
    fs.writeFileSync(path.join(projects, 'p', 'S3.jsonl'), ask('t5', '2026-11-24T00:00:00Z', [q('Q8', ['A (추천)'])]) + '\n' + res('t5', { Q8: 'A (추천)' }) + '\n');
    expect(m.backfillDecisionsOnce(projects)).toBe(1);
    expect(m.backfillDecisionsOnce(projects)).toBeNull();
    expect(m.readDecisions().some((d) => d.question === 'SUB')).toBe(false);
    expect(m.summarizeDecisions()).toMatchObject({ accept: 2, override: 2, free: 1, multi: 1, 'no-recommendation': 1, unanswered: 1 });
  });
  it('소급: 같은 질문이 이어하기·포크로 두 파일에 있으면, 답 없는 사본 파일이 먼저여도 답 있는 사본이 이긴다', () => {
    const P2 = path.join(HOME, 'projects2', 'p');
    fs.mkdirSync(P2, { recursive: true });
    fs.writeFileSync(path.join(P2, 'A-first.jsonl'), ask('tf', '2026-11-25T00:00:00Z', [q('FORK', ['A (추천)', 'B'])]) + '\n' + res('tf', null) + '\n');
    fs.writeFileSync(path.join(P2, 'B-second.jsonl'), ask('tf', '2026-11-25T00:00:00Z', [q('FORK', ['A (추천)', 'B'])]) + '\n' + res('tf', { FORK: 'B' }) + '\n');
    fs.rmSync(path.join(HOME, '.forgen', 'state', 'decisions-backfill-done'), { force: true });
    m.backfillDecisionsOnce(path.join(HOME, 'projects2'));
    const fork = m.readDecisions().filter((d) => d.question === 'FORK');
    expect(fork.map((d) => d.kind)).toEqual(['override']);
  });
  it('결정 파일은 내보내기 대상(solutions·rules·behavior)이 아니다', async () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'engine', 'compound-export.ts'), 'utf-8');
    expect(src).toMatch(/KNOWLEDGE_DIRS = \['solutions', 'rules', 'behavior'\]/);
  });
});
