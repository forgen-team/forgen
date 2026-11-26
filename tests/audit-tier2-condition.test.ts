/**
 * 0.9.0 두 층 발동 조건 처방 `forgen fix` tier2-condition (오너 결정 2026-11-26).
 * 자격 게이트를 못 넘은 룰 중 근거 상황이 없는 것에 "언제 쓰는지" 초안(Haiku = 가짜 판정기, 결정적 후보 같이) → 목록 → 빼 두기 → 일괄 승인
 * → 승인 조건이 게이트를 대신(2층) → 2층 미발동이면 1층·90일 재자격 → 되돌리면 1층. 모든 파일은 임시 HOME·FORGEN_HOME 안. 문장은 합성.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installFakeJudge, readJudgeCalls } from './helpers/fake-claude-judge.js';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-t2cond-')));
const HOME = path.join(ROOT, 'home');
const FH = path.join(HOME, '.forgen');
const CLAUDE = path.join(HOME, '.claude');
const BIN = path.join(ROOT, 'bin');
const FAKE = path.join(ROOT, 'fake-state');
const FOLDER = path.join(HOME, 'ws', 'proj-c');
for (const d of [CLAUDE, FAKE, path.join(FOLDER, '.git'), path.join(FH, 'me', 'rules'), path.join(FH, 'state')]) fs.mkdirSync(d, { recursive: true });
installFakeJudge(BIN);
const PREV = { HOME: process.env.HOME, FORGEN_HOME: process.env.FORGEN_HOME, FORGEN_CWD: process.env.FORGEN_CWD, PATH: process.env.PATH, FAKE_STATE: process.env.FAKE_STATE };
process.env.HOME = HOME;
process.env.FORGEN_HOME = FH;
process.env.FAKE_STATE = FAKE;
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
delete process.env.FORGEN_CWD;

const { planFixes, conditionLine, excludedFixes } = await import('../src/audit/fix.js');
const { handleFix } = await import('../src/audit/fix-cli.js');
const { Judge } = await import('../src/audit/judge.js');
const T = await import('../src/core/tier2.js');
const { loadRule } = await import('../src/store/rule-store.js');
const { renderSessionStartReadOnly } = await import('../src/core/v1-bootstrap.js');
import type { Rule } from '../src/store/types.js';

afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const OLD = '2026-08-01T00:00:00.000Z';
function rule(id: string, policy: string, extra: Partial<Rule> = {}): Rule {
  return { rule_id: id, category: 'workflow', scope: 'me', trigger: 't', policy, strength: 'default', source: 'explicit_correction', status: 'active', evidence_refs: [], render_key: `k.${id}`, created_at: OLD, updated_at: OLD, ...extra } as Rule;
}
const RULES = [
  rule('c-cmd', '배포 전에 [[CMD:eas build]] 로 미리 빌드해 본다 cwdeploy cwcanary'),
  rule('c-onb', '계획 문서는 [[PATH]] 아래에 날짜와 함께 남긴다 cwplans', { source: 'onboarding' }),
  rule('c-strong', '강한 합성 룰 cwstrong', { strength: 'strong' }),
  rule('c-recent', '최근 합성 교정 cwrecent', { created_at: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
  rule('c-gate', '게이트에서 발동 못 한 합성 룰 cwmissed'),
  rule('c-wide', '어디서나 나오는 합성 룰 cwwide cwalpha'),
  rule('c-safe', '배포 스크립트에서 rm -rf 전에 대상 경로를 확인한다 cwsafe'),
  rule('c-enf', '강제되는 합성 룰 cwenf', { enforce_via: [{ hook: 'PreToolUse', mech: 'A' }] as never }),
];
// 과거 세션(발동률 추정): 5세션 모두 cwwide 낱말 → c-wide 넓음, 1세션만 eas build → c-cmd 20%, docs/plans 경로는 없음 → c-onb 좁음
{
  const proj = path.join(CLAUDE, 'projects', '-ws-proj-c');
  fs.mkdirSync(proj, { recursive: true });
  for (let i = 0; i < 5; i++) {
    const t = (k: number) => new Date(Date.now() - 86_400_000 + i * 600_000 + k * 1000).toISOString();
    const lines = [
      { type: 'user', sessionId: `s${i}`, cwd: FOLDER, timestamp: t(0), message: { role: 'user', content: `cwwide cwalpha 작업 ${i} 해 줘` } },
      { type: 'assistant', sessionId: `s${i}`, cwd: FOLDER, timestamp: t(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: i === 0 ? 'npx eas build --profile preview' : 'ls -la' } }] } },
    ];
    fs.writeFileSync(path.join(proj, `s${i}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  }
}
for (const r of RULES) fs.writeFileSync(path.join(FH, 'me', 'rules', `${r.rule_id}.json`), JSON.stringify(r));
const entry = (reason: string) => ({ qualified: false, reason, words: ['x', 'y', 'z'], topics: [], contexts: reason === 'no-context' ? 0 : 1, fired: 0 });
fs.writeFileSync(path.join(FH, 'state', 'tier2-index.json'), JSON.stringify({
  version: 1, generatedAt: OLD, params: { k: 3, turns: 3, minFireRate: 0.8, maxFreq: 0.05 },
  rules: { 'c-cmd': entry('no-context'), 'c-onb': entry('no-context'), 'c-strong': entry('no-context'), 'c-recent': entry('no-context'), 'c-gate': entry('missed'), 'c-wide': entry('no-context'), 'c-safe': entry('no-context'), 'c-enf': entry('no-context') }, recur: {},
}));
const idxBefore = fs.readFileSync(path.join(FH, 'state', 'tier2-index.json'), 'utf-8');
const cli = async (...a: string[]) => {
  const out: string[] = [];
  const log = console.log;
  console.log = (...x: unknown[]) => { out.push(x.join(' ')); };
  try { await handleFix([...a, '--folder', FOLDER, '--claude-dir', CLAUDE]); } finally { console.log = log; }
  return out.join('\n');
};

describe('조건 판정(결정적)', () => {
  it('conditionScore: 폴더 거르기 · 명령 글 · 경로 글롭 · 프롬프트 낱말 2개', () => {
    const c = { folders: ['proj-c'], tools: ['Bash'], commands: ['eas build'], paths: ['docs/plans/**'], words: ['배포', '카나리'] };
    expect(T.conditionScore(c, 'x', 'tool', { tool: 'Bash', command: 'npx eas build --profile p', project: 'other' })).toBe(0);
    expect(T.conditionScore(c, 'x', 'tool', { tool: 'Bash', command: 'npx eas build --profile p', project: 'proj-c' })).toBeGreaterThan(0);
    expect(T.conditionScore(c, 'x', 'tool', { tool: 'Read', paths: ['/r/docs/plans/a.md'], project: 'proj-c' })).toBe(0); // 도구가 다름
    expect(T.conditionScore({ paths: ['docs/plans/**'] }, 'x', 'tool', { tool: 'Read', paths: ['/r/docs/plans/2026/a.md'] })).toBeGreaterThan(0);
    expect(T.conditionScore({ words: ['배포', '카나리'] }, '오늘 배포 해 줘', 'prompt')).toBe(0);
    expect(T.conditionScore({ words: ['배포', '카나리'] }, '카나리 배포 해 줘', 'prompt')).toBe(2);
    expect(conditionLine(c)).toBe('폴더 proj-c · 도구 Bash · 명령 "eas build" · 경로 docs/plans/** · 낱말 배포·카나리');
  });
});

describe('안전 룰은 어떤 경로로도 2층에 가지 않는다', () => {
  it('isSafetyRule: enforce_via·enforce_mode · hard(Must Not) · safety 분류 · 파괴·비밀 패턴(한국어 포함)', () => {
    const base = rule('s', '평범한 합성 룰');
    expect(T.isSafetyRule(base)).toBe(false);
    expect(T.isSafetyRule({ ...base, enforce_mode: 'advise' })).toBe(true);
    expect(T.isSafetyRule({ ...base, strength: 'hard' })).toBe(true);
    expect(T.isSafetyRule({ ...base, category: 'safety' })).toBe(true);
    for (const p of ['git push --force 금지', 'force push 하지 말 것', 'DROP TABLE 전에 백업', '.env 파일은 커밋하지 않는다', 'API key 를 로그에 남기지 않는다', '비밀키 노출 주의', '강제 푸시 금지', '데이터를 삭제하기 전에 확인', '되돌릴 수 없는 작업은 묻는다', 'credential 파일', 'rm -rf 전에 확인'])
      expect(T.isSafetyRule({ ...base, policy: p }), p).toBe(true);
  });
  it('게이트 통과·승인 조건·재자격 모두 안전 룰은 1층(safety)', () => {
    const idx = { version: 1, generatedAt: OLD, params: { k: 3, turns: 3, minFireRate: 0.8, maxFreq: 0.05 }, rules: { s1: { qualified: true, reason: 'fired', words: ['a', 'b', 'c'], topics: [], contexts: 1, fired: 1 } }, recur: { s1: { lastAt: '2026-01-01T00:00:00.000Z', kind: 'tier2-missed' as const, count: 1 } } };
    const r = rule('s1', '프로덕션 데이터 삭제 전에 백업한다', { applies_when: { words: ['백업'], approved: { at: OLD } } });
    expect(T.tierOf(r, idx as never)).toEqual({ tier: 1, reason: 'safety' });
    expect(T.tierOf(r, null)).toEqual({ tier: 1, reason: 'safety' });
    expect(T.tier2Assignment([r], idx as never).size).toBe(0);
  });
});

describe('forgen fix tier2-condition', () => {
  let ids: Record<string, string> = {};
  it('초안: 근거 상황이 없고 1층 정의에 안 드는 룰만(strong·30일·게이트 발동 못 함은 빼고), 모델 초안 + 결정적 후보, 없는 도구는 버림', async () => {
    const p = await planFixes({ folders: [FOLDER], claudeDir: CLAUDE, judge: new Judge({ model: true }) });
    const fx = p.fixes.filter((f) => f.kind === 'tier2-condition');
    const rid = (f: (typeof fx)[number]) => (f.ops[0] as { ruleId: string }).ruleId;
    expect(fx.map(rid).sort()).toEqual(['c-cmd', 'c-onb', 'c-wide']); // 안전 룰(rm -rf 패턴·enforce_via)은 후보가 아님
    ids = Object.fromEntries(fx.map((f) => [rid(f), f.id]));
    const cmd = fx.find((f) => rid(f) === 'c-cmd');
    expect(cmd?.model).toBe(true);
    expect(cmd?.title).toContain('← 어느 폴더나 · 도구 Bash · 명령 "eas build" · 낱말 cwdeploy·cwcanary');
    expect(cmd?.title).not.toContain('NotATool');
    expect(cmd?.evidence.join('\n')).toContain('결정적 후보: 낱말');
    expect(fx.find((f) => rid(f) === 'c-onb')?.title).toContain('경로 docs/plans/**');
    // 발동률 추정: 넓음(세션 100%, 2차 초안으로도 못 좁힘)·좁음(0%) 경고는 개별 승인만
    expect(cmd?.title).toContain('[발동 추정 세션 20%');
    expect(cmd?.manual).toBeUndefined();
    const wide = fx.find((f) => rid(f) === 'c-wide');
    expect(wide?.title).toContain('⚠넓음');
    expect(wide?.estimate).toMatchObject({ wide: true, sessions: 1 });
    expect(wide?.manual).toContain('넓음 경고');
    const onb = fx.find((f) => rid(f) === 'c-onb');
    expect(onb?.title).toContain('세션 0%');
    expect(onb?.manual).toContain('좁음 경고');
    expect(readJudgeCalls(FAKE).some((c) => c.startsWith('condition '))).toBe(true);
    // 계획은 아무것도 쓰지 않는다(색인·룰 그대로)
    expect(fs.readFileSync(path.join(FH, 'state', 'tier2-index.json'), 'utf-8')).toBe(idxBefore);
    expect(loadRule('c-cmd')?.applies_when).toBeUndefined();
  });

  it('--no-model: 결정적 후보(룰 낱말·프로젝트)만', async () => {
    const p = await planFixes({ folders: [FOLDER], claudeDir: CLAUDE, judge: null });
    const f = p.fixes.find((x) => x.kind === 'tier2-condition' && (x.ops[0] as { ruleId: string }).ruleId === 'c-cmd');
    expect(f?.model).toBe(false);
    expect(f?.title).toMatch(/← 어느 폴더나 · 낱말 /);
  });

  it('목록 → 하나 빼 두기 → 일괄 승인: 빼 둔 것은 그대로, 승인된 룰은 "사람이 검증한 조건"으로 2층', async () => {
    const list = await cli('--list', '--kind', 'tier2-condition');
    expect(list).toContain('두 층 발동 조건(언제 쓰는지) 초안 (3)');
    expect(list).toContain('forgen fix --kind tier2-condition --apply');
    expect(await cli(ids['c-onb'], '--skip')).toContain('빼 둠');
    expect(excludedFixes().has(ids['c-onb'])).toBe(true);
    expect(await cli('--list', '--kind', 'tier2-condition')).toContain(`${ids['c-onb']}  [빼 둠]`);
    // all 에는 들어가지 않는다
    await cli('--kind', 'all', '--apply');
    expect(loadRule('c-cmd')?.applies_when).toBeUndefined();
    // --yes 없이는 요약만(넓음·좁음 경고 수), 아무것도 적용하지 않는다
    const summary = await cli('--kind', 'tier2-condition', '--apply');
    expect(summary).toContain('두 층 발동 조건 3개 — 넓음 경고 1 · 좁음 경고 1 · 빼 둠 1');
    expect(summary).toContain('일괄 승인하면 1개 적용');
    expect(loadRule('c-cmd')?.applies_when).toBeUndefined();
    const out = await cli('--kind', 'tier2-condition', '--apply', '--yes');
    expect(out).toContain('빼 둔 처방(--skip) 1개 제외');
    expect(loadRule('c-wide')?.applies_when).toBeUndefined(); // 경고 붙은 것은 일괄에서 빠짐
    const r = loadRule('c-cmd') as Rule;
    expect(r.applies_when).toMatchObject({ tools: ['Bash'], commands: ['eas build'], approved: { fix: ids['c-cmd'] }, estimate: { sessions: 0.2 } });
    expect(loadRule('c-onb')?.applies_when).toBeUndefined();
    expect(T.tierOf(r, T.loadTier2Index())).toEqual({ tier: 2, reason: 'approved' });
    const ro = renderSessionStartReadOnly(FOLDER);
    expect(ro.tier2RuleIds).toContain('c-cmd');
    expect(ro.text).not.toContain('미리 빌드해 본다');
    expect(ro.text).toContain('## Situational Rules');
    // 게이트 임계는 그대로(색인 params 불변)
    expect(T.loadTier2Index()?.params).toEqual({ k: 3, turns: 3, minFireRate: 0.8, maxFreq: 0.05 });
  });

  it('승인 조건으로 훅이 한 번 넣는다(명령) · 2층 미발동이면 1층, 90일 재발 0 이면 다시 2층', async () => {
    const SC = await import('../src/core/session-context.js');
    const sid = 'cond-sess';
    SC.recordWorkContext(sid, FOLDER, { countTurn: true });
    T.writeTier2Session(sid, [loadRule('c-cmd') as Rule], null);
    expect(await T.tier2Context(sid, 'ls -la', 'tool', { tool: 'Bash', command: 'ls -la' })).toBeNull();
    const ctx = await T.tier2Context(sid, 'npx eas build', 'tool', T.toolDetail('Bash', { command: 'npx eas build --profile preview' }));
    expect(ctx).toContain('미리 빌드해 본다');
    expect(await T.tier2Context(sid, 'npx eas build', 'tool', T.toolDetail('Bash', { command: 'npx eas build' }))).toBeNull();
    const r = loadRule('c-cmd') as Rule;
    const idx = { ...(T.loadTier2Index() as NonNullable<ReturnType<typeof T.loadTier2Index>>), recur: { 'c-cmd': { lastAt: new Date().toISOString(), kind: 'tier2-missed' as const, count: 1 } } };
    expect(T.tierOf(r, idx)).toEqual({ tier: 1, reason: 'tier2-missed' });
    expect(T.tierOf(r, idx, Date.now() + 91 * 86_400_000)).toEqual({ tier: 2, reason: 'approved' });
    // 색인이 없어도 승인 조건은 쓴다
    expect(T.tierOf(r, null).reason).toBe('approved');
  });

  it('되돌리기: 조건이 빠지고 1층으로', async () => {
    expect(await cli('--undo', ids['c-cmd'])).toContain('되돌림');
    const r = loadRule('c-cmd') as Rule;
    expect(r.applies_when).toBeUndefined();
    expect(T.tierOf(r, T.loadTier2Index()).tier).toBe(1);
    expect(renderSessionStartReadOnly(FOLDER).text).toContain('미리 빌드해 본다');
  });
});

describe('N3 같은 집합 비교(오너 결정 2026-11-26)', () => {
  it('처방 전에 실리던 집합만 센다 — 빈자리로 새로 실린 룰은 "되살린 룰"(중요 지침 수 포함)로 빼고, 이전 정의 값도 남는다', async () => {
    const { sameSetN3 } = await import('../src/audit/fix.js');
    const before = { at: OLD, folders: [{ folder: '/f', projectKey: null, tokens: 1000, skills: 0, important: [], loaded: ['rule:a', 'rule:b'], sessionRules: ['a', 'b'] }] };
    const after = { at: OLD, folders: [{ folder: '/f', projectKey: null, tokens: 950, skills: 0, important: [], loaded: ['rule:a', 'rule:c', 'rule:d'], sessionRules: ['a', 'c', 'd'] }] };
    const run = { ctx: { units: [{ ruleId: 'c', tokens: 39 }, { ruleId: 'd', tokens: 19 }], rules: new Map([['c', rule('c', 'x')], ['d', rule('d', 'y', { source: 'onboarding' })]]) } } as never;
    const [x] = sameSetN3(before as never, after as never, run);
    expect(x).toMatchObject({ tokens: 950, revived: ['c', 'd'], revivedImportant: ['c'], revivedTokens: 60, sameSet: 890 });
    // 옛 기준값(sessionRules 없음)은 loaded 의 rule: 로 대신한다
    const old = { ...before, folders: [{ ...before.folders[0], sessionRules: undefined }] };
    expect(sameSetN3(old as never, after as never, run)[0].revived).toEqual(['c', 'd']);
  });
});
