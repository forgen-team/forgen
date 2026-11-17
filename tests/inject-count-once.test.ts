/**
 * D8 (docs/plans/2026-11-17-rule-quality-redesign.md): 래퍼(fgx/prepareHarness)와 SessionStart 가 둘 다
 * bootstrapV1Session 을 불러 한 세션에 inject_count 가 2 오르던 문제. 래퍼가 띄운 세션의 SessionStart 는 세지 않는다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({ TEST_HOME: `/tmp/forgen-test-inject-once-${process.pid}` }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { createRule, saveRule, loadRule } = await import('../src/store/rule-store.js');
const { bootstrapV1Session } = await import('../src/core/v1-bootstrap.js');
const { buildEnv } = await import('../src/core/config-injector.js');
const { createProfile, saveProfile } = await import('../src/store/profile-store.js');

function seed() {
  // 프로필이 없으면 bootstrap 이 온보딩 경로(renderWithoutProfile)로 빠져 카운트하지 않는다.
  saveProfile(createProfile('u', '균형형', '균형형', '가드레일 우선', 'onboarding'));
  const r = createRule({ category: 'workflow', scope: 'me', trigger: 't', policy: '작업을 끝내면 결과만 짧게 보고한다', strength: 'default', source: 'explicit_correction', render_key: 'w.report' });
  saveRule(r);
  return r.rule_id;
}

describe('세션당 inject_count 1회', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_HOME, { recursive: true });
  });
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('trackInjection:false 이면 렌더는 하되 카운트는 올리지 않는다', () => {
    const id = seed();
    const res = bootstrapV1Session(TEST_HOME, { trackInjection: false });
    expect(res.renderedRules).toContain('작업을 끝내면 결과만 짧게 보고한다');
    expect(loadRule(id)?.lifecycle?.inject_count ?? 0).toBe(0);
  });

  it('래퍼 bootstrap(기본) + 래퍼가 띄운 SessionStart(trackInjection:false) = 1회', () => {
    const id = seed();
    bootstrapV1Session(TEST_HOME);
    bootstrapV1Session(TEST_HOME, { trackInjection: false });
    expect(loadRule(id)?.lifecycle?.inject_count).toBe(1);
  });

  it('래퍼 없이 직접 실행한 세션은 SessionStart 가 센다', () => {
    const id = seed();
    bootstrapV1Session(TEST_HOME);
    expect(loadRule(id)?.lifecycle?.inject_count).toBe(1);
  });

  it('래퍼가 자식 런타임에 넘기는 env 에 FORGEN_HARNESS_BOOTSTRAPPED=1 이 있다', () => {
    expect(buildEnv('/tmp', 'sid').FORGEN_HARNESS_BOOTSTRAPPED).toBe('1');
    expect(buildEnv('/tmp').FORGEN_HARNESS_BOOTSTRAPPED).toBeUndefined();
  });
});

describe.skipIf(!fs.existsSync(path.resolve('dist/hooks/session-recovery.js')))('SessionStart hook 프로세스', () => {
  const home = `/tmp/forgen-test-inject-once-proc-${process.pid}`;
  const runHook = (env: Record<string, string>) => execFileSync(process.execPath, [path.resolve('dist/hooks/session-recovery.js')], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', cwd: home }),
    env: { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), FORGEN_DISABLE_PROJECT_RULES: '1', ...env },
    encoding: 'utf-8', timeout: 20_000,
  });
  const injectCount = () => {
    const dir = path.join(home, '.forgen', 'me', 'rules');
    const f = fs.readdirSync(dir).find((n) => n.endsWith('.json'))!;
    return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')).lifecycle?.inject_count ?? 0;
  };
  beforeEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    const dir = path.join(home, '.forgen', 'me', 'rules');
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(path.resolve('dist/store/profile-store.js'))}); m.saveProfile(m.createProfile('u', '균형형', '균형형', '가드레일 우선', 'onboarding'));`], { env: { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen') } });
    fs.writeFileSync(path.join(dir, 'r1.json'), JSON.stringify({ rule_id: 'r1', category: 'workflow', scope: 'me', trigger: 't', policy: '작업을 끝내면 결과만 짧게 보고한다', strength: 'default', source: 'explicit_correction', status: 'active', evidence_refs: [], render_key: 'w.report', created_at: now, updated_at: now }));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('래퍼가 띄운 첫 SessionStart 는 세지 않고, 같은 env 를 물려받은 중첩 세션은 센다', () => {
    const env = { FORGEN_HARNESS_BOOTSTRAPPED: '1', FORGEN_SESSION_ID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    runHook(env);
    expect(injectCount()).toBe(0);
    runHook(env); // claude 안에서 띄운 claude -p 등 — env 는 상속되지만 표식은 이미 소비됨
    expect(injectCount()).toBe(1);
  });
  it('래퍼 없이 직접 실행하면 센다', () => {
    runHook({ FORGEN_HARNESS_BOOTSTRAPPED: '', FORGEN_SESSION_ID: '' });
    expect(injectCount()).toBe(1);
  });
});

describe('consumeHarnessBootstrap', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  it('세션 ID 별로 한 번만 true, 표식 없음·이상한 ID 는 false', async () => {
    const { consumeHarnessBootstrap } = await import('../src/core/harness-inject-marker.js');
    const env = { FORGEN_HARNESS_BOOTSTRAPPED: '1', FORGEN_SESSION_ID: 'sid-12345678' };
    expect(consumeHarnessBootstrap(env)).toBe(true);
    expect(consumeHarnessBootstrap(env)).toBe(false);
    expect(consumeHarnessBootstrap({ ...env, FORGEN_SESSION_ID: 'sid-87654321' })).toBe(true);
    expect(consumeHarnessBootstrap({ FORGEN_SESSION_ID: 'sid-99999999' })).toBe(false);
    expect(consumeHarnessBootstrap({ FORGEN_HARNESS_BOOTSTRAPPED: '1', FORGEN_SESSION_ID: '../../etc' })).toBe(false);
  });
});
