/**
 * 0.9.0: 교정 원장의 같은 뜻 판정 교체 — 0.3 유사도(거짓 재발) 대신 훅에서는 후보만 적고(pending) 러너가 쌍 판정.
 * 모델은 가짜 claude(tests/helpers/fake-claude-judge.ts). 임시 HOME·FORGEN_HOME 안에서만 쓴다. 문장은 전부 합성.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installFakeJudge, readJudgeCalls } from './helpers/fake-claude-judge.js';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-ledger-judge-')));
const HOME = path.join(ROOT, 'home');
const FH = path.join(HOME, '.forgen');
const BIN = path.join(ROOT, 'bin');
const FAKE = path.join(ROOT, 'fake');
fs.mkdirSync(FAKE, { recursive: true });
fs.mkdirSync(path.join(HOME, 'repo', '.git'), { recursive: true });
installFakeJudge(BIN);
const PREV = { HOME: process.env.HOME, FORGEN_HOME: process.env.FORGEN_HOME, PATH: process.env.PATH, FAKE_STATE: process.env.FAKE_STATE };
process.env.HOME = HOME;
process.env.FORGEN_HOME = FH;
process.env.FAKE_STATE = FAKE;
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const { classifyCorrection, recordCorrectionClass, readLedger, summarizeLedger, pendingEntries } = await import('../src/core/correction-ledger.js');
const { resolvePendingCorrections } = await import('../src/core/correction-ledger-judge.js');
const { markSessionStartScope } = await import('../src/core/project-switch.js');
const { createRule, saveRule } = await import('../src/store/rule-store.js');

afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const mk = (policy: string) => { const r = createRule({ category: 'workflow', scope: 'me', trigger: 't', policy, strength: 'default', source: 'explicit_correction', render_key: `k.${policy.length}.${policy.slice(-4)}` }); saveRule(r); return r; };

describe('교정 원장 — pending → 러너 쌍 판정', () => {
  const same = mk('작업 결과를 보고할 때는 tq01 기준으로 확인한 것과 못 한 것을 나눠서 적는다');
  const decoy = mk('작업 결과를 보고할 때는 tq02 기준으로 표 형식을 먼저 보여 준다');

  it('훅 경로: 확정 일치가 없으면 어휘 후보만 적고 모델을 부르지 않는다', () => {
    markSessionStartScope('S1', path.join(HOME, 'repo'), [same.rule_id, decoy.rule_id]);
    const before = readJudgeCalls(FAKE).length;
    const e = classifyCorrection({ sessionId: 'S1', evidenceId: 'ev1', policy: '보고할 때 tq01 기준으로 확인한 것과 못 한 것을 나눠 적어라', renderKey: 'x.ev1', project: null });
    expect(readJudgeCalls(FAKE).length).toBe(before);
    expect(e.class).toBe('pending');
    expect(e.deliveryKnown).toBe(true);
    expect(e.candidates?.map((c) => c.rule_id)).toContain(same.rule_id);
    expect(e.candidates?.find((c) => c.rule_id === same.rule_id)?.delivered).toBe(true);
    recordCorrectionClass(e);
    // 문장은 비슷하지만 뜻이 다른 교정(예전 0.3 유사도가 재발로 세던 것)
    const e2 = classifyCorrection({ sessionId: 'S1', evidenceId: 'ev2', policy: '작업 결과를 보고할 때는 tq03 기준으로 링크를 맨 위에 둔다', renderKey: 'x.ev2', project: null });
    expect(e2.class).toBe('pending');
    recordCorrectionClass(e2);
    // 정규화 문장 일치는 그 자리에서 확정
    const e3 = classifyCorrection({ sessionId: 'S1', evidenceId: 'ev3', policy: same.policy, renderKey: 'x.ev3', project: null });
    expect(e3).toMatchObject({ class: 'recurrence', match: { rule_id: same.rule_id, via: 'normalized' } });
    recordCorrectionClass(e3);
    expect(summarizeLedger()).toMatchObject({ pending: 2, recurrence: 1 });
  });

  it('러너: 쌍 판정(순서 바꿔 두 번)으로 해결 줄을 덧붙이고, 원장 읽기가 접어 넣는다', async () => {
    const r = await resolvePendingCorrections();
    expect(r).toMatchObject({ resolved: 2, left: 0 });
    const rows = readLedger();
    expect(rows.find((x) => x.evidence === 'ev1')).toMatchObject({ class: 'recurrence', match: { rule_id: same.rule_id, via: 'judge' } });
    expect(rows.find((x) => x.evidence === 'ev2')?.class).toBe('new'); // 거짓 재발이 아님
    expect(rows.find((x) => x.evidence === 'ev1')?.candidates).toBeUndefined();
    expect(summarizeLedger()).toMatchObject({ pending: 0, recurrence: 2, new: 1 });
    expect(readJudgeCalls(FAKE).every((c) => c.startsWith('pair '))).toBe(true);
    // 다시 돌려도 판정할 것이 없다
    expect(await resolvePendingCorrections()).toEqual({ resolved: 0, left: 0 });
  });

  it('모델을 못 부르면 pending 그대로(다음 실행에 다시)', async () => {
    const e = classifyCorrection({ sessionId: 'S1', evidenceId: 'ev4', policy: '보고할 때 tq02 기준으로 표 형식을 먼저 보여 줘라 다시', renderKey: 'x.ev4', project: null });
    recordCorrectionClass(e);
    process.env.FAKE_DOWN = '1';
    try {
      const r = await resolvePendingCorrections();
      expect(r.resolved).toBe(0);
      expect(pendingEntries().map((x) => x.evidence)).toEqual(['ev4']);
    } finally { delete process.env.FAKE_DOWN; }
    // 모델이 돌아오면 그때 판정한다
    expect((await resolvePendingCorrections()).resolved).toBe(1);
    expect(readLedger().find((x) => x.evidence === 'ev4')).toMatchObject({ class: 'recurrence', match: { rule_id: decoy.rule_id } });
  });
});
