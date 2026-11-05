/** 프로젝트 키 판정과 범위 규칙, 팩 가져오기. 실제 파일 시스템으로 검증한다. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({ TEST_HOME: `${process.env.TMPDIR ?? '/tmp'}/forgen-scope-${process.pid}` }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => TEST_HOME }));

const { projectKeyFor, appliesForContext, appliesForEnforcement } = await import('../src/store/rule-scope.js');
const { applyPackImport, planPackImport, planProjectClassification, setRuleProject } = await import('../src/engine/rule-project-cli.js');
const { saveRule, createRule, loadAllRules } = await import('../src/store/rule-store.js');

const rule = (projects?: string[]) => ({ projects } as never);

beforeAll(() => {
  fs.mkdirSync(path.join(TEST_HOME, 'repo', '.git'), { recursive: true });
  fs.mkdirSync(path.join(TEST_HOME, 'repo', 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(TEST_HOME, 'main', '.git', 'worktrees', 'wt'), { recursive: true });
  fs.mkdirSync(path.join(TEST_HOME, 'wt'), { recursive: true });
  fs.writeFileSync(path.join(TEST_HOME, 'wt', '.git'), `gitdir: ${path.join(TEST_HOME, 'main', '.git', 'worktrees', 'wt')}\n`);
  fs.mkdirSync(path.join(TEST_HOME, 'plain'), { recursive: true });
  const pack = path.join(TEST_HOME, '.forgen', 'packs', 'demo');
  fs.mkdirSync(path.join(pack, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(pack, 'solutions'), { recursive: true });
  fs.mkdirSync(path.join(pack, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(pack, 'rules', 'a.md'), '# 제목\n\n> Type: rule\n> Scope: team\n\n나눗셈은 0 을 막아라.\n');
  fs.writeFileSync(path.join(pack, 'solutions', 'ok.md'), '---\nname: ok\n---\n본문\n');
  fs.writeFileSync(path.join(pack, 'solutions', 'bad.md'), '본문만 있음\n');
  fs.writeFileSync(path.join(pack, 'skills', 's.md'), '# s\n');
});
afterAll(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

describe('projectKeyFor', () => {
  it('하위 폴더는 저장소 이름, worktree 는 본 저장소 이름', () => {
    expect(projectKeyFor(path.join(TEST_HOME, 'repo', 'src', 'deep'))).toBe('repo');
    expect(projectKeyFor(path.join(TEST_HOME, 'wt'))).toBe('main');
  });
  it('홈과 git 밖은 프로젝트가 아니다', () => {
    expect(projectKeyFor(TEST_HOME)).toBeNull();
    expect(projectKeyFor(path.join(TEST_HOME, 'plain'))).toBeNull();
  });
});

describe('범위 규칙', () => {
  it('프로젝트 룰: 그 프로젝트는 주입·차단, 다른 프로젝트는 둘 다 아님, 프로젝트 밖은 주입만', () => {
    const r = rule(['deadeye']);
    expect([appliesForContext(r, 'deadeye'), appliesForEnforcement(r, 'deadeye')]).toEqual([true, true]);
    expect([appliesForContext(r, 'forgen'), appliesForEnforcement(r, 'forgen')]).toEqual([false, false]);
    expect([appliesForContext(r, null), appliesForEnforcement(r, null)]).toEqual([true, false]);
  });
  it('전역 룰은 어디서나 주입·차단', () => {
    for (const key of ['forgen', null]) expect([appliesForContext(rule(), key), appliesForEnforcement(rule(), key)]).toEqual([true, true]);
  });
});

describe('분류와 팩', () => {
  it('키워드 분류는 hard 와 이미 지정된 룰을 건너뛴다', () => {
    const base = { category: 'workflow', scope: 'me', trigger: 't', source: 'explicit_correction' } as const;
    const a = createRule({ ...base, policy: 'Deadeye 화면', strength: 'strong', render_key: 'x.a' });
    const h = createRule({ ...base, policy: 'Deadeye 금지', strength: 'hard', render_key: 'x.h' });
    const p = createRule({ ...base, policy: 'Deadeye 지정됨', strength: 'default', render_key: 'x.p', projects: ['y'] });
    saveRule(a); saveRule(h); saveRule(p);
    expect(planProjectClassification('deadeye', ['deadeye']).map((r) => r.rule_id)).toEqual([a.rule_id]);
  });
  it('가져오기는 멱등이고, 형식 오류 솔루션과 룰·솔루션 외 파일을 알린다', () => {
    const plan = planPackImport('demo');
    expect(plan.rules[0].policy).toBe('나눗셈은 0 을 막아라.');
    expect(plan.solutions.find((s) => s.file === 'bad.md')?.valid).toBe(false);
    expect(plan.notImported).toEqual(['skills/s.md']);
    expect(applyPackImport('demo', 'demo')).toEqual({ rules: 1, solutions: 1 });
    expect(applyPackImport('demo', 'demo')).toEqual({ rules: 0, solutions: 0 });
    const imported = loadAllRules().find((r) => r.render_key === 'pack.demo.a');
    expect(imported).toMatchObject({ projects: ['demo'], source: 'onboarding' });
  });
  it('hard 룰은 프로젝트로 좁힐 수 없다', () => {
    const h = createRule({ category: 'safety', scope: 'me', trigger: 't', source: 'explicit_correction', policy: '금지', strength: 'hard', render_key: 'x.safe' });
    saveRule(h);
    expect(() => setRuleProject(h.rule_id, ['repo'])).toThrow(/must stay global/);
  });
  it('경로 탈출 이름 거부', () => expect(() => planPackImport('../..')).toThrow(/not found/));
});
