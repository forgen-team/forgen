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
];
for (const r of RULES) fs.writeFileSync(path.join(FH, 'me', 'rules', `${r.rule_id}.json`), JSON.stringify(r));
const entry = (reason: string) => ({ qualified: false, reason, words: ['x', 'y', 'z'], topics: [], contexts: reason === 'no-context' ? 0 : 1, fired: 0 });
fs.writeFileSync(path.join(FH, 'state', 'tier2-index.json'), JSON.stringify({
  version: 1, generatedAt: OLD, params: { k: 3, turns: 3, minFireRate: 0.8, maxFreq: 0.05 },
  rules: { 'c-cmd': entry('no-context'), 'c-onb': entry('no-context'), 'c-strong': entry('no-context'), 'c-recent': entry('no-context'), 'c-gate': entry('missed') }, recur: {},
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

describe('forgen fix tier2-condition', () => {
  let ids: Record<string, string> = {};
  it('초안: 근거 상황이 없고 1층 정의에 안 드는 룰만(strong·30일·게이트 발동 못 함은 빼고), 모델 초안 + 결정적 후보, 없는 도구는 버림', async () => {
    const p = await planFixes({ folders: [FOLDER], claudeDir: CLAUDE, judge: new Judge({ model: true }) });
    const fx = p.fixes.filter((f) => f.kind === 'tier2-condition');
    const rid = (f: (typeof fx)[number]) => (f.ops[0] as { ruleId: string }).ruleId;
    expect(fx.map(rid).sort()).toEqual(['c-cmd', 'c-onb']);
    ids = Object.fromEntries(fx.map((f) => [rid(f), f.id]));
    const cmd = fx.find((f) => rid(f) === 'c-cmd');
    expect(cmd?.model).toBe(true);
    expect(cmd?.title).toContain('← 어느 폴더나 · 도구 Bash · 명령 "eas build" · 낱말 cwdeploy·cwcanary');
    expect(cmd?.title).not.toContain('NotATool');
    expect(cmd?.evidence.join('\n')).toContain('결정적 후보: 낱말');
    expect(fx.find((f) => rid(f) === 'c-onb')?.title).toContain('경로 docs/plans/**');
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
    expect(list).toContain('두 층 발동 조건(언제 쓰는지) 초안 (2)');
    expect(list).toContain('forgen fix --kind tier2-condition --apply');
    expect(await cli(ids['c-onb'], '--skip')).toContain('빼 둠');
    expect(excludedFixes().has(ids['c-onb'])).toBe(true);
    expect(await cli('--list', '--kind', 'tier2-condition')).toContain(`${ids['c-onb']}  [빼 둠]`);
    // all 에는 들어가지 않는다
    await cli('--kind', 'all', '--apply');
    expect(loadRule('c-cmd')?.applies_when).toBeUndefined();
    const out = await cli('--kind', 'tier2-condition', '--apply');
    expect(out).toContain('빼 둔 처방(--skip) 1개 제외');
    const r = loadRule('c-cmd') as Rule;
    expect(r.applies_when).toMatchObject({ tools: ['Bash'], commands: ['eas build'], approved: { fix: ids['c-cmd'] } });
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
