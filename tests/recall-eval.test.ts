/** 0.8.0 M4: 회수 정답 표본 — 구간별 표본, 해시로 원문 복원, 게이트 판정, 점수(오너 라벨 우선). 모델 호출 없음. */
import { afterAll, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-recall-'));
process.env.FORGEN_HOME = path.join(HOME, '.forgen');
const st = path.join(HOME, '.forgen', 'state');
fs.mkdirSync(st, { recursive: true });
const h = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const prompts = ['배포 전에 마이그레이션을 확인해 줘', '도커 이미지 크기를 줄이는 방법', '테스트가 가끔 실패하는데 원인 찾아줘'];
const rel = [0.15, 0.25, 0.4];
fs.writeFileSync(path.join(st, 'match-eval-log.jsonl'), prompts.map((p, i) => JSON.stringify({ source: 'hook', rawQueryHash: h(p), ts: new Date(Date.UTC(2026, 10, 20, 0, i)).toISOString(), candidates: [{ name: `sol-${i}`, relevance: rel[i] }] })).join('\n') + '\n');
const proj = path.join(HOME, 'projects', 'p');
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, 'S.jsonl'), prompts.slice(0, 2).map((p) => JSON.stringify({ type: 'user', message: { role: 'user', content: p } })).join('\n') + '\n');
const obs = await import('../src/core/observability-store.js');
obs.recordGateVerdict({ solutionId: 'sol-2', gate: 'passed', ts: Date.UTC(2026, 10, 20, 0, 2) });
const m = await import('../src/core/recall-eval.js');
afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

describe('M4 회수 정답 표본', () => {
  it('구간별로 뽑고, 대화 기록에서 원문을 되찾고, 그때의 게이트 통과를 붙인다', () => {
    const items = m.buildRecallSample(3, path.join(HOME, 'projects'));
    expect(items.map((i) => i.band).sort()).toEqual(['high', 'low', 'mid']);
    expect(items.filter((i) => i.prompt).length).toBe(2);
    expect(items.find((i) => i.band === 'high')?.passed).toEqual(['sol-2']);
    expect(fs.statSync(path.join(HOME, '.forgen', 'eval', 'recall-sample.jsonl')).mode & 0o777).toBe(0o600);
  });
  it('점수는 오너 라벨을 우선하고 원문 없는 항목은 뺀다', () => {
    const items = m.readRecallSample().map((i) => (i.band === 'low' ? { ...i, model: 'sol-0', owner: 'none' } : i.band === 'mid' ? { ...i, model: 'sol-1' } : { ...i, model: 'sol-2' }));
    const s = m.scoreRecall(items);
    expect(s.judged).toBe(2); // high 는 원문이 없어 제외
    expect(s.ownerJudged).toBe(1);
    expect(s.recall).toBe(0); // mid 의 도움 될 솔루션을 게이트가 통과시키지 않음
  });
});
