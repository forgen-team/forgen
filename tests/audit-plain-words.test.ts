/**
 * 0.9.1 #3·#3a·#4·#5·#6 — 사용자가 보는 화면(감사 첫 화면·fix --list·fix <id>·fix --report·audit recurrence·감사 HTML)에
 * 내부 용어가 없고, 첫 화면은 "가장 중요한 발견 → 요약 → 다음에 할 일", 목록은 "추천 순서 + 종류 설명 + 처방 한 줄(무엇을 → 어떻게 — 안 하면)" 모양이다.
 * 금지어 테스트만으로는 통과가 아니다(다른 말로 바꾼 내부 용어도 걸린다) — 실데이터 출력 전문을 사람이 읽는 확인은 따로 한다.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installFakeJudge } from './helpers/fake-claude-judge.js';
import { addRules, buildFixture, W } from './helpers/audit-fixture.js';

/** 비밀처럼 보이는 가짜 값(저장소 비밀 검사에 걸리지 않게 실행 중에 만든다) */
const FAKE_KEY = ['sk', 'abcdefghijklmnopqrstuv'].join('-');
const FAKE_GH = ['ghp', 'abcdefghijklmnopqrstuvwx'].join('_');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-aplain-')));
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

const { handleFix } = await import('../src/audit/fix-cli.js');
const { handleAudit } = await import('../src/audit/cli.js');
const { summaryLines } = await import('../src/audit/recurrence-cli.js');
const { RECURRENCE_SCHEMA } = await import('../src/audit/recurrence.js');
const { createRule, saveRule } = await import('../src/store/rule-store.js');

/** 내부 용어 — 화면에 나오면 안 된다(사용자 내용·명령 이름·처방 id 는 빼고 본다). */
export const BANNED = ['N2', 'N3', 'N4', '같은 집합', '되살린 룰', '이전 정의', 'Q3', 'Q4', 'Q11', '기억 풀', '1,000개당', '1층', '2층', 'tier2', '판본', '갈래', '자격 게이트', '결정적', '렌더', '주입', '호스트', '2-gram', '캐시', '몫', '판정자', '회차', '원장', '색인', '하네스', '지적만', '사전 필터', 'superseded', 'suppressed'];
const banned = (text: string) => BANNED.filter((w) => text.includes(w));

const ARGS = () => [...FX.folders.flatMap((f) => ['--folder', f]), '--claude-dir', FX.claude];
const quiet = async (fn: () => Promise<unknown>): Promise<string> => {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.map(String).join(' ')); });
  const err = vi.spyOn(console, 'error').mockImplementation((...a) => { lines.push(a.map(String).join(' ')); });
  try { await fn(); return lines.join('\n'); } finally { log.mockRestore(); err.mockRestore(); }
};
const recResult = () => ({
  schema: RECURRENCE_SCHEMA, status: 'ok', statusNote: '', generatedAt: '2026-11-01T00:00:00.000Z',
  window: { since: '2026-10-01T00:00:00.000Z', until: '2026-11-01T00:00:00.000Z', lookbackDays: 30, days: 31 },
  judge: { correction: { model: 'h', version: 'v' }, pair: { model: 's', version: 'v' }, prefilterMin: 0.05 },
  prompts: { window: 200, lookback: 0, sampled: 200, judged: 200, unjudged: 0, limit: null, per30d: 200 },
  corrections: { total: 30, taskSpecific: 1, lookback: 0, per1000: 150, per30d: 30, becameMemory: 2 },
  counts: { ignored: 6, notLoaded: 6, written: 12, unwrittenRepeat: 3, deletedRepeat: 0, total: 15, tier2Missed: 1 },
  per1000: { ignored: 30, notLoaded: 30, written: 60, unwrittenRepeat: 15, deletedRepeat: 0, total: 75 },
  per30d: { ignored: 6, notLoaded: 6, written: 12, unwrittenRepeat: 3, deletedRepeat: 0, total: 15, tier2Missed: 1 },
  ci95per1000: { total: [40, 110], written: [30, 90] },
  unknown: 2, pairsJudged: 40,
  memory: { items: 50, byKind: { 'forgen-rule': 20, 'memory-topic': 10, 'memory-index': 10, 'host-md': 10 }, unknownTime: 3, deleted: 1 },
  biweekly: [{ from: '2026-10-01T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z', prompts: 100, corrections: 15, total: 7, per1000: 70, tier2Missed: 1 }],
  notes: [] as string[],
  items: [
    { id: 'i1', session: 's1', ts: '2026-10-20T00:00:00.000Z', cwd: FX.A, gist: '배포 전에 확인하라', utterance: `아니 배포 전에 먼저 확인하라고 했잖아 ${FAKE_KEY}`, taskSpecific: false, branch: 'not-loaded', becameMemory: false, unknown: 0, pairs: [], match: { key: 'k', kind: 'forgen-rule', text: '배포 전에 확인한다', reason: 'budget-or-other' } },
  ],
});

beforeAll(() => {
  addRules(createRule as never, saveRule as never, path.join(FX.forgenHome, 'me', 'rules', 'broken.json'));
  W(path.join(FX.claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'helper@claude-plugins-official': true, 'helper@other-market': true } }, null, 2));
  W(path.join(FX.forgenHome, 'audit', 'recurrence', '20261101T000000Z-aaaaaaaa', 'result.json'), JSON.stringify(recResult()));
});
afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('0.9.1 화면 — 내부 용어 없음 · 첫 화면 모양', () => {
  let auditOut = '';
  it('감사 첫 화면: 가장 중요한 발견(장면 + 근거) → 요약 → 다음에 할 일, 내부 용어 없음', async () => {
    auditOut = await quiet(() => handleAudit([...ARGS(), '--no-open']));
    expect(banned(auditOut)).toEqual([]);
    const iFind = auditOut.indexOf('가장 중요한 발견');
    const iSum = auditOut.indexOf('\n요약\n');
    const iNext = auditOut.indexOf('다음에 할 일');
    expect(iFind).toBeGreaterThan(-1);
    expect(iSum).toBeGreaterThan(iFind);
    expect(iNext).toBeGreaterThan(iSum);
    const findings = auditOut.slice(iFind, iSum).split('\n').filter((l) => /^ {2}\d\. /.test(l));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.length).toBeLessThanOrEqual(3);
    for (const f of findings) expect(f).toMatch(/ → 이대로면 .+ → 처방: /);
    expect(auditOut).toMatch(/\n {5}근거: /);
    // 실제 교정 인용은 날짜·앞부분·비밀 가림
    expect(auditOut).not.toContain(FAKE_KEY);
    // #5: 모델 판정이 있으면 "섞임 의심" 토큰은 화면에 없고, 섞임 수는 판정 한 출처에서만
    expect(auditOut).not.toContain('섞임 의심');
    const mix = /다른 프로젝트 지시 섞임 (\d+)개/.exec(auditOut)?.[1];
    expect(mix).toBeTruthy();
  });

  it('감사 HTML: 고정 문구에 내부 용어 없음(데이터 제외)', () => {
    const dirs = fs.readdirSync(path.join(FX.forgenHome, 'audit')).filter((n) => /^\d{8}T/.test(n)).sort();
    const html = fs.readFileSync(path.join(FX.forgenHome, 'audit', dirs[dirs.length - 1], 'audit.html'), 'utf-8');
    const fixed = html.replace(/<script[^>]*id="forgen-data"[^>]*>[\s\S]*?<\/script>/, '').replace(/<style>[\s\S]*?<\/style>/g, '');
    // 공용 DOM 도우미의 상태 키(suppressed 등)는 화면 글이 아니다
    expect(banned(fixed).filter((w) => !/^[a-z]+$/.test(w))).toEqual([]);
    expect(fixed).toContain('가장 중요한 발견');
  });

  it('fix --list: 추천 순서 1~3줄 + 종류마다 한 줄 설명 + 처방마다 "→ … — 안 하면", 내부 용어·룰 ID 없음', async () => {
    const out = await quiet(() => handleFix(['--list', ...ARGS()]));
    expect(banned(out)).toEqual([]);
    const order = out.slice(out.indexOf('추천 순서'), out.indexOf('\n\n', out.indexOf('추천 순서'))).split('\n').filter((l) => /^ {2}\d\. /.test(l));
    expect(order.length).toBeGreaterThanOrEqual(1);
    expect(order.length).toBeLessThanOrEqual(3);
    expect(out.indexOf('추천 순서')).toBeLessThan(out.indexOf('합치기'));
    expect(out).toMatch(/\n합치기 \(\d+.*\) — 같은 문장·같은 뜻 지시를 한 곳만 남긴다/);
    const fixLines = out.split('\n').filter((l) => /^ {2}[a-z-]+-[0-9a-f]{8} {2}/.test(l));
    expect(fixLines.length).toBeGreaterThan(3);
    for (const l of fixLines.filter((x) => !x.includes('그대로 둠') && !x.includes('고치세요') && !x.includes('옮기지 않음'))) expect(l).toMatch(/→ .+ — 안 하면 /);
    // 룰 UUID 는 목록에 없다(상세·--json 에만)
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('fix <id>: 한 줄 + 전/후 + 왜 + 그 아래 상세(파일 바뀜) — 상세 위에는 내부 용어 없음', async () => {
    const list = await quiet(() => handleFix(['--list', ...ARGS()]));
    const ids = [...new Set([...list.matchAll(/\n {2}([a-z-]+-[0-9a-f]{8}) {2}/g)].map((m) => m[1]))];
    const kinds = new Set<string>();
    for (const id of ids) {
      const k = id.replace(/-[0-9a-f]{8}$/, '');
      if (kinds.has(k)) continue;
      kinds.add(k);
      const out = await quiet(() => handleFix([id, ...ARGS()]));
      const head = out.split('── 상세: 바뀌는 파일 ──')[0];
      expect(banned(head), `${id}`).toEqual([]);
      expect(head).toContain('왜: ');
    }
    expect(kinds.size).toBeGreaterThan(3);
  });

  it('fix --report: 대표 숫자(세션 가중) · 중요 지침 누락은 폴더별 수 + 예 하나(UUID 없음), 내부 용어 없음', async () => {
    const out = await quiet(() => handleFix(['--report', ...ARGS()]));
    expect(banned(out)).toEqual([]);
    expect(out).toMatch(/중요 지침\(.+\) 중 그 폴더 세션 시작에 안 실린 것: \d+개/);
    expect(out).not.toMatch(/rule:[0-9a-f-]{36}/);
    const json = JSON.parse((await quiet(() => handleFix(['--report', '--json', ...ARGS()]))).replace(/^[^{]*/, ''));
    const pcts = json.folders.map((f: { pct: number }) => f.pct);
    expect(json.representativePct).toBeGreaterThanOrEqual(Math.min(...pcts));
    expect(json.representativePct).toBeLessThanOrEqual(Math.max(...pcts));
  });

  it('#14 audit --share: 숫자와 발견 유형만 — 경로·폴더·프로젝트 이름·기억 본문·비밀 없음', async () => {
    const out = await quiet(() => handleAudit([...ARGS(), '--no-open', '--share']));
    const body = out.slice(0, out.indexOf('자세히(나만 보기)'));
    expect(body).toContain('붙여 넣기용 마크다운');
    expect(body).toContain('**forgen 감사 요약**');
    expect(body).not.toMatch(/\/[\w.-]+\//); // 경로 없음
    for (const f of FX.folders) expect(body).not.toContain(path.basename(f));
    expect(body).not.toMatch(/projc|proj-a|proj-b/i);
    expect(body).not.toContain('sk-');
    expect(body).not.toContain('dq0'); // 기억 본문(심은 문장 표지) 없음
    expect(banned(body)).toEqual([]);
  });

  it('audit recurrence 요약: 내부 용어 없음, 비율은 % · 예시 인용은 비밀 가림', () => {
    const text = summaryLines(recResult() as never).join('\n');
    expect(banned(text)).toEqual([]);
    expect(text).toContain('요청 중 비율');
    expect(text).toContain('7.5%');
    expect(text).not.toContain(FAKE_KEY);
    expect(text).toContain('••••');
  });
});
