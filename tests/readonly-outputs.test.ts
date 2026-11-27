/**
 * K2-b 읽기 전용 공개 출력 (docs/reference/public-contracts.md):
 *   forgen audit recurrence --latest --json  — 저장된 가장 최근 재생 결과(forgen-audit-recurrence/2), 없으면 no-data
 *   forgen status --rate-limit --json         — rate-limit 샘플 원본 형식(forgen-rate-limit/v1)
 * 두 경로 모두 아무것도 쓰지 않는다 — 실행 전후 FORGEN_HOME(과 대화 기록 폴더)의 파일 해시·수정 시각이 같아야 한다.
 * 재생 결과는 실물 runRecurrence + 가짜 claude 판정기(tests/helpers/fake-claude-judge.ts)로 만든다. 모든 파일은 임시 HOME 안, 문장은 전부 합성.
 * 픽스처(tests/fixtures/contracts/)는 이 테스트가 만든 실제 출력이다. 다시 뜨려면 FORGEN_WRITE_CONTRACT_FIXTURES=1.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installFakeJudge } from './helpers/fake-claude-judge.js';
import { schemaIssues } from './helpers/contract-schema.js';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-ro-')));
const HOME = path.join(ROOT, 'home');
const FH = path.join(HOME, '.forgen');
const CLAUDE = path.join(HOME, '.claude');
const BIN = path.join(ROOT, 'bin');
const FAKE = path.join(ROOT, 'fake-state');
const PROJ = path.join(ROOT, 'work', 'proj-ro');
fs.mkdirSync(CLAUDE, { recursive: true });
fs.mkdirSync(FAKE, { recursive: true });
fs.mkdirSync(path.join(PROJ, '.git'), { recursive: true });
installFakeJudge(BIN);
const PREV = { HOME: process.env.HOME, FORGEN_HOME: process.env.FORGEN_HOME, FORGEN_CWD: process.env.FORGEN_CWD, PATH: process.env.PATH, FAKE_STATE: process.env.FAKE_STATE };
process.env.HOME = HOME;
process.env.FORGEN_HOME = FH;
process.env.FAKE_STATE = FAKE;
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
delete process.env.FORGEN_CWD;

const { runRecurrence, writeRecurrenceRun, RECURRENCE_SCHEMA } = await import('../src/audit/recurrence.js');
const { handleAudit } = await import('../src/audit/cli.js');
const { handleStatus } = await import('../src/core/status-cli.js');
const { readSamples, SAMPLES_PATH } = await import('../src/core/rate-limit-forecast.js');
const { handleProject } = await import('../src/core/project-cli.js');
const { encodeProjectDir } = await import('../src/audit/sources.js');

afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'contracts');
const WRITE_FIXTURES = process.env.FORGEN_WRITE_CONTRACT_FIXTURES === '1';
const FIXTURE_ROOT = '/tmp/forgen-fixture';
// biome-ignore lint/suspicious/noExplicitAny: 일부러 깬 값을 만들기 위한 느슨한 타입
type J = Record<string, any>;
const W = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 폴더 아래 모든 항목의 경로·종류·수정 시각·내용 해시. 폴더가 없으면 'absent'. */
function hashTree(dir: string): string {
  if (!fs.existsSync(dir)) return 'absent';
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      h.update(`${p}|${st.isDirectory() ? 'd' : 'f'}|${st.mtimeMs}|${st.size}|`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

/** CLI 핸들러의 stdout·stderr 와 종료 코드를 가로챈다. */
async function capture(run: () => Promise<void>): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => { err.push(String(s)); return true; });
  try { await run(); } finally { log.mockRestore(); error.mockRestore(); stderr.mockRestore(); }
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = prevExit;
  return { out: out.join('\n'), err: err.join(''), exitCode };
}

/** 쓰기 없음 검사: 실행 전후로 FORGEN_HOME·대화 기록 폴더가 그대로인지. */
async function readOnly(run: () => Promise<void>) {
  const before = [hashTree(FH), hashTree(CLAUDE)];
  const r = await capture(run);
  expect([hashTree(FH), hashTree(CLAUDE)]).toEqual(before);
  return r;
}

function fixture(id: string, value: unknown, suffix = ''): J {
  const file = path.join(FIXTURES, `${id.replace(/\//g, '.')}${suffix}.json`);
  if (WRITE_FIXTURES || !fs.existsSync(file)) W(file, `${JSON.stringify(value, null, 2).split(ROOT).join(FIXTURE_ROOT)}\n`);
  return readFixture(id, suffix);
}
const readFixture = (id: string, suffix = ''): J => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${id.replace(/\//g, '.')}${suffix}.json`), 'utf-8')) as J;
const expectPass = (id: string, v: unknown) => expect(schemaIssues(id, v)).toEqual([]);
const expectFail = (id: string, v: unknown) => expect(schemaIssues(id, v).length).toBeGreaterThan(0);

/** 합성 대화 기록: 세션마다 첫 발화 + (AI 응답, 사용자 발화) 쌍. [[C:tqNN]] 이 교정(가짜 판정기 규칙). */
function writeTranscripts() {
  const enc = encodeProjectDir(PROJ);
  let uid = 0;
  const session = (sid: string, utterances: Array<[string, string]>) => {
    const lines: J[] = [];
    const t0 = new Date(Date.parse(utterances[0][0]) - 60_000).toISOString();
    lines.push({ type: 'user', uuid: `u${uid++}`, sessionId: sid, cwd: PROJ, timestamp: t0, message: { role: 'user', content: '세션 시작 합성 발화' } });
    for (const [ts, text] of utterances) {
      lines.push({ type: 'assistant', uuid: `a${uid++}`, sessionId: sid, cwd: PROJ, timestamp: new Date(Date.parse(ts) - 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: `합성 응답 ${uid}` }] } });
      lines.push({ type: 'user', uuid: `u${uid++}`, sessionId: sid, cwd: PROJ, timestamp: ts, message: { role: 'user', content: text } });
    }
    W(path.join(CLAUDE, 'projects', enc, `${sid}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  };
  session('s-first', [['2026-10-03T10:00:00.000Z', '[[C:tq01]] 그게 아니라 tq01 방식으로 다시 해 줘'], ['2026-10-03T11:00:00.000Z', '합성 일반 요청 하나 진행해 줘']]);
  session('s-repeat', [['2026-10-20T10:00:00.000Z', '[[C:tq01]] 그게 아니라 tq01 방식으로 다시 해 줘'], ['2026-10-20T11:00:00.000Z', '[[C:tq02]] 그게 아니라 tq02 방식으로 해 줘']]);
}

describe('forgen audit recurrence --latest --json (K2-b)', () => {
  it('저장된 결과가 없으면 no-data 한 덩이를 내고, FORGEN_HOME 을 만들지도 않는다', async () => {
    expect(fs.existsSync(FH)).toBe(false);
    const r = await readOnly(() => handleAudit(['recurrence', '--latest', '--json']));
    expect(r.exitCode).toBeUndefined();
    const j = JSON.parse(r.out) as J;
    expect(j).toMatchObject({ schema: RECURRENCE_SCHEMA, status: 'no-data', runId: null });
    expect(fs.existsSync(FH)).toBe(false);
    expectPass(RECURRENCE_SCHEMA, j);
    expectPass(RECURRENCE_SCHEMA, fixture(RECURRENCE_SCHEMA, j, '.no-data'));
  });

  it('--json 없이, 또는 판정 옵션과 함께 쓰면 오류로 끝나고 아무것도 쓰지 않는다', async () => {
    for (const args of [['recurrence', '--latest'], ['recurrence', '--latest', '--json', '--limit', '5'], ['recurrence', '--latest', '--json', '--no-model']]) {
      const r = await readOnly(() => handleAudit(args));
      expect(r.exitCode).toBe(1);
      expect(r.out).toBe('');
      expect(r.err).toContain('--latest');
    }
    expect(fs.existsSync(FH)).toBe(false);
  });

  it('저장된 가장 최근 결과를 schema 그대로(+runId) 내고, 회차·지문·색인·원장·캐시 어느 것도 쓰지 않는다', async () => {
    writeTranscripts();
    const run = await runRecurrence({ claudeDir: CLAUDE, since: new Date('2026-10-01T00:00:00Z'), until: new Date('2026-11-01T00:00:00Z'), lookbackDays: 30, now: new Date('2026-11-01T00:00:00Z') });
    const saved = writeRecurrenceRun(run);
    expect(['ok', 'insufficient']).toContain(run.result.status);
    const callsBefore = fs.readFileSync(path.join(FAKE, 'calls.log'), 'utf-8');

    const r = await readOnly(() => handleAudit(['recurrence', '--latest', '--json']));
    expect(r.exitCode).toBeUndefined();
    expect(r.err).toBe(''); // 모델 안내(stderr)도 없다 — 판정기를 부르지 않는다
    expect(fs.readFileSync(path.join(FAKE, 'calls.log'), 'utf-8')).toBe(callsBefore);
    const j = JSON.parse(r.out) as J;
    expect(j).toEqual({ ...JSON.parse(fs.readFileSync(path.join(saved.dir, 'result.json'), 'utf-8')), runId: saved.runId });
    expect(j.items.length).toBeGreaterThan(0);
    expectPass(RECURRENCE_SCHEMA, j);
    expectPass(RECURRENCE_SCHEMA, fixture(RECURRENCE_SCHEMA, j));
  });

  it('스키마는 깨진 값을 거른다 (status 5종 밖·필수 칸 없음·갈래 enum)', () => {
    const f = readFixture(RECURRENCE_SCHEMA);
    const broken: J[] = [];
    broken.push({ ...clone(f), status: 'measured' });
    const noCounts = clone(f); delete noCounts.counts; broken.push(noCounts);
    const badCounts = clone(f); delete badCounts.per30d.written; broken.push(badCounts);
    const badItem = clone(f); badItem.items[0].branch = 'repeat'; broken.push(badItem);
    const badVerdict = clone(f); badVerdict.items[0].pairs.push({ tier: 'memory', key: 'k', kind: 'x', text: 't', score: 0, verdict: 'maybe' }); broken.push(badVerdict);
    const noRun = clone(f); delete noRun.runId; broken.push(noRun);
    broken.push({ schema: RECURRENCE_SCHEMA, status: 'no-data', statusNote: 'x' }); // runId 없음
    broken.push({ schema: 'forgen-audit-recurrence/1', status: 'no-data', statusNote: 'x', runId: null });
    for (const b of broken) expectFail(RECURRENCE_SCHEMA, b);
    for (const s of ['ok', 'insufficient', 'incomplete', 'model-off', 'no-data']) expectPass(RECURRENCE_SCHEMA, { ...clone(f), status: s });
  });
});

describe('forgen status --rate-limit --json (K2-b)', () => {
  const ID = 'forgen-rate-limit/v1';

  it('샘플이 없으면 빈 목록, 쓰기 없음', async () => {
    fs.rmSync(SAMPLES_PATH, { force: true });
    const r = await readOnly(() => handleStatus(['--rate-limit', '--json']));
    expect(JSON.parse(r.out)).toEqual({ schema: ID, samples: [] });
    expect(fs.existsSync(SAMPLES_PATH)).toBe(false);
  });

  it('원본 샘플 형식 그대로 내고, 압축(재작성)도 하지 않는다', async () => {
    const now = Date.now();
    const lines = [
      { w: 'five_hour', t: now - 10 * 86_400_000, used: 1, resets_at: 1 }, // 7일 넘음 — 읽기 경로(readSamples)가 뺀다
      { w: 'five_hour', t: now - 3_600_000, used: 12.5, resets_at: Math.floor(now / 1000) + 3600 },
      { w: 'seven_day', t: now - 1_800_000, used: 40, resets_at: null },
      { w: 'five_hour', t: now - 60_000, used: 14, resets_at: Math.floor(now / 1000) + 3600 },
    ];
    // 압축 조건(크기 ≥ 256KB·조용한 시간)을 채워도 읽기 경로는 다시 쓰지 않아야 한다
    const body = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"w":"five_hour","t":잘린줄\n${'\n'.repeat(300 * 1024)}`;
    W(SAMPLES_PATH, body);
    const old = new Date(now - 3_600_000);
    fs.utimesSync(SAMPLES_PATH, old, old);
    const r = await readOnly(() => handleStatus(['--rate-limit', '--json']));
    const j = JSON.parse(r.out) as J;
    expect(j).toEqual({ schema: ID, samples: readSamples() });
    expect(j.samples).toEqual(lines.slice(1));
    expect(fs.readFileSync(SAMPLES_PATH, 'utf-8')).toBe(body);
    expectPass(ID, j);
    expectPass(ID, fixture(ID, j));
  });

  it('--latest: 창마다 가장 늦은 샘플 하나만, 같은 형식', async () => {
    const now = Date.now();
    const lines = [
      { w: 'five_hour', t: now - 3_600_000, used: 12.5, resets_at: Math.floor(now / 1000) + 3600 },
      { w: 'seven_day', t: now - 1_800_000, used: 40, resets_at: null },
      { w: 'five_hour', t: now - 60_000, used: 14, resets_at: Math.floor(now / 1000) + 3600 },
      { w: 'seven_day', t: now - 2_400_000, used: 39, resets_at: null },
    ];
    const body = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
    W(SAMPLES_PATH, body);
    const r = await readOnly(() => handleStatus(['--rate-limit', '--json', '--latest']));
    const j = JSON.parse(r.out) as J;
    expect(j).toEqual({ schema: ID, samples: [lines[2], lines[1]] });
    expect(fs.readFileSync(SAMPLES_PATH, 'utf-8')).toBe(body);
    expectPass(ID, j);
    fs.rmSync(SAMPLES_PATH);
    const empty = await readOnly(() => handleStatus(['--rate-limit', '--json', '--latest']));
    expect(JSON.parse(empty.out)).toEqual({ schema: ID, samples: [] });
  });

  it('--json 없는 --rate-limit 은 예전처럼 알 수 없는 옵션 오류', async () => {
    const r = await readOnly(() => handleStatus(['--rate-limit']));
    expect(r.out).toBe('');
    expect(r.err).toContain('알 수 없는 status 옵션: --rate-limit');
  });

  it('스키마는 깨진 샘플을 거른다', () => {
    const f = readFixture(ID);
    const s = f.samples[0];
    for (const bad of [{ ...s, w: 'hourly' }, { ...s, t: '1' }, { w: s.w, t: s.t, used: s.used }, { ...s, resets_at: 'soon' }]) expectFail(ID, { schema: ID, samples: [bad] });
    expectFail(ID, { schema: 'forgen-rate-limit/v2', samples: [] });
    expectFail(ID, { schema: ID });
  });
});

describe('forgen project which --json (K2-b)', () => {
  const ID = 'forgen-project-which/1';
  it('폴더가 풀리는 키를 JSON 하나로, 쓰기 없음', async () => {
    const r = await readOnly(async () => handleProject(['which', PROJ, '--json']));
    const j = JSON.parse(r.out) as J;
    expect(j).toEqual({ schema: ID, folder: PROJ, key: 'proj-ro' });
    expectPass(ID, j);
    expectPass(ID, fixture(ID, j));
  });
  it('프로젝트가 아니면 key: null, --json 없으면 예전 한 줄 그대로', async () => {
    const none = path.join(ROOT, 'not-a-project');
    fs.mkdirSync(none, { recursive: true });
    const r = await readOnly(async () => handleProject(['which', '--json', none]));
    expect(JSON.parse(r.out)).toEqual({ schema: ID, folder: none, key: null });
    const line = await readOnly(async () => handleProject(['which', PROJ]));
    expect(line.out).toBe(`${PROJ} → proj-ro`);
  });
  it('스키마는 깨진 값을 거른다', () => {
    expectFail(ID, { schema: ID, folder: '/x' });
    expectFail(ID, { schema: ID, folder: '/x', key: 3 });
    expectFail(ID, { schema: 'forgen-project-which/2', folder: '/x', key: null });
  });
});
