/**
 * 0.9.0 두 층 주입 (docs/plans/2026-11-25-v1.0-plan.md §8.1 ②, 오너 결정 Q11·Q12·재자격 2026-11-26).
 * 단위(낱말·층 판정·발동·자격 게이트 재생) + 실제 dist 훅 프로세스(session-recovery → context-guard → pre/post-tool-use).
 * 모든 파일은 임시 HOME·FORGEN_HOME 안. 픽스처 문장은 전부 합성이다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const have = fs.existsSync(path.join(DIST, 'core', 'tier2.js'));

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-tier2-')));
const home = path.join(root, 'home');
const fhome = path.join(home, '.forgen');
const claudeDir = path.join(home, '.claude');
const repo = path.join(home, 'ws', 'repo-t');
for (const d of [path.join(repo, '.git'), path.join(fhome, 'me', 'rules'), path.join(fhome, 'me', 'behavior'), path.join(fhome, 'state'), claudeDir]) fs.mkdirSync(d, { recursive: true });
const PREV = { HOME: process.env.HOME, FORGEN_HOME: process.env.FORGEN_HOME, FORGEN_CWD: process.env.FORGEN_CWD };
process.env.HOME = home;
process.env.FORGEN_HOME = fhome;
delete process.env.FORGEN_CWD;

const T = await import('../src/core/tier2.js');
const { renderRulesDetailed, DEFAULT_CONTEXT } = await import('../src/renderer/rule-renderer.js');
const { renderSessionStartReadOnly } = await import('../src/core/v1-bootstrap.js');
const { readSessionRenders, rulesLoadedAt, tier2PendingAt } = await import('../src/core/session-renders.js');
import type { Rule } from '../src/store/types.js';

const OLD = '2026-08-01T00:00:00.000Z';
function rule(id: string, policy: string, extra: Partial<Rule> = {}): Rule {
  return { rule_id: id, category: 'workflow', scope: 'me', trigger: 't', policy, strength: 'default', source: 'explicit_correction', status: 'active', evidence_refs: [], render_key: `k.${id}`, created_at: OLD, updated_at: OLD, ...extra } as Rule;
}
function writeRule(r: Rule) { fs.writeFileSync(path.join(fhome, 'me', 'rules', `${r.rule_id}.json`), JSON.stringify(r)); }
function index(rules: Record<string, Partial<import('../src/core/tier2.js').Tier2Entry>>, recur: Record<string, import('../src/core/tier2.js').Tier2Recur> = {}) {
  const full = Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, { qualified: true, reason: 'fired', words: [], topics: [], contexts: 1, fired: 1, ...v }]));
  return { version: 1, generatedAt: OLD, params: { k: 3, turns: 3, minFireRate: 0.8, maxFreq: 0.05 }, rules: full, recur };
}

const R_HARD = rule('hard1', '비밀 파일을 커밋하지 않는다', { strength: 'hard', category: 'safety' });
const R_STRONG = rule('strong1', '배포 전에 오너 승인을 받는다', { strength: 'strong' });
const R_RECENT = rule('recent1', '최근에 받은 합성 교정 문장', { created_at: new Date(Date.now() - 5 * 86_400_000).toISOString() });
const R_T2A = rule('t2a', 'storybook 스냅샷은 chromatic 으로 비교하고 baseline 갱신은 따로 커밋한다');
const R_T2B = rule('t2b', 'terraform plan 결과를 apply 전에 보여 준다', { strength: 'default' });
const R_GATEFAIL = rule('gf1', '게이트를 못 지난 합성 룰 문장');
const ALL = [R_HARD, R_STRONG, R_RECENT, R_T2A, R_T2B, R_GATEFAIL];
const IDX = index({
  [R_T2A.rule_id]: { words: [...T.words(R_T2A.policy)], topics: ['storybook', 'chromatic'] },
  [R_T2B.rule_id]: { words: [...T.words(`${R_T2B.policy} terraform-apply`)], topics: ['terraform'] },
  [R_GATEFAIL.rule_id]: { qualified: false, reason: 'missed', words: ['x'] },
  [R_STRONG.rule_id]: { words: [...T.words(R_STRONG.policy)] },
});

afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('낱말·층 판정(결정적)', () => {
  it('words: 영문 3자 이상·한글 조사 떼고 앞 2자·불용어 제외', () => {
    const w = T.words('Storybook 스냅샷은 chromatic 으로 비교하고 the git-push');
    expect([...w].sort()).toEqual(['chromatic', 'git', 'git-push', 'push', 'storybook', '비교', '스냅'].sort());
  });
  it('tierOf: 색인 없음 → 전부 1층 / hard·strong·30일 교정·재발(90일) → 1층 / 게이트 통과 → 2층', () => {
    const now = Date.now();
    expect(T.tierOf(R_T2A, null, now)).toEqual({ tier: 1, reason: 'no-index' });
    const idx = IDX as never;
    expect(T.tierOf(R_HARD, idx, now).reason).toBe('hard');
    expect(T.tierOf(R_STRONG, idx, now).reason).toBe('strong');
    expect(T.tierOf(R_RECENT, idx, now).reason).toBe('recent');
    expect(T.tierOf(R_GATEFAIL, idx, now).reason).toBe('not-qualified');
    expect(T.tierOf(R_T2A, idx, now)).toEqual({ tier: 2, reason: 'tier2' });
    // Q12 "다시 관측된": 근거가 30일 안에 다시 나오면 1층
    const seen = index({ [R_T2A.rule_id]: { words: ['a', 'b', 'c'], lastObservedAt: new Date(now - 3 * 86_400_000).toISOString() } });
    expect(T.tierOf(R_T2A, seen as never, now).reason).toBe('recent');
    // 재자격: 마지막 재발 90일 안 → 1층, 지나면 게이트 결과
    const rec = index({ [R_T2A.rule_id]: { words: ['a', 'b', 'c'] } }, { [R_T2A.rule_id]: { lastAt: new Date(now - 10 * 86_400_000).toISOString(), kind: 'recurred', count: 1 } });
    expect(T.tierOf(R_T2A, rec as never, now).reason).toBe('recurred');
    expect(T.tierOf(R_T2A, rec as never, now + 85 * 86_400_000).tier).toBe(2);
  });
  it('matchTier2: 겹침 K(3) 이상만, 겹침 많은 순', () => {
    const rs = [{ id: 'a', text: 'A', words: ['storybook', 'chromatic', '스냅', 'baseline'] }, { id: 'b', text: 'B', words: ['terraform', 'plan', 'apply'] }];
    expect(T.matchTier2(rs, 'storybook chromatic 스냅샷 baseline 갱신').map((h) => h.rule.id)).toEqual(['a']);
    expect(T.matchTier2(rs, 'storybook 하나만')).toEqual([]);
    expect(T.matchTier2(rs, 'Bash terraform plan -out x && terraform apply').map((h) => [h.rule.id, h.score])).toEqual([['b', 3]]);
  });
  it('예산: 2층 룰은 자리를 차지하지 않는다 — 조건 승인으로 updated_at 이 새로워진 2층 룰이 1층 룰을 밀어내지 않고, 빈 자리는 1층 룰이 채운다', () => {
    const fresh = rule('t2new', '방금 다시 저장된 2층 룰 문장', { updated_at: new Date().toISOString() });
    const a = rule('t1a', '1층 룰 하나'); const b = rule('t1b', '1층 룰 둘');
    const out = renderRulesDetailed([fresh, a, b], { warnings: [] } as never, null, { ...DEFAULT_CONTEXT, max_rules: 2, tier2: new Map([['t2new', ['x']]]) });
    expect(out.included.map((r) => r.rule_id).sort()).toEqual(['t1a', 't1b']);
    expect(out.omitted).toEqual([]);
  });
  it('렌더: 2층 룰은 본문에 없고 색인 줄에 수·주제 낱말로 보인다(예산을 쓰지 않음)', () => {
    const tier2 = T.tier2Assignment(ALL, IDX as never);
    expect([...tier2.keys()].sort()).toEqual(['t2a', 't2b']);
    const out = renderRulesDetailed(ALL, { warnings: [] } as never, null, { ...DEFAULT_CONTEXT, tier2 });
    expect(out.text).not.toContain('chromatic 으로 비교');
    expect(out.text).toContain('## Situational Rules\n- 2 more load once');
    expect(out.text).toMatch(/topics: storybook, terraform, chromatic/);
    expect(out.text).toContain('게이트를 못 지난 합성 룰');
    expect(out.included.map((r) => r.rule_id).sort()).toEqual(['gf1', 'hard1', 'recent1', 'strong1']);
    expect(out.tier2?.map((r) => r.rule_id).sort()).toEqual(['t2a', 't2b']);
  });
});

describe('한 번만·턴당 2개(work-context)', () => {
  it('markTier2Injected: 이미 넣은 룰은 빼고, 한 사용자 턴에 최대 2개, 다음 턴엔 다시 2개', async () => {
    const SC = await import('../src/core/session-context.js');
    const sid = 'cap-sess';
    SC.recordWorkContext(sid, repo, { countTurn: true });
    expect(SC.markTier2Injected(sid, ['a', 'b', 'c'])).toEqual(['a', 'b']);
    expect(SC.markTier2Injected(sid, ['c'])).toEqual([]);
    expect(SC.markTier2Injected(sid, ['a'])).toEqual([]);
    SC.recordWorkContext(sid, repo, { countTurn: true });
    expect(SC.markTier2Injected(sid, ['a', 'c'])).toEqual(['c']);
    const wc = SC.readWorkContext(sid);
    expect(wc?.tier2_injected).toEqual(['a', 'b', 'c']);
    expect(wc?.rules).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    // 위치가 바뀌어도 넣은 기록(rules·tier2_injected)은 남는다
    SC.recordWorkContext(sid, home);
    expect(SC.readWorkContext(sid)?.tier2_injected).toEqual(['a', 'b', 'c']);
    expect(SC.readWorkContext(sid)?.rules).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });
});

describe.skipIf(!have)('dist 훅 프로세스: 세션 시작 1층 + 색인 → 상황이 맞으면 한 번', () => {
  const env = () => {
    const e: Record<string, string | undefined> = { ...process.env, HOME: home, FORGEN_HOME: fhome, FORGEN_NO_BLOCK_JUDGE: '1', FORGEN_NESTED_RUN: '' };
    delete e.FORGEN_CWD; delete e.COMPOUND_CWD; delete e.FORGEN_SESSION_ID; delete e.FORGEN_RUNTIME; delete e.FORGEN_HOST;
    return e as NodeJS.ProcessEnv;
  };
  const hook = (name: string, payload: Record<string, unknown>) => {
    const r = spawnSync(process.execPath, [path.join(DIST, 'hooks', `${name}.js`)], { input: JSON.stringify(payload), encoding: 'utf-8', timeout: 20000, cwd: home, env: env() });
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop() ?? '{}');
    return { ctx: String(j.hookSpecificOutput?.additionalContext ?? ''), json: j };
  };
  const sid = 'tier2-sess-1';
  beforeAll(() => {
    for (const r of ALL) writeRule(r);
    fs.writeFileSync(path.join(fhome, 'state', 'tier2-index.json'), JSON.stringify(IDX));
  });

  it('세션 시작: 1층(hard·strong·30일·게이트 탈락) 본문 + 2층 색인 줄, 2층 본문 없음 — 감사 렌더와 같은 결과', () => {
    const { ctx } = hook('session-recovery', { session_id: sid, cwd: repo, source: 'startup', hook_event_name: 'SessionStart' });
    expect(ctx).toContain('비밀 파일을 커밋하지 않는다');
    expect(ctx).toContain('! 배포 전에 오너 승인을 받는다');
    expect(ctx).toContain('최근에 받은 합성 교정 문장');
    expect(ctx).toContain('게이트를 못 지난 합성 룰');
    expect(ctx).toContain('## Situational Rules');
    expect(ctx).not.toContain('chromatic 으로 비교');
    const ro = renderSessionStartReadOnly(repo);
    expect(ctx).toContain(ro.text);
    expect(ro.tier2RuleIds.sort()).toEqual(['t2a', 't2b']);
    const start = readSessionRenders().get(sid)?.[0];
    expect(start).toMatchObject({ event: 'start', tier2: ['t2a', 't2b'] });
    expect(start?.ruleIds).not.toContain('t2a');
  });

  it('프롬프트가 맞으면 그 2층 룰을 한 번 넣고(턴당 ≤ 2), 다시는 안 넣는다', () => {
    const miss = hook('context-guard', { session_id: sid, cwd: repo, prompt: '오늘 회의록 정리해 줘', hook_event_name: 'UserPromptSubmit' });
    expect(miss.ctx).toBe('');
    const hit = hook('context-guard', { session_id: sid, cwd: repo, prompt: 'storybook 스냅샷 chromatic 으로 다시 돌려 줘', hook_event_name: 'UserPromptSubmit' });
    expect(hit.ctx).toContain('<forgen-rules tier="2">');
    expect(hit.ctx).toContain('chromatic 으로 비교');
    const again = hook('context-guard', { session_id: sid, cwd: repo, prompt: 'storybook 스냅샷 chromatic 한 번 더', hook_event_name: 'UserPromptSubmit' });
    expect(again.ctx).toBe('');
  });

  it('도구 입력(명령)이 맞으면 PreToolUse 가 additionalContext 로 넣고, PostToolUse 는 다시 넣지 않는다', () => {
    const pre = hook('pre-tool-use', { session_id: sid, cwd: repo, tool_name: 'Bash', tool_input: { command: 'terraform plan -out p && terraform apply p' }, hook_event_name: 'PreToolUse' });
    expect(pre.json.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(pre.ctx).toContain('terraform plan 결과를');
    expect(pre.json.hookSpecificOutput?.permissionDecision).toBeUndefined();
    const post = hook('post-tool-use', { session_id: sid, cwd: repo, tool_name: 'Bash', tool_input: { command: 'terraform plan -out p && terraform apply p' }, tool_response: 'ok', hook_event_name: 'PostToolUse' });
    expect(post.ctx).not.toContain('terraform plan 결과를');
  });

  it('기록: work-context 에 넣은 2층 룰, 세션별 렌더 기록에 tier2 사건 — 재생의 "실렸는가"가 이것을 쓴다', () => {
    const wc = JSON.parse(fs.readFileSync(path.join(fhome, 'state', `work-context-${sid}.json`), 'utf-8'));
    expect(wc.tier2_injected.sort()).toEqual(['t2a', 't2b']);
    expect(wc.rules).toEqual(expect.arrayContaining(['t2a', 't2b', 'hard1']));
    const recs = readSessionRenders().get(sid) ?? [];
    expect(recs.filter((r) => r.event === 'tier2').map((r) => [r.ruleIds[0], r.via])).toEqual([['t2a', 'prompt'], ['t2b', 'tool']]);
    const last = recs[recs.length - 1].at;
    expect(rulesLoadedAt(recs, last)?.has('t2b')).toBe(true);
    expect(tier2PendingAt(recs, last).has('t2a')).toBe(true);
  });

  it('압축 뒤 재시작(compact): 넣은 기록을 비우고 다시 맞으면 다시 넣는다', () => {
    hook('session-recovery', { session_id: sid, cwd: repo, source: 'compact', hook_event_name: 'SessionStart' });
    const wc = JSON.parse(fs.readFileSync(path.join(fhome, 'state', `work-context-${sid}.json`), 'utf-8'));
    expect(wc.tier2_injected ?? []).toEqual([]);
    const hit = hook('context-guard', { session_id: sid, cwd: repo, prompt: 'storybook 스냅샷 chromatic 비교', hook_event_name: 'UserPromptSubmit' });
    expect(hit.ctx).toContain('chromatic 으로 비교');
  });

  it('2층 미발동 이력이 있으면 다음 세션부터 1층(자동 복귀), 색인이 없으면 전부 1층(예전과 같음)', () => {
    fs.writeFileSync(path.join(fhome, 'state', 'tier2-index.json'), JSON.stringify({ ...IDX, recur: { t2a: { lastAt: new Date().toISOString(), kind: 'tier2-missed', count: 1 } } }));
    const a = hook('session-recovery', { session_id: 'tier2-sess-2', cwd: repo, source: 'startup', hook_event_name: 'SessionStart' });
    expect(a.ctx).toContain('chromatic 으로 비교');
    expect(a.ctx).toContain('## Situational Rules\n- 1 more');
    fs.rmSync(path.join(fhome, 'state', 'tier2-index.json'));
    const b = hook('session-recovery', { session_id: 'tier2-sess-3', cwd: repo, source: 'startup', hook_event_name: 'SessionStart' });
    expect(b.ctx).toContain('terraform plan 결과를');
    expect(b.ctx).not.toContain('Situational Rules');
    expect(fs.existsSync(path.join(fhome, 'state', 'tier2-session-tier2-sess-3.json'))).toBe(false);
  });
});
