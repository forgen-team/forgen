/**
 * 0.9.0 C3 같은 말 다시 하기 재생 — docs/plans/2026-11-25-v1.0-plan.md §4.2·§4.3·§4.4, §12.1-4 합성 D 축소판.
 * 합성 대화 기록: 창(10월) 사용자 발화 200개 중 교정 40 — 적혀 있던 것 15 · 적히지 않은 채 반복 10 · 새 교정 15를 심는다.
 * 모델은 가짜 claude(tests/helpers/fake-claude-judge.ts)로 대신한다. 모든 파일은 임시 HOME·FORGEN_HOME 안. 픽스처 문장은 전부 합성이다.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { installFakeJudge, readJudgeCalls } from './helpers/fake-claude-judge.js';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-recur-')));
const HOME = path.join(ROOT, 'home');
const FH = path.join(HOME, '.forgen');
const CLAUDE = path.join(HOME, '.claude');
const BIN = path.join(ROOT, 'bin');
const FAKE = path.join(ROOT, 'fake-state');
const PROJ = path.join(ROOT, 'work', 'proj-x');
fs.mkdirSync(CLAUDE, { recursive: true });
fs.mkdirSync(FAKE, { recursive: true });
installFakeJudge(BIN);
const PREV = { HOME: process.env.HOME, FORGEN_HOME: process.env.FORGEN_HOME, FORGEN_CWD: process.env.FORGEN_CWD, PATH: process.env.PATH, FAKE_STATE: process.env.FAKE_STATE };
process.env.HOME = HOME;
process.env.FORGEN_HOME = FH;
process.env.FAKE_STATE = FAKE;
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
delete process.env.FORGEN_CWD;

const { runRecurrence, recurrenceLine, poissonCi, latestRecurrence } = await import('../src/audit/recurrence.js');
const { Judge, CORRECTION_MODEL, PAIR_MODEL, PAIR_PROMPT_VERSION, prepareText, parseJsonLines } = await import('../src/audit/judge.js');
const { PREFILTER_MIN } = await import('../src/audit/recurrence.js');
const { buildReviewSample, importReview, scoreReviews, writeReview, shortWhere } = await import('../src/audit/review.js');
const { classifyCorrection, recordCorrectionClass, summarizeLedger } = await import('../src/core/correction-ledger.js');
const { handleAudit } = await import('../src/audit/cli.js');
const { runAudit } = await import('../src/audit/run.js');
const { topLines } = await import('../src/audit/html.js');
const { encodeProjectDir } = await import('../src/audit/sources.js');
const { createRule, saveRule } = await import('../src/store/rule-store.js');
const { appendSessionRender, readSessionRenders, rulesLoadedAt } = await import('../src/core/session-renders.js');
const { markSessionStartScope } = await import('../src/core/project-switch.js');

const W = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const tq = (n: number) => `tq${String(n).padStart(2, '0')}`;
const SEP = '2026-09-10T00:00:00.000Z';
const SINCE = new Date('2026-10-01T00:00:00Z');
const UNTIL = new Date('2026-11-01T00:00:00Z');

function hashTree(dir: string, skip: string[] = []): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    let names: string[] = [];
    try { names = fs.readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      if (skip.some((s) => p === s || p.startsWith(`${s}/`))) continue;
      const st = fs.lstatSync(p);
      h.update(st.isDirectory() ? `${p}|` : `${p}|${st.mtimeMs}|`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

/** 세션 하나: (시각, 발화) 목록. 앞에 AI 응답 없는 첫 발화를 두고, 발화마다 AI 응답을 넣는다. */
type Line = Record<string, unknown>;
const sessions = new Map<string, { cwd: string; lines: Line[] }>();
let uid = 0;
function say(session: string, cwd: string, ts: string, text: string, opts: { memoryWrite?: { file: string; content: string } } = {}) {
  let s = sessions.get(session);
  if (!s) {
    s = { cwd, lines: [] };
    sessions.set(session, s);
    const t0 = new Date(Date.parse(ts) - 60_000).toISOString();
    s.lines.push({ type: 'user', uuid: `u${uid++}`, sessionId: session, cwd, timestamp: t0, message: { role: 'user', content: '세션 시작 합성 발화' } });
  }
  const tA = new Date(Date.parse(ts) - 1000).toISOString();
  const content: unknown[] = [{ type: 'text', text: `합성 응답 ${uid}` }];
  if (opts.memoryWrite) content.push({ type: 'tool_use', id: `t${uid}`, name: 'Write', input: { file_path: opts.memoryWrite.file, content: opts.memoryWrite.content } });
  s.lines.push({ type: 'assistant', uuid: `a${uid++}`, sessionId: session, cwd, timestamp: tA, message: { role: 'assistant', content } });
  s.lines.push({ type: 'user', uuid: `u${uid++}`, sessionId: session, cwd, timestamp: ts, message: { role: 'user', content: text } });
}
const day = (d: number, h = 10) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
const corr = (n: number, extra = '') => `[[C:${tq(n)}]] 그게 아니라 ${tq(n)} 방식으로 다시 해 줘 ${extra}`.trim();

const ruleIds: Record<string, string> = {};
let renderedSession = '';
const ENC = () => encodeProjectDir(PROJ);
const MEM = () => path.join(CLAUDE, 'projects', ENC(), 'memory');

beforeAll(() => {
  fs.mkdirSync(path.join(PROJ, '.git'), { recursive: true });
  // 적혀 있던 기억(9월에 생김)
  const mkRule = (n: number, extra: Record<string, unknown> = {}) => {
    const r = { ...createRule({ category: 'workflow', scope: 'me', trigger: tq(n), policy: `합성 룰 ${tq(n)} 방식으로 처리한다는 지시`, strength: 'default', source: 'explicit_correction', render_key: `w.${tq(n)}` }), created_at: SEP, updated_at: SEP, ...extra };
    saveRule(r as never);
    ruleIds[tq(n)] = r.rule_id;
  };
  for (let n = 1; n <= 6; n++) mkRule(n);                        // 1~6 전역 룰 → 실렸는데 무시(3개는 렌더 기록, 3개는 재생 렌더)
  for (const n of [7, 8]) mkRule(n, { projects: ['other-proj'] }); // 7·8 다른 프로젝트 전용 → 안 실림(scope)
  // 나중에 생긴 룰(10월 20일) — 그 전 교정(tq40)에는 "기억이 된 것"
  saveRule({ ...createRule({ category: 'workflow', scope: 'me', trigger: tq(40), policy: `합성 룰 ${tq(40)} 방식 지시`, strength: 'default', source: 'explicit_correction', render_key: `w.${tq(40)}` }), created_at: '2026-10-20T00:00:00.000Z', updated_at: '2026-10-20T00:00:00.000Z' } as never);
  // 9~12 자동 메모 주제 파일(9월 대화 기록에서 Write) → 안 실림(topic-only)
  W(path.join(MEM(), 'MEMORY.md'), '# Memory\n- [색인](feedback_a.md) — 합성 색인 줄 하나\n');
  for (let n = 9; n <= 12; n++) {
    const file = path.join(MEM(), `feedback_${tq(n)}.md`);
    const content = `---\nname: f${n}\ndescription: 합성 메모 ${tq(n)} 방식\ntype: feedback\n---\n${tq(n)} 방식으로 할 것\n`;
    W(file, content);
    say(`sep-mem-${n}`, PROJ, `2026-09-0${n - 7}T09:00:00.000Z`, '메모 남겨 줘', { memoryWrite: { file: path.join('/home/someone/.claude/projects', ENC(), 'memory', `feedback_${tq(n)}.md`), content } });
  }
  // 시점을 모르는 메모(대화 기록에 쓰기가 없음) — tq30 교정은 "적혀 있던 것"으로 세지 않아야 한다
  W(path.join(MEM(), `feedback_${tq(30)}.md`), `---\ndescription: 합성 메모 ${tq(30)} 방식\ntype: feedback\n---\n${tq(30)} 방식으로 할 것\n`);
  // 13~15 프로젝트 CLAUDE.md 줄(수정 시각 9월) → 실렸는데 무시(host-load)
  W(path.join(PROJ, 'CLAUDE.md'), `# 합성 프로젝트\n${[13, 14, 15].map((n) => `- 합성 지침 ${tq(n)} 방식으로 처리할 것`).join('\n')}\n`);
  fs.utimesSync(path.join(PROJ, 'CLAUDE.md'), new Date(SEP), new Date(SEP));

  // 창(10월): 교정 40 + 교정 아님 160 = 직전 AI 응답이 있는 발화 200
  // 적혀 있던 것 15 (tq01~15), 각자 다른 세션
  for (let n = 1; n <= 15; n++) say(`w-${n}`, PROJ, day(2 + (n % 20)), corr(n));
  // 반복 10: tq16~20 은 조회 구간(9월)에 첫 교정, tq21~25 는 창 안 앞선 세션에 첫 교정
  for (let n = 16; n <= 20; n++) { say(`look-${n}`, PROJ, `2026-09-2${n - 15}T10:00:00.000Z`, corr(n)); say(`rep-${n}`, PROJ, day(25), corr(n)); }
  for (let n = 21; n <= 25; n++) { say(`first-${n}`, PROJ, day(3), corr(n)); say(`rep-${n}`, PROJ, day(26), corr(n)); }
  // 새 교정 10 더(tq26~35; tq30 은 시점 모르는 메모와 짝, tq31 은 이 작업 전용, tq33 은 순서 바꾸면 갈리는 쌍)
  for (let n = 26; n <= 35; n++) say(`new-${n}`, PROJ, day(10), corr(n, n === 31 ? '[[T]]' : n === 33 ? 'UNK' : ''));
  say('new-40', PROJ, day(12), corr(40));
  // 합계: 15 + 10 + 5(tq21~25 첫 교정) + 10 + 1 = 41 → tq35 하나를 빼서 40 으로 맞춘다
  sessions.get('new-35')?.lines.splice(-2, 2);
  // 교정 아님 160
  let k = 0;
  for (let s = 0; s < 16; s++) for (let i = 0; i < 10; i++) say(`plain-${s}`, PROJ, day(5 + (s % 20), 8 + (i % 10)), `합성 일반 요청 ${k++} 진행해 줘`);
  // 서브에이전트 기록(제외 대상)
  W(path.join(CLAUDE, 'projects', ENC(), 'w-1', 'subagents', 'agent-x.jsonl'), `${JSON.stringify({ type: 'user', sessionId: 'w-1', cwd: PROJ, timestamp: day(4), message: { role: 'user', content: corr(77) } })}\n`);
  // 명령·도구 결과는 후보가 아니다
  say('plain-0', PROJ, day(28), '<command-name>/clear</command-name>');
  for (const [sid, s] of sessions) W(path.join(CLAUDE, 'projects', ENC(), `${sid}.jsonl`), `${s.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

  // 세션별 렌더 기록: w-1~w-3 은 렌더 기록에 그 룰이 있다. 나머지는 재생 렌더로 추정.
  for (let n = 1; n <= 3; n++) appendSessionRender({ at: new Date(Date.parse(day(2 + n)) - 3_600_000).toISOString(), session: `w-${n}`, event: 'start', cwd: PROJ, project: 'proj-x', ruleIds: [ruleIds[tq(n)]] });
  renderedSession = 'w-1';
});

afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const opts = () => ({ claudeDir: CLAUDE, since: SINCE, until: UNTIL, lookbackDays: 30, now: new Date('2026-11-25T00:00:00Z'), cwd: PROJ });

describe('판정기 단위', () => {
  it('보내기 전 정리: <private> 제거·비밀키 가림·길이 자르기', () => {
    const t = prepareText(`앞 <private>숨김</private> sk-ant-api03-${'a'.repeat(40)} 뒤 ${'x'.repeat(600)}`, 500);
    expect(t).not.toContain('숨김');
    expect(t).not.toContain('a'.repeat(40));
    expect(t.length).toBe(500);
  });
  it('응답 파싱: 코드 울타리·앞뒤 말 무시, id 별 첫 줄', () => {
    const m = parseJsonLines('설명\n```\n{"id":"i0","same":true}\n{"id":"i1","same":false}\n{"id":"i0","same":false}\n```');
    expect(m.get('i0')?.same).toBe(true);
    expect(m.get('i1')?.same).toBe(false);
    const n = parseJsonLines('[{"id":"i0","correction":true,"gist":"설정 {a:1} 처럼 \\"따옴표\\" 든 요지","task_specific":false},\n {"id":"i1","correction":false,"gist":"","task_specific":false}]');
    expect(n.get('i0')?.gist).toBe('설정 {a:1} 처럼 "따옴표" 든 요지');
    expect(n.get('i1')?.correction).toBe(false);
  });
  it('포아송 구간', () => {
    const [lo, hi] = poissonCi(9);
    expect(lo).toBeGreaterThan(4);
    expect(lo).toBeLessThan(4.3);
    expect(hi).toBeGreaterThan(16.9);
    expect(hi).toBeLessThan(17.3);
  });
});

describe('세션별 렌더 기록', () => {
  it('세션 시작 블록 ID 를 남기고, 시각 t 의 실린 룰 = 마지막 start + 그 뒤 switch', () => {
    markSessionStartScope('render-unit', PROJ, ['r1', 'r2']);
    appendSessionRender({ at: '2999-01-01T00:00:00.000Z', session: 'render-unit', event: 'switch', cwd: PROJ, project: 'p', ruleIds: ['r3'] });
    const recs = readSessionRenders(path.join(FH, 'state')).get('render-unit');
    expect(recs?.[0]).toMatchObject({ event: 'start', ruleIds: ['r1', 'r2'], project: 'proj-x' });
    expect([...(rulesLoadedAt(recs, '2998-01-01T00:00:00.000Z') ?? [])]).toEqual(['r1', 'r2']);
    expect([...(rulesLoadedAt(recs, '3000-01-01T00:00:00.000Z') ?? [])].sort()).toEqual(['r1', 'r2', 'r3']);
    expect(rulesLoadedAt(undefined, '2026-01-01')).toBeNull();
  });
});

describe('forgen audit recurrence — 합성 D 축소판', () => {
  let first: Awaited<ReturnType<typeof runRecurrence>>;
  it('심어 둔 교정을 갈래별로 찾는다(재현율)', async () => {
    const before = hashTree(HOME, [path.join(FH, 'audit')]);
    first = await runRecurrence(opts());
    const r = first.result;
    expect(hashTree(HOME, [path.join(FH, 'audit')])).toBe(before); // 읽기 전용(판정 캐시·회차 폴더 제외)
    expect(r.status).toBe('ok');
    expect(r.prompts.window).toBe(200);
    expect(r.prompts.judged).toBe(200);
    expect(r.corrections.total).toBe(40);
    expect(r.corrections.lookback).toBe(5);
    expect(r.corrections.taskSpecific).toBe(1);
    const by = (b: string) => r.items.filter((i) => i.branch === b).map((i) => i.gist.match(/tq\d\d/)?.[0]).sort();
    expect(by('ignored')).toEqual([1, 2, 3, 4, 5, 6, 13, 14, 15].map(tq));
    expect(by('not-loaded')).toEqual([7, 8, 9, 10, 11, 12].map(tq));
    expect(by('unwritten-repeat')).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25].map(tq));
    expect(r.counts).toEqual({ ignored: 9, notLoaded: 6, written: 15, unwrittenRepeat: 10, deletedRepeat: 0, total: 25, tier2Missed: 0 });
    expect(r.per1000.total).toBe(125);
    expect(r.per1000.written).toBe(75);
    // 실렸는가의 근거: 렌더 기록 3 · 재생 렌더 3(전역 룰) · 다른 프로젝트 전용 2 는 재생에서 빠짐
    expect(r.loadedVia).toEqual({ renderLog: 3, replay: 5 });
    const reasons = r.items.filter((i) => i.branch === 'not-loaded').map((i) => i.match?.reason).sort();
    expect(reasons).toEqual(['scope', 'scope', 'topic-only', 'topic-only', 'topic-only', 'topic-only']);
    expect(r.items.find((i) => i.session === renderedSession)?.match?.loadedVia).toBe('render-log');
    // 시점 모르는 메모는 세지 않음, 그 뒤 생긴 룰은 "기억이 된 것", 판정자 "모름"은 세지 않고 남김
    expect(r.items.find((i) => i.gist.includes(tq(30)))?.branch).toBe('new');
    expect(r.memory.unknownTime).toBeGreaterThanOrEqual(1);
    expect(r.corrections.becameMemory).toBe(1);
    // 사전 등록 2026-11-26: 교정 뒤에 생긴 기억과의 짝은 "그때 이미 지시했나"가 아니라 따로(나중 기억 질문) 판정한다
    expect(readJudgeCalls(FAKE).some((c) => c.startsWith('later '))).toBe(true);
    const unk = r.items.find((i) => i.gist.includes(tq(33)));
    expect(unk?.branch).toBe('new');
    expect(unk?.unknown).toBeGreaterThan(0);
    expect(r.unknown).toBe(unk?.unknown);
    // 이 작업 전용 교정은 쌍 판정에 보내지 않는다
    const ts = r.items.find((i) => i.gist.includes(tq(31)));
    expect(ts).toMatchObject({ skipped: 'task-specific', branch: 'new', pairs: [] });
    // 사전 필터: 보낸 쌍은 모두 하한 이상, 같은 뜻 쌍(합성)은 모두 하한을 넘는다(재현율)
    const all = r.items.flatMap((i) => i.pairs);
    expect(all.every((x) => x.score >= PREFILTER_MIN)).toBe(true);
    expect(Math.min(...all.filter((x) => x.verdict === 'yes').map((x) => x.score))).toBeGreaterThan(PREFILTER_MIN);
    // 모델: 교정 = Haiku, 쌍 = Sonnet(고정 ID), 묶음 호출, 쌍은 1회(순서 바꾸기 없음)
    const calls = readJudgeCalls(FAKE);
    expect(calls.filter((c) => c.startsWith('correction ')).every((c) => c.endsWith(CORRECTION_MODEL))).toBe(true);
    expect(calls.filter((c) => c.startsWith('pair ') || c.startsWith('later ')).every((c) => c.endsWith(PAIR_MODEL))).toBe(true);
    // 쌍 판정(그때 이미 지시했나) + 나중 기억 판정(따로) — 둘 다 쌍마다 1회
    const sent = calls.filter((c) => c.startsWith('pair ') || c.startsWith('later ')).reduce((n, c) => n + Number(c.split(' ')[1]), 0);
    expect(sent).toBe(new Set(r.items.flatMap((i) => i.pairs.map((x) => `${x.tier === 'later' ? 'L' : 'P'}|${i.gist}|${x.text}`))).size);
    expect(first.judgeStats?.calls).toBe(calls.length);
    expect(first.manifest.judge).toMatchObject({ correction: { model: CORRECTION_MODEL }, pair: { model: PAIR_MODEL, version: PAIR_PROMPT_VERSION, mode: 'single-asymmetric' }, prefilterMin: PREFILTER_MIN });
    expect(r.notes.join(' ')).toContain('기억이 바뀌면(룰을 지우거나 더하면)');
  });

  it('결정성: 캐시가 있으면 같은 입력 두 번 → 같은 숫자, 모델 호출 0', async () => {
    const n = readJudgeCalls(FAKE).length;
    const again = await runRecurrence(opts());
    expect(readJudgeCalls(FAKE).length).toBe(n);
    expect(again.judgeStats?.calls).toBe(0);
    expect(again.manifest.resultDigest).toBe(first.manifest.resultDigest);
    expect(again.manifest.sourcesDigest).toBe(first.manifest.sourcesDigest);
    expect(again.result.counts).toEqual(first.result.counts);
  });

  it('--limit: 시드 고정 표본, 같은 표본이면 같은 결과', async () => {
    const a = await runRecurrence({ ...opts(), limit: 60 });
    const b = await runRecurrence({ ...opts(), limit: 60 });
    expect(a.result.prompts).toMatchObject({ window: 200, sampled: 60, judged: 60, limit: 60 });
    expect(a.manifest.resultDigest).toBe(b.manifest.resultDigest);
    expect(a.result.status).toBe('insufficient'); // 교정 30 미만
    expect(a.result.notes.join(' ')).toContain('실제보다 적게 나온다');
  });

  it('--no-model: N4 를 내지 않고 "모델 판정 꺼짐", 호출 0', async () => {
    const n = readJudgeCalls(FAKE).length;
    const r = await runRecurrence({ ...opts(), model: false });
    expect(r.result.status).toBe('model-off');
    expect(r.result.counts.total).toBe(0);
    expect(readJudgeCalls(FAKE).length).toBe(n);
    expect(recurrenceLine(r.result)).toContain('모델을 끄고 재서 세지 않음');
  });

  it('모델을 못 부르면(로그인 없음) 판정 불완전 — 숫자를 확정하지 않는다', async () => {
    process.env.FAKE_DOWN = '1';
    try {
      const r = await runRecurrence({ ...opts(), judge: new Judge({ cacheDir: path.join(ROOT, 'empty-cache') }) });
      expect(r.result.status).toBe('incomplete');
      expect(r.result.statusNote).toContain('로그인');
    } finally { delete process.env.FAKE_DOWN; }
  });

  it('0.9.0 두 층: 2층 후보였는데 교정 때까지 안 실린 룰 = "2층 미발동"(누락으로 셈) · 2주 단위 추적 · 색인에 합치면 1층 복귀', async () => {
    const log = path.join(FH, 'state', 'metrics', 'session-renders.jsonl');
    const saved = fs.readFileSync(log, 'utf-8');
    const idxPath = path.join(FH, 'state', 'tier2-index.json');
    try {
      // w-4: 세션 시작 블록에는 없고(2층 후보로 색인 줄에만) 그 뒤 'tier2' 사건도 없음
      appendSessionRender({ at: new Date(Date.parse(day(6)) - 3_600_000).toISOString(), session: 'w-4', event: 'start', cwd: PROJ, project: 'proj-x', ruleIds: [], tier2: [ruleIds[tq(4)]] });
      // w-5: 2층 후보였고 교정 전에 상황 판정이 넣었다 → 실렸는데 무시
      appendSessionRender({ at: new Date(Date.parse(day(7)) - 3_600_000).toISOString(), session: 'w-5', event: 'start', cwd: PROJ, project: 'proj-x', ruleIds: [], tier2: [ruleIds[tq(5)]] });
      appendSessionRender({ at: new Date(Date.parse(day(7)) - 60_000).toISOString(), session: 'w-5', event: 'tier2', cwd: PROJ, project: 'proj-x', ruleIds: [ruleIds[tq(5)]], via: 'prompt' });
      const r = (await runRecurrence(opts())).result;
      const w4 = r.items.find((i) => i.session === 'w-4');
      expect(w4).toMatchObject({ branch: 'not-loaded', match: { reason: 'tier2-missed', loadedVia: 'render-log' } });
      expect(r.items.find((i) => i.session === 'w-5')).toMatchObject({ branch: 'ignored', match: { loadedVia: 'render-log' } });
      expect(r.counts.tier2Missed).toBe(1);
      expect(r.notes.join(' ')).toContain('다시 교정한 경우만 센다');
      expect(recurrenceLine(r)).toContain('상황 맞춤 룰이 안 들어와서 1');
      // 2주 단위: 구간 합 = 전체, 2층 미발동은 w-4 의 구간에
      expect(r.biweekly?.length).toBe(3);
      expect(r.biweekly?.reduce((n, b) => n + b.total, 0)).toBe(r.counts.total);
      expect(r.biweekly?.reduce((n, b) => n + b.prompts, 0)).toBe(r.prompts.judged);
      expect(r.biweekly?.find((b) => w4 && w4.ts >= b.from && w4.ts < b.to)?.tier2Missed).toBe(1);
      // 색인이 있으면 재발 이력에 합친다 → 그 룰은 다음 세션부터 1층(재자격은 90일 뒤)
      const { mergeRecurrence } = await import('../src/audit/tier2-replay.js');
      const { loadTier2Index, tierOf } = await import('../src/core/tier2.js');
      W(idxPath, JSON.stringify({ version: 1, generatedAt: '', params: { k: 3, turns: 3, minFireRate: 0.8, maxFreq: 0.05 }, rules: { [ruleIds[tq(4)]]: { qualified: true, reason: 'fired', words: ['a', 'b', 'c'], topics: [], contexts: 1, fired: 1 } }, recur: {} }));
      const m = mergeRecurrence(r.items);
      expect(m.tier2Missed).toEqual([ruleIds[tq(4)]]);
      const idx = loadTier2Index();
      expect(idx?.recur[ruleIds[tq(4)]]).toMatchObject({ kind: 'tier2-missed', lastAt: w4?.ts });
      const rule = { rule_id: ruleIds[tq(4)], strength: 'default', source: 'explicit_correction', scope: 'me', created_at: SEP } as never;
      expect(tierOf(rule, idx, Date.parse(w4?.ts ?? '') + 89 * 86_400_000)).toEqual({ tier: 1, reason: 'tier2-missed' });
      expect(tierOf(rule, idx, Date.parse(w4?.ts ?? '') + 91 * 86_400_000)).toEqual({ tier: 2, reason: 'tier2' });
    } finally { fs.writeFileSync(log, saved); fs.rmSync(idxPath, { force: true }); }
  });

  it('지운 뒤 다시 말함(§4.3): 지움 표시가 있으면 그 갈래로 센다', async () => {
    const del = path.join(FH, 'audit', 'deleted.jsonl');
    W(del, `${JSON.stringify({ at: '2026-09-30T00:00:00.000Z', text: `지운 합성 지시 ${tq(26)} 방식`, kind: 'memory-topic' })}\n`);
    try {
      const r = await runRecurrence(opts());
      expect(r.result.items.find((i) => i.gist.includes(tq(26)))?.branch).toBe('deleted-repeat');
      expect(r.result.counts.deletedRepeat).toBe(1);
      expect(r.result.counts.total).toBe(26);
    } finally { fs.rmSync(del); }
  });
});

describe('CLI · 첫 화면 · 기준값', () => {
  it('audit recurrence: 첫 실행 공개 1회, 회차 폴더·지문, 원장 판정 대기도 풀고, 첫 화면 첫 줄이 그 결과로 채워진다', async () => {
    // 세션 학습 동의와 무관하게 audit recurrence 가 원장 pending 을 같은 판정기로 푼다
    const pend = classifyCorrection({ sessionId: 'P1', evidenceId: 'ev-p1', policy: `합성 룰 ${tq(2)} 방식으로 처리하라는 지시를 지켜라`, renderKey: 'x.p1', project: null });
    expect(pend.class).toBe('pending');
    recordCorrectionClass(pend);
    expect(summarizeLedger().pending).toBe(1);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleAudit(['recurrence', '--claude-dir', CLAUDE, '--since', '2026-10-01', '--until', '2026-11-01', '--lookback', '30d']);
      const text = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(summarizeLedger().pending).toBe(0);
      expect(text).toContain('아직 판정 안 된 교정 기록 1개를 판정함');
      expect(text).toContain('claude-sonnet');
      expect(text).toContain('처음 한 번만 보이는 안내');
      expect(text).toContain('세션에 실렸는데도 또 말함');
      expect(text).toMatch(/모델 호출 \d+번/);
      log.mockClear();
      await handleAudit(['recurrence', '--claude-dir', CLAUDE, '--since', '2026-10-01', '--until', '2026-11-01']);
      expect(log.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('처음 한 번만 보이는 안내');
    } finally { log.mockRestore(); }
    expect(fs.readdirSync(path.join(FH, 'audit')).some((n) => /^fingerprint-\d{4}-\d{2}-\d{2}\.json$/.test(n))).toBe(true);
    const latest = latestRecurrence();
    expect(latest?.counts.total).toBe(25);
    const { result } = runAudit({ folders: [PROJ], claudeDir: CLAUDE });
    expect(result.summary.recurrence.status).toBe('ok');
    expect(topLines(result)[0]).toContain('이미 적혀 있는데 또 말한 것');
  });

  it('audit review → --import → score: 표본 25(예 10·아니오 10·모름 ≤5), 판정자 답은 숨김, 경로는 줄임, 일치율', async () => {
    const out = writeReview();
    if ('error' in out) throw new Error(out.error);
    const html = fs.readFileSync(out.htmlPath, 'utf-8');
    expect((fs.statSync(out.htmlPath).mode & 0o777).toString(8)).toBe('600');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/"judge"|"bucket"/);
    expect(html).not.toContain(ROOT); // 경로는 줄여 보인다
    const b = (k: string) => out.sample.pairs.filter((x) => x.bucket === k).length;
    expect(b('yes-random')).toBe(10);
    expect(b('no-top-score')).toBe(10);
    expect(b('unknown')).toBeGreaterThan(0);
    expect(b('unknown')).toBeLessThanOrEqual(5);
    // 같은 결과면 같은 표본
    const again = writeReview();
    expect('error' in again ? '' : again.sample.digest).toBe(out.sample.digest);
    // 오너 답: 판정자와 같게, 하나만 뒤집고, 모름 쌍은 같은 뜻
    const answers: Record<string, string> = {};
    let flipped = false;
    for (const x of out.sample.pairs) {
      if (x.judge === 'unknown') { answers[x.pairId] = 'same'; continue; }
      const agree = x.judge === 'yes' ? 'same' : 'different';
      answers[x.pairId] = !flipped ? (agree === 'same' ? 'different' : 'same') : agree;
      flipped = true;
    }
    const file = path.join(ROOT, 'downloaded-answers.json');
    fs.writeFileSync(file, JSON.stringify({ schema: 'forgen-audit-review-answers/1', runId: out.sample.runId, digest: out.sample.digest, answeredAt: '2026-11-25T00:00:00Z', answers: { ...answers, bogus: 'same' } }));
    const imp = importReview(file);
    expect(imp.answered).toBe(out.sample.pairs.length);
    expect((fs.statSync(imp.path).mode & 0o777).toString(8)).toBe('600');
    const [sc] = scoreReviews();
    expect(sc.compared).toBe(20);
    expect(sc.agree).toBe(19);
    expect(sc.agreement).toBe(0.95);
    expect(sc.pass).toBe(true);
    expect(sc.unknown.same).toBe(b('unknown'));
    // 다른 표본의 답은 받지 않는다
    fs.writeFileSync(file, JSON.stringify({ schema: 'forgen-audit-review-answers/1', runId: out.sample.runId, digest: 'x', answeredAt: '', answers }));
    expect(() => importReview(file)).toThrow(/표본이 바뀌었다/);
    expect(shortWhere('/x/.claude/projects/-a-b/memory/feedback_x.md', 3, 'topic:x')).toBe('…/memory/feedback_x.md:3');
    expect(shortWhere(undefined, undefined, 'rule:12345678abcdef')).toBe('forgen 룰 12345678');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleAudit(['score']);
      expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/판정자-오너 일치 95% \(19\/20\).*통과/);
    } finally { log.mockRestore(); }
  });

  it('§4.4 작을 때: 적힘 < 10 → 반복 전체, 그것도 < 10 → "기억이 된 것 a, 다시 나온 것 b"', () => {
    const base = latestRecurrence() as NonNullable<ReturnType<typeof latestRecurrence>>;
    const withC = (written: number, total: number) => ({ ...base, per30d: { ...base.per30d, written, total } });
    expect(recurrenceLine(withC(16, 20))).toContain('이미 적혀 있는데 또 말한 것 약 16번');
    expect(recurrenceLine(withC(6, 12))).toContain('같은 말 다시 하기 약 12번');
    expect(recurrenceLine(withC(2, 4))).toMatch(/기억으로 남은 것 약 [\d.]+, 다시 말한 것 약 4/);
    expect(recurrenceLine(null)).toContain('아직 재지 않음');
  });

  it('audit baseline --freeze: 6주·12주를 숫자·manifest 해시·판본과 고정, 덮어쓰기는 --force 만', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await handleAudit(['baseline', '--claude-dir', CLAUDE, '--until', '2026-11-01', '--freeze']);
      const bp = path.join(FH, 'audit', 'baseline.json');
      const b = JSON.parse(fs.readFileSync(bp, 'utf-8'));
      expect(b.schema).toBe('forgen-audit-baseline/1');
      expect(b.judge.pair.model).toBe(PAIR_MODEL);
      expect(b.sixWeeks.window.days).toBe(42);
      expect(b.twelveWeeks.window.days).toBe(84);
      expect(b.sixWeeks.counts.total).toBe(25);
      expect(b.sixWeeks.sourcesDigest).toMatch(/^[0-9a-f]{64}$/);
      expect((fs.statSync(bp).mode & 0o777).toString(8)).toBe('600');
      process.exitCode = 0;
      await handleAudit(['baseline', '--claude-dir', CLAUDE, '--until', '2026-11-01', '--freeze']);
      expect(process.exitCode).toBe(1);
      expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toContain('--force');
      process.exitCode = 0;
      await handleAudit(['baseline', '--claude-dir', CLAUDE, '--until', '2026-11-01', '--freeze', '--force']);
      expect(process.exitCode).toBe(0);
      expect(fs.readdirSync(path.join(FH, 'audit')).some((n) => /^baseline-\d+\.json$/.test(n))).toBe(true);
      await handleAudit(['baseline', '--limit', '5']);
      expect(process.exitCode).toBe(1);
      await handleAudit(['recurrence', '--bogus']);
      expect(process.exitCode).toBe(1);
    } finally { log.mockRestore(); err.mockRestore(); process.exitCode = 0; }
  });
});
