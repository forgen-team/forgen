/**
 * 0.9.0 C4 처방 `forgen fix` — docs/plans/2026-11-25-v1.0-plan.md §5, §8, §2.3, §4.3, 오너 결정 Q3·Q4, §12.1-3·4.
 * 합성 A·B·C 에 심은 문제마다 처방이 나오는지, 전부 적용 → 폴더별 토큰이 줄고(늘어난 폴더 0) 중요 지침 누락 0 · 섞임 0(쓸 수 없는 곳 제외),
 * 전부 되돌리기 → 원천 해시 원상, 그사이 바뀐 파일은 멈추고 3자 diff 를 본다. 모델은 가짜 claude. 모든 파일은 임시 HOME 안.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { installFakeJudge, readJudgeCalls } from './helpers/fake-claude-judge.js';
import { addRules, buildFixture, encodeDir, W } from './helpers/audit-fixture.js';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-afix-')));
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

const { planFixes, applyFix, undoFix, newBackupRoot, measure, lossCheck, readLedger, applyTextOps, writeBlock, unifiedDiff, skillUsage, atomicWrite, stateHash, withFixLock } = await import('../src/audit/fix.js');
const { handleFix } = await import('../src/audit/fix-cli.js');
const { Judge } = await import('../src/audit/judge.js');
const { runAudit } = await import('../src/audit/run.js');
const { defaultEnv } = await import('../src/audit/sources.js');
const { deletedItems } = await import('../src/audit/memory-items.js');
const { RECURRENCE_SCHEMA } = await import('../src/audit/recurrence.js');
const { createRule, saveRule, loadRule } = await import('../src/store/rule-store.js');
const { renderSessionStartReadOnly } = await import('../src/core/v1-bootstrap.js');

let ids: Record<string, string> = {};
const ARGS = () => [...FX.folders.flatMap((f) => ['--folder', f]), '--claude-dir', FX.claude];

/** 원천 내용 해시(경로 + 내용). forgen 의 감사·처방 기록(audit/, backups/)과 판정 캐시는 결과물이라 뺀다. */
function hashTree(dirs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  // state/ 는 모델 호출 기록(extraction-events·haiku-status) — 기억 원천이 아니다
  const skip = [path.join(FX.forgenHome, 'audit'), path.join(FX.forgenHome, 'backups'), path.join(FX.forgenHome, 'state')];
  const walk = (d: string) => {
    let names: string[] = [];
    try { names = fs.readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      if (skip.some((s) => p === s || p.startsWith(`${s}/`)) || n.endsWith('.lock')) continue;
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out[p] = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  for (const d of dirs) walk(d);
  return out;
}
const SRC = () => hashTree([FX.home, path.join(ROOT, 'work')]);

const quiet = async <T>(fn: () => Promise<T>): Promise<{ out: string; value: T }> => {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.map(String).join(' ')); });
  const err = vi.spyOn(console, 'error').mockImplementation((...a) => { lines.push(a.map(String).join(' ')); });
  try { const value = await fn(); return { out: lines.join('\n'), value }; } finally { log.mockRestore(); err.mockRestore(); }
};

beforeAll(() => {
  ids = addRules(createRule as never, saveRule as never, path.join(FX.forgenHome, 'me', 'rules', 'broken.json'));
  // 플러그인: 같은 이름이 두 마켓에서 켜짐 + 예전 이름 명령 폴더 + 30일 안 쓴 forgen 스킬
  W(path.join(FX.claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'helper@claude-plugins-official': true, 'helper@other-market': true, 'solo@x': true } }, null, 2));
  W(path.join(FX.claude, 'commands', 'tenetx', 'autopilot.md'), '---\ndescription: legacy synthetic command\n---\nbody\n');
  W(path.join(FX.claude, 'skills', 'forgen-unused', 'SKILL.md'), '---\nname: forgen-unused\ndescription: synthetic skill nobody calls\n---\nbody\n');
  W(path.join(FX.claude, 'skills', 'forgen-used', 'SKILL.md'), '---\nname: forgen-used\ndescription: synthetic skill that is called\n---\nbody\n');
  W(path.join(FX.claude, 'projects', encodeDir(FX.A), 's1.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'forgen-used' } }] } }).replace('"skill": "', '"skill":"')}\n`);
  // 적히지 않은 채 반복된 교정 2개(서로 짝) — 재생 결과(audit recurrence)를 합성으로 둔다
  const item = (id: string, other: string, ts: string) => ({
    id, session: `s-${id}`, ts, cwd: FX.A, gist: 'tq90 확인 없이 배포하지 말고 먼저 물어볼 것', utterance: '합성 발화', taskSpecific: false, branch: 'unwritten-repeat', becameMemory: false, unknown: 0,
    pairs: [{ tier: 'earlier', key: `replay:${other}`, kind: 'earlier:replay', text: 'tq90', score: 0.5, verdict: 'yes' }],
  });
  W(path.join(FX.forgenHome, 'audit', 'recurrence', '20261101T000000Z-aaaaaaaa', 'result.json'), JSON.stringify({
    schema: RECURRENCE_SCHEMA, status: 'insufficient', statusNote: '합성', generatedAt: '2026-11-01T00:00:00.000Z',
    window: { since: '2026-10-01T00:00:00.000Z', until: '2026-11-01T00:00:00.000Z', lookbackDays: 30, days: 31 },
    prompts: { window: 20, lookback: 0, sampled: 20, judged: 20, unjudged: 0, limit: null, per30d: 20 },
    corrections: { total: 2, taskSpecific: 0, lookback: 0, per1000: 100, per30d: 2, becameMemory: 0 },
    counts: { ignored: 0, notLoaded: 0, written: 0, unwrittenRepeat: 2, deletedRepeat: 0, total: 2 },
    per1000: { ignored: 0, notLoaded: 0, written: 0, unwrittenRepeat: 100, deletedRepeat: 0, total: 100 },
    per30d: { ignored: 0, notLoaded: 0, written: 0, unwrittenRepeat: 2, deletedRepeat: 0, total: 2 },
    memory: { items: 0, byKind: {}, unknownTime: 0, deleted: 0 },
    items: [item('p1', 'p2', '2026-10-05T00:00:00.000Z'), item('p2', 'p1', '2026-10-20T00:00:00.000Z')],
  }));
});
afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('처방 계획 — 합성 A·B·C', () => {
  it('심은 문제마다 처방(재현율 ≥ 80%), 쓸 수 없는 곳은 지적만(Q3)', async () => {
    const p = await planFixes({ folders: FX.folders, claudeDir: FX.claude, judge: new Judge({ model: true }) });
    const of = (k: string) => p.fixes.filter((f) => f.kind === k);
    const ready = (k: string) => of(k).filter((f) => !f.blocked);
    // 같은 뜻(dq02: B 의 CLAUDE.md ↔ AGENTS.md, dq03: A 의 CLAUDE.md ↔ .claude/rules) + 같은 문장(SHARED) → 합치기
    const merges = ready('merge').map((f) => f.evidence.join(' '));
    const found = ['dq02', 'dq03', 'Always run the full test suite'].filter((t) => merges.some((m) => m.includes(t)));
    expect(found.length / 3).toBeGreaterThanOrEqual(0.8);
    const dq02 = ready('merge').find((f) => f.evidence.join(' ').includes('dq02'));
    expect(dq02?.model).toBe(true); // 합친 문장은 Haiku, 다시 같은 뜻 판정 통과
    // 겹치는 교정(Q4): dq01 룰은 사용자 CLAUDE.md 에 같은 뜻이 실려 주입만 뺀다, 같은 문장 룰도
    const ov = ready('overlap');
    expect(ov.some((f) => f.evidence.join(' ').includes('dq01'))).toBe(true);
    expect(ov.some((f) => f.ops.some((o) => o.op === 'rule' && o.ruleId === ids.shared))).toBe(true);
    // 섞임 확정 → 범위 옮기기(forgen 룰) · 폴더 전용 룰로 옮기기(사용자 .claude/rules) · 사용자 CLAUDE.md 는 git 밖이라 지적만
    expect(ready('scope').filter((f) => !f.manual).map((f) => f.ops[0])).toEqual([expect.objectContaining({ ruleId: ids.mix, change: 'scope', projects: ['projc'] })]);
    // 중요 지침(strong) 섞임은 하나씩만(묶음 제외)
    const imp = ready('scope').find((f) => f.ops.some((o) => o.op === 'rule' && o.ruleId === ids.mixImportant));
    expect(imp?.manual).toMatch(/중요 지침/);
    // 중요 지침은 합치기에서 지워지는 쪽이 되지 않는다: dq06 은 직접 교정 룰을 남기고 채굴 룰만 대체
    const dq06 = ready('merge').find((f) => f.evidence.join(' ').includes('dq06'));
    expect(dq06?.ops.filter((o) => o.op === 'rule' && o.change === 'supersede').map((o) => (o as { ruleId: string }).ruleId)).toEqual([ids.dq06a]);
    for (const f of p.fixes) for (const o of f.ops) if (o.op === 'rule' && (o.change === 'supersede' || o.change === 'suppress')) expect([ids.dq06b, ids.dq01, ids.shared, ids.dq04, ids.rw01, ids.mixImportant]).not.toContain(o.ruleId);
    // 합친 문장의 "같은 뜻인가" 채점은 Sonnet(처방 문안 Haiku 와 다른 판정자)
    expect(readJudgeCalls(FAKE).some((l) => /^dup \d+ claude-sonnet-5-5$/.test(l))).toBe(true);
    expect(ready('move').length).toBe(1);
    expect(ready('move')[0].ops.some((o) => o.op === 'append' && o.path === path.join(FX.C, '.claude', 'rules', 'moved-projc.md'))).toBe(true);
    expect(of('move').filter((f) => f.blocked).every((f) => /git 밖/.test(f.blocked ?? ''))).toBe(true);
    expect(of('move').some((f) => f.blocked)).toBe(true);
    // 일반 원칙([[GEN]])은 옮기지 않는다
    expect(p.fixes.some((f) => f.ops.some((o) => o.op === 'rule' && o.ruleId === ids.gen && o.change === 'scope'))).toBe(false);
    // 낡음(A 의 세 줄 + 홈 메모의 없는 주제 링크) → 지우기
    const rm = ready('remove').map((f) => f.evidence.join(' '));
    expect(['missing-dir', 'missing-design', 'nonexistent-script', 'missing_topic'].filter((t) => rm.some((x) => x.includes(t))).length).toBeGreaterThanOrEqual(4);
    // 긴 룰 → 짧게(원문과 같은 뜻 판정 통과)
    expect(ready('rewrite').some((f) => f.ops.some((o) => o.op === 'rule' && o.ruleId === ids.rw01))).toBe(true);
    // 합성 C: 색인 줄 내리기(잘린 줄은 보관)
    const idx = ready('index').find((f) => f.title.includes(path.basename(FX.C)));
    expect(idx?.title).toMatch(/잘려서 안 실리던 \d+줄은 보관 파일로/);
    // 기억 추가: 짝인 반복 교정 2개 → 메모 하나(A 의 메모 폴더, 호스트 형식)
    const am = ready('add-memory');
    expect(am.length).toBe(1);
    const created = am[0].ops.find((o) => o.op === 'create') as { path: string; content: string };
    expect(created.path.startsWith(path.join(FX.claude, 'projects', encodeDir(FX.A), 'memory'))).toBe(true);
    expect(created.content).toMatch(/^---\nname: .+\ndescription: .+\n(type: feedback|metadata:\n {2}type: feedback)\n---\n/);
    // 끄기: 같은 이름 중복 플러그인 하나 · 예전 이름 명령 폴더 · 안 쓴 스킬(쓴 스킬은 아님)
    const off = ready('plugin-off').map((f) => f.title);
    expect(off.some((t) => t.includes('helper@other-market'))).toBe(true);
    expect(ready('plugin-off').some((f) => f.ops.some((o) => o.op === 'json-set' && o.keys.includes('helper@claude-plugins-official')))).toBe(false);
    expect(off.some((t) => t.includes('tenetx'))).toBe(true);
    expect(off.some((t) => t.includes('forgen-unused'))).toBe(true);
    expect(off.some((t) => t.includes('forgen-used'))).toBe(false);
    // 같은 입력이면 같은 처방 ID
    const again = await planFixes({ folders: FX.folders, claudeDir: FX.claude, judge: new Judge({ model: true }) });
    expect(again.fixes.map((f) => f.id)).toEqual(p.fixes.map((f) => f.id));
  }, 30_000);

  it('--no-model: 결정적 처방만(모델 호출 0 — 같은 문장 정리·지우기·색인·끄기)', async () => {
    const n = readJudgeCalls(FAKE).length;
    const p = await planFixes({ folders: FX.folders, claudeDir: FX.claude, judge: null });
    expect(readJudgeCalls(FAKE).length).toBe(n);
    const kinds = new Set(p.fixes.filter((f) => !f.blocked).map((f) => f.kind));
    for (const k of ['rewrite', 'add-memory', 'scope', 'move']) expect(kinds.has(k as never)).toBe(false);
    for (const k of ['merge', 'remove', 'index', 'plugin-off', 'overlap']) expect(kinds.has(k as never)).toBe(true);
    expect(p.fixes.every((f) => !f.model)).toBe(true);
  });

  it('Q3 쓰기 범위: 관리형·git 밖 지침 파일은 막고, 메모·rules·git 안 CLAUDE.md 는 허용', () => {
    const env = { ...defaultEnv(FX.claude), managedPaths: ['/etc/claude-code/CLAUDE.md'] };
    expect(writeBlock('/etc/claude-code/CLAUDE.md', env)).toMatch(/관리하는 정책 파일/);
    expect(writeBlock(path.join(FX.claude, 'CLAUDE.md'), env)).toMatch(/git 밖/);
    expect(writeBlock(path.join(FX.A, 'CLAUDE.md'), env)).toBeNull();
    expect(writeBlock(path.join(FX.B, 'AGENTS.md'), env)).toBeNull();
    expect(writeBlock(path.join(FX.claude, 'rules', 'global.md'), env)).toBeNull();
    expect(writeBlock(path.join(FX.claude, 'projects', 'x', 'memory', 'MEMORY.md'), env)).toBeNull();
    expect(applyTextOps('a\n- b\nc\n', [{ op: 'delete-line', path: 'x', text: '- b' }])).toBe('a\nc\n');
    expect(() => applyTextOps('a\n', [{ op: 'delete-line', path: 'x', text: 'zz' }])).toThrow(/바뀌었다/);
    expect(unifiedDiff('a\nb\nc', 'a\nc', 'f').join('\n')).toContain('-b');
    expect(skillUsage(path.join(ROOT, 'nope'), ['x'])).toBeNull();
  });
});

describe('전부 적용 → 측정 → 전부 되돌리기 (§9.1 0.9.0 확인 조건)', () => {
  it('폴더별 토큰이 줄고 늘어난 폴더 0 · 중요 지침 누락 0 · 섞임은 쓸 수 없는 곳만 · 되돌리면 해시 원상', async () => {
    const before = SRC();
    const run0 = runAudit({ folders: FX.folders, claudeDir: FX.claude });
    const m0 = measure(run0);
    const applied = await quiet(() => handleFix(['--kind', 'all', '--apply', ...ARGS()]));
    expect(applied.out).toMatch(/처방 \d+개 적용/);
    const ledger = readLedger();
    const appliedKinds = new Set(ledger.filter((e) => e.event === 'apply').map((e) => e.kind));
    for (const k of ['plugin-off', 'remove', 'merge', 'overlap', 'scope', 'move', 'rewrite', 'index', 'add-memory']) expect(appliedKinds.has(k as never)).toBe(true);
    // 호스트 형식: 기억 추가는 주제 파일 + 색인 줄, 색인 줄 내리기는 원문을 주제 파일에 남김
    const amem = path.join(FX.claude, 'projects', encodeDir(FX.A), 'memory');
    const memo = fs.readdirSync(amem).find((n) => n.startsWith('feedback_forgen_'));
    expect(memo).toBeTruthy();
    expect(fs.readFileSync(path.join(amem, 'MEMORY.md'), 'utf-8')).toContain(`](${memo})`);
    const cmem = path.join(FX.claude, 'projects', encodeDir(FX.C), 'memory');
    expect(fs.readFileSync(path.join(cmem, 'topic_3.md'), 'utf-8')).toContain('MEMORY.md 원문');
    const cidx = fs.readFileSync(path.join(cmem, 'MEMORY.md'), 'utf-8');
    expect(cidx.split('\n').length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(cidx)).toBeLessThanOrEqual(25 * 1024);
    // Q4: 주입만 빠지고 룰은 활성으로 남는다(강제·측정용)
    const dq01 = loadRule(ids.dq01);
    expect(dq01?.status).toBe('active');
    expect(dq01?.host_copy?.path).toBe(path.join(FX.claude, 'CLAUDE.md'));
    expect(renderSessionStartReadOnly(FX.B).includedRuleIds).not.toContain(ids.dq01);
    expect(loadRule(ids.mix)?.projects).toEqual(['projc']);
    // 지운 기억은 지움 표시 + 지문 → 재발 재생이 읽는다
    const del = deletedItems(path.join(FX.forgenHome, 'audit', 'deleted.jsonl'));
    expect(del.some((d) => d.text.includes('missing-dir'))).toBe(true);
    const raw = fs.readFileSync(path.join(FX.forgenHome, 'audit', 'deleted.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(raw.every((d) => /^[0-9a-f]{12}$/.test(d.fp) && d.fix)).toBe(true);
    // 측정
    const rep = await quiet(() => handleFix(['--report', '--json', ...ARGS()]));
    const r = JSON.parse(rep.out.slice(rep.out.indexOf('{')));
    expect(r.increased).toEqual([]);
    expect(r.folders.every((f: { delta: number }) => f.delta <= 0)).toBe(true);
    expect(r.medianPct).toBeLessThan(0);
    expect(r.importantMissing).toEqual([]);
    expect(r.lostMemos).toEqual([]);
    // 섞임: 남은 것은 쓸 수 없는 사용자 CLAUDE.md 한 줄(지적만)뿐
    // + 하나씩만 적용하는 중요 지침 섞임 1(묶음에서 뺌)
    expect(r.mixConfirmed).toBe(2);
    // 기억 추가는 N3 다이어트 비교에서 따로 센다
    expect(r.folders.find((f: { folder: string }) => f.folder === FX.A).addedMemory).toBeGreaterThan(0);
    expect(r.rates.applied).toBeGreaterThan(0);
    // 누락 검사는 실제로 잡는다: 처방 기록 없이 중요 룰이 빠지면 누락
    const m1 = measure(runAudit({ folders: FX.folders, claudeDir: FX.claude }));
    expect(lossCheck(m0, m1, []).length).toBeGreaterThan(0);
    // 전부 되돌리기 → 원천 해시 원상
    const undone = await quiet(() => handleFix(['--undo', 'all']));
    expect(undone.out).not.toContain('✗');
    expect(SRC()).toEqual(before);
    expect(fs.existsSync(path.join(FX.forgenHome, 'audit', 'deleted.jsonl'))).toBe(false);
    const after = await quiet(() => handleFix(['--report', '--json', ...ARGS()]));
    const r2 = JSON.parse(after.out.slice(after.out.indexOf('{')));
    expect(r2.rates.undoRate).toBe(1);
  }, 60_000);

  it('되돌리기: 그사이 사용자가 같은 파일을 고쳤으면 멈추고 3자 diff, 아무것도 바꾸지 않는다', async () => {
    const p = await planFixes({ folders: FX.folders, claudeDir: FX.claude, judge: new Judge({ model: true }) });
    const f = p.fixes.find((x) => x.kind === 'remove' && !x.blocked && x.ops.some((o) => o.op === 'delete-line' && o.path === path.join(FX.A, 'CLAUDE.md')));
    if (!f) throw new Error('A 의 지우기 처방이 없다');
    applyFix(f, newBackupRoot());
    const file = path.join(FX.A, 'CLAUDE.md');
    fs.appendFileSync(file, '- user edit after the fix\n');
    const edited = fs.readFileSync(file, 'utf-8');
    const res = await quiet(() => handleFix(['--undo', f.id]));
    expect(res.out).toContain('세 가지 비교');
    expect(res.out).toContain('+- user edit after the fix');
    expect(fs.readFileSync(file, 'utf-8')).toBe(edited);
    expect(readLedger().at(-1)?.event).toBe('undo-conflict');
    // 사용자 편집을 걷으면 되돌릴 수 있다
    fs.writeFileSync(file, edited.replace('- user edit after the fix\n', ''));
    expect(undoFix(f.id)).toMatchObject({ restored: 1 });
    process.exitCode = 0;
  });

  it('중요 지침 범위 옮기기는 <id> --apply 로만, 적용하면 다른 폴더에서 누락으로 센다', async () => {
    const p = await planFixes({ folders: FX.folders, claudeDir: FX.claude, judge: new Judge({ model: true }) });
    const imp = p.fixes.find((f) => f.kind === 'scope' && f.manual);
    if (!imp) throw new Error('중요 지침 범위 옮기기 처방이 없다');
    const m0 = measure(p.run);
    const out = await quiet(() => handleFix([imp.id, '--apply', ...ARGS()]));
    expect(out.out).toContain(`${imp.id} 적용`);
    const m1 = measure(runAudit({ folders: FX.folders, claudeDir: FX.claude }));
    const loss = lossCheck(m0, m1, readLedger());
    expect(loss.some((l) => l.folder !== FX.C && l.missing.includes(`rule:${ids.mixImportant}`))).toBe(true);
    await quiet(() => handleFix(['--undo', imp.id]));
    expect(loadRule(ids.mixImportant)?.projects).toBeUndefined();
  }, 30_000);

  it('전역 잠금: 동시에 두 번 적용하면 하나는 기다리지 않고 실패, 죽은 프로세스의 오래된 잠금은 회수', async () => {
    const lock = path.join(FX.forgenHome, 'audit', 'fix', 'run.lock');
    // 다른 실행이 잠금을 쥔 동안(살아 있는 pid) 적용·되돌리기는 기다리지 않고 실패하고 아무것도 쓰지 않는다
    let release: () => void = () => {};
    const holder = withFixLock(() => new Promise<void>((r) => { release = r; }));
    await new Promise((r) => setTimeout(r, 50));
    const src0 = SRC();
    const b = await quiet(() => handleFix(['--kind', 'plugin-off', '--apply', ...ARGS()]));
    const u = await quiet(() => handleFix(['--undo', 'all']));
    expect(b.out).toContain('다른 forgen fix 가 적용·되돌리기 중');
    expect(u.out).toContain('다른 forgen fix 가 적용·되돌리기 중');
    expect(SRC()).toEqual(src0);
    release();
    await holder;
    expect(fs.existsSync(lock)).toBe(false);
    const a = await quiet(() => handleFix(['--kind', 'plugin-off', '--apply', ...ARGS()]));
    expect(a.out).toMatch(/처방 [1-9]\d*개 적용/);
    // 죽은 pid · 31초 전 잠금 → 회수하고 진행
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, ts: Date.now() - 31_000, token: 'x' }));
    const old = new Date(Date.now() - 31_000);
    fs.utimesSync(lock, old, old);
    const c = await quiet(() => handleFix(['--undo', 'all']));
    expect(c.out).not.toContain('다른 forgen fix');
    expect(fs.existsSync(lock)).toBe(false);
    process.exitCode = 0;
  }, 60_000);

  it('원자적 쓰기: 심링크는 대상에 쓰고 임시 파일을 남기지 않는다, 상태 지문은 대상 기준', () => {
    const real = path.join(ROOT, 'link-target.md');
    const link = path.join(ROOT, 'link.md');
    fs.writeFileSync(real, 'a\n');
    fs.symlinkSync(real, link);
    const h0 = stateHash(link);
    atomicWrite(link, 'b\n');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf-8')).toBe('b\n');
    expect(stateHash(link)).not.toBe(h0);
    expect(stateHash(link)).toBe(stateHash(real));
    expect(fs.readdirSync(ROOT).filter((n) => n.includes('.forgen-fix-'))).toEqual([]);
  });

  it('CLI: --list · <id>(diff) · 모르는 옵션은 실패', async () => {
    const list = await quiet(() => handleFix(['--list', ...ARGS()]));
    expect(list.out).toMatch(/처방 \d+개 · 고치지 않고 알려만 주는 것 \d+개/);
    const id = /\n {2}(remove-[0-9a-f]{8})/.exec(list.out)?.[1];
    expect(id).toBeTruthy();
    const shown = await quiet(() => handleFix([id as string, ...ARGS()]));
    expect(shown.out).toContain('---');
    expect(shown.out).toContain(`forgen fix ${id} --apply`);
    const bad = await quiet(() => handleFix(['--bogus']));
    expect(bad.out).toContain('알 수 없는 fix 옵션');
    process.exitCode = 0;
  });
});
