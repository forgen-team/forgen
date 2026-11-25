/**
 * 0.9.0 C2 모델 판정 검사 — docs/plans/2026-11-25-v1.0-plan.md §4.1(같은 뜻 중복·부딪힘·섞임 확정), §2.4, §1.2 N2.
 * 합성 A·B·C(§12.1-4)에 심은 문제를 찾는지(재현율 ≥ 80%) · 결정성(캐시) · --no-model · 검수(--kind) 를 본다.
 * 모델은 가짜 claude(tests/helpers/fake-claude-judge.ts). 모든 파일은 임시 HOME·FORGEN_HOME 안.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installFakeJudge, readJudgeCalls } from './helpers/fake-claude-judge.js';
import { addRules, buildFixture } from './helpers/audit-fixture.js';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-amodel-')));
const BIN = path.join(ROOT, 'bin');
const FAKE = path.join(ROOT, 'fake-state');
fs.mkdirSync(FAKE, { recursive: true });
installFakeJudge(BIN);
const FX = buildFixture(ROOT);
const PREV = { HOME: process.env.HOME, FORGEN_HOME: process.env.FORGEN_HOME, FORGEN_CWD: process.env.FORGEN_CWD, PATH: process.env.PATH, FAKE_STATE: process.env.FAKE_STATE };
process.env.HOME = FX.home;
process.env.FORGEN_HOME = FX.forgenHome;
process.env.FAKE_STATE = FAKE;
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
delete process.env.FORGEN_CWD;

const { runAudit, resultDigest } = await import('../src/audit/run.js');
const { runModelChecks, attachModelChecks, pairCandidates, groupPairs } = await import('../src/audit/model-checks.js');
const { Judge, CHECK_MODEL } = await import('../src/audit/judge.js');
const { topLines, renderAuditHtml } = await import('../src/audit/html.js');
const { handleAudit } = await import('../src/audit/cli.js');
const { buildKindSample, writeKindReview, importReview, scoreReviews, buildReviewSample } = await import('../src/audit/review.js');
const { createRule, saveRule } = await import('../src/store/rule-store.js');

beforeAll(() => {
  addRules(createRule as never, saveRule as never, path.join(FX.forgenHome, 'me', 'rules', 'broken.json'));
});
afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const audit = async (judge = new Judge({ model: true })) => {
  const run = runAudit({ folders: FX.folders, claudeDir: FX.claude });
  const mc = await runModelChecks(run.result, run.ctx, judge);
  attachModelChecks(run, mc, resultDigest);
  return { run, mc, judge };
};

describe('모델 판정 검사 — 합성 A·B·C', () => {
  it('심은 같은 뜻 중복·부딪힘·섞임을 찾는다(재현율 ≥ 80%), 일반 원칙은 섞임이 아니다', async () => {
    const { run, mc } = await audit();
    const tagOf = (re: RegExp, p: { a: { text: string }; b: { text: string } }) => (p.a.text.match(re) ?? p.b.text.match(re) ?? [''])[0];
    const dupFound = new Set(mc.dup.filter((p) => p.verdict === 'yes').map((p) => tagOf(/dq\d\d/, p)));
    const conFound = new Set(mc.conflict.filter((p) => p.verdict === 'yes').map((p) => tagOf(/cq\d\d/, p)));
    const recall = (found: Set<string>, planted: string[]) => planted.filter((t) => found.has(t)).length / planted.length;
    expect(recall(dupFound, FX.planted.dup)).toBeGreaterThanOrEqual(0.8);
    expect(recall(conFound, FX.planted.conflict)).toBeGreaterThanOrEqual(0.8);
    // 짝이 아닌 것은 예가 아니다(정밀도): 예 쌍은 모두 같은 표지를 가진다
    for (const p of mc.dup.filter((x) => x.verdict === 'yes')) expect(p.a.text.match(/dq\d\d/)?.[0]).toBe(p.b.text.match(/dq\d\d/)?.[0]);
    // 섞임: [[MIX]] 3개 확정, [[GEN]](일반 원칙)은 섞임 아님, 홈 메모 색인은 판정에 보내지 않음
    const confirmed = mc.mix.filter((m) => m.verdict === 'project');
    expect(FX.planted.mix.filter((t) => confirmed.some((m) => m.text.includes(t))).length / FX.planted.mix.length).toBeGreaterThanOrEqual(0.8);
    expect(confirmed.every((m) => m.text.includes('[[MIX]]'))).toBe(true);
    expect(mc.mix.find((m) => m.text.includes('[[GEN]]'))?.verdict).toBe('general');
    expect(mc.mix.find((m) => m.text.includes('projc deploy order'))?.skipped).toBe('home-memory');
    expect(confirmed.every((m) => m.judgedProject === 'projc')).toBe(true);
    // 첫 화면 셋째 줄 = 확정 지적 수
    const f = run.result.summary.findings;
    expect(f).toMatchObject({ conflicts: mc.counts.conflicts, dupGroups: mc.counts.dupGroups, mixConfirmed: 3 });
    expect(topLines(run.result)[2]).toMatch(/^부딪힘 \d+쌍 · 같은 뜻 중복 \d+묶음 · 다른 프로젝트 섞임 3개 \(모델 판정\)/);
    expect(run.result.model.used).toBe(true);
    expect(run.manifest.model).toMatchObject({ used: true });
    // 페이지 탭에 판정 결과·근거
    const html = renderAuditHtml(run.result, 'r1');
    expect(html).toContain('fake dup');
    expect(html).toContain("['conflict','부딪힘 ('");
  });

  it('후보는 같은 폴더에 함께 실리는 것만, 판정은 Haiku 고정 ID 묶음 호출', async () => {
    const run = runAudit({ folders: FX.folders, claudeDir: FX.claude });
    const c = pairCandidates(run.ctx);
    expect(c.dup.every((p) => p.folders.length > 0)).toBe(true);
    // A 의 cq01 은 사용자 층과 A 에서 함께 실린다 → 부딪힘 후보, B 에는 A 파일이 안 실림
    const cq01 = c.conflict.find((p) => p.a.text.includes('cq01') && p.b.text.includes('cq01'));
    expect(cq01?.folders).toEqual([FX.A]);
    const calls = readJudgeCalls(FAKE).filter((l) => /^(dup|conflict|mix) /.test(l));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((l) => l.endsWith(CHECK_MODEL))).toBe(true);
  });

  it('결정성: 캐시가 있으면 같은 원천 두 번 → 같은 resultDigest, 모델 호출 0', async () => {
    const a = await audit();
    const n = readJudgeCalls(FAKE).length;
    const b = await audit();
    expect(readJudgeCalls(FAKE).length).toBe(n);
    expect(b.judge.stats.calls).toBe(0);
    expect(b.run.manifest.resultDigest).toBe(a.run.manifest.resultDigest);
  });

  it('--no-model 이면 결정적 검사만(호출 0, 셋째 줄은 "꺼져 세지 않음")', async () => {
    const n = readJudgeCalls(FAKE).length;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleAudit(['--folder', FX.A, '--claude-dir', FX.claude, '--no-open', '--no-model']);
      expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('모델 판정이 꺼져 세지 않음');
    } finally { log.mockRestore(); }
    expect(readJudgeCalls(FAKE).length).toBe(n);
  });

  it('판정기가 죽으면 판정 불완전으로 표시하고 지적을 세지 않는다', async () => {
    process.env.FAKE_DOWN = '1';
    try {
      const run = runAudit({ folders: [FX.B], claudeDir: FX.claude });
      const mc = await runModelChecks(run.result, run.ctx, new Judge({ model: true, cacheDir: path.join(ROOT, 'empty-cache') }));
      expect(mc.status).toBe('incomplete');
      expect(mc.counts.dupGroups).toBe(0);
    } finally { delete process.env.FAKE_DOWN; }
  });

  it('같은 뜻 묶음은 예 쌍을 잇는다', () => {
    expect(groupPairs([{ a: { key: 'x' }, b: { key: 'y' } }, { a: { key: 'y' }, b: { key: 'z' } }, { a: { key: 'p' }, b: { key: 'q' } }])).toEqual([['p', 'q'], ['x', 'y', 'z']]);
  });
});

describe('검수 --kind (N2) — N4 검수 형식·digest 는 그대로', () => {
  it('dup·conflict·mix 표본 → 같은 답 파일 형식으로 import → score', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { await handleAudit(['--folder', FX.A, '--folder', FX.B, '--folder', FX.C, '--folder', FX.home, '--claude-dir', FX.claude, '--no-open']); } finally { log.mockRestore(); }
    for (const kind of ['dup', 'conflict', 'mix'] as const) {
      const out = writeKindReview(kind);
      if ('error' in out) throw new Error(out.error);
      expect(out.sample.runId.startsWith(`${kind}-`)).toBe(true);
      const html = fs.readFileSync(out.htmlPath, 'utf-8');
      // 판정자의 답은 페이지에 없다
      expect(html).not.toContain('"judge"');
      expect(html).not.toContain('"bucket"');
      const answers = Object.fromEntries(out.sample.pairs.map((p) => [p.pairId, p.judge === 'yes' ? 'same' : 'different']));
      const file = path.join(ROOT, `ans-${kind}.json`);
      fs.writeFileSync(file, JSON.stringify({ schema: 'forgen-audit-review-answers/1', runId: out.sample.runId, digest: out.sample.digest, answeredAt: '2026-11-25T00:00:00Z', answers }));
      expect(importReview(file).answered).toBe(out.sample.pairs.length);
    }
    const scores = scoreReviews();
    expect(scores.filter((s) => /^(dup|conflict|mix)-/.test(s.runId)).every((s) => s.pass === true || s.compared === 0)).toBe(true);
    // 표본 칸 구성은 N4 와 같다(예 ≤ 10 · 아니오 ≤ 10 · 모름 ≤ 5), 같은 입력이면 같은 digest
    const { mc } = await audit();
    const s1 = buildKindSample('dup', mc, 'X', FX.home, new Date('2026-11-25T00:00:00Z'));
    const s2 = buildKindSample('dup', mc, 'X', FX.home, new Date('2026-11-26T00:00:00Z'));
    expect(s1.digest).toBe(s2.digest);
    expect(s1.pairs.filter((p) => p.bucket === 'yes-random').length).toBeLessThanOrEqual(10);
  });

  it('N4 표본(buildReviewSample)의 digest 공식은 바뀌지 않았다 — 이미 배포된 검수 답을 import 할 수 있다', () => {
    const r = { judge: null, items: [{ id: 'i1', ts: '2026-10-01T00:00:00Z', gist: 'g', utterance: 'u', pairs: [{ tier: 'memory', key: 'rule:abc', kind: 'forgen-rule', text: 't', score: 0.2, verdict: 'yes' }] }] };
    const s = buildReviewSample(r as never, 'run-x', new Date('2026-11-25T00:00:00Z'));
    // 0.9.0 C3 배포 판과 같은 값(pairId = sha(id|tier|key) 앞 12, digest = sha([[pairId, judge]]))
    expect(s.pairs[0].pairId).toBe('6aa47fb192d9');
    expect(s.digest).toBe('03a9bd5dcac97f5790b3b354008bbb18c571b1701e545edb93978404e7e58d61');
    expect(s.kind).toBeUndefined();
    expect(Object.keys(s.pairs[0]).sort()).toEqual(['bucket', 'gist', 'judge', 'memory', 'memoryKind', 'memoryWhere', 'pairId', 'score', 'tier', 'ts', 'utterance']);
  });
});
