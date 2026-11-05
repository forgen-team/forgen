/** 업그레이드한 사용자의 상태를 라이브러리가 스스로 고치는지 본다: cron, 옛 게이트, 사라진 교정. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refreshCronText } from '../src/core/compound-sweep-cli.js';
import { artifactGateIsStale } from '../src/engine/rule-detectability.js';

const DIST = path.resolve('dist');
const MARK = '# forgen-compound-sweep (ADR-011)';

describe('refreshCronText', () => {
  const old = `17 * * * * '/n/node' '/old/dist/cli.js' compound sweep --prune-removed --apply >> '/l.log' 2>&1 ${MARK}`;
  it('일정·옵션·로그 경로와 다른 작업을 유지하고 shim 경유로 바꾼다', () => {
    const { text, changed } = refreshCronText(`0 6 * * * other\n${old}\n`, '/h/.forgen/bin/forgen-run');
    expect(changed).toBe(true);
    expect(text).toContain('0 6 * * * other');
    expect(text).toContain(`17 * * * * '/h/.forgen/bin/forgen-run' 'cli.js' compound sweep --prune-removed --apply >> '/l.log' 2>&1 ${MARK}`);
    expect(text).not.toContain('/old/dist');
  });
  it('등록이 없으면 추가하지 않고, 두 번 돌려도 그대로다', () => {
    expect(refreshCronText('0 6 * * * other\n', '/s').changed).toBe(false);
    const once = refreshCronText(`${old}\n`, '/s').text;
    expect(refreshCronText(once, '/s').changed).toBe(false);
  });
  it('@hourly 일정은 유지하고, 형식을 모르는 라인은 건드리지 않는다', () => {
    const hourly = `@hourly '/n/node' '/old/cli.js' compound sweep >> '/l.log' 2>&1 ${MARK}`;
    expect(refreshCronText(hourly, '/s').text).toBe(`@hourly '/s' 'cli.js' compound sweep >> '/l.log' 2>&1 ${MARK}`);
    const odd = `17 * * * * /my/wrapper.sh ${MARK}`;
    expect(refreshCronText(odd, '/s')).toEqual({ text: odd, changed: false });
  });
});

describe('artifactGateIsStale', () => {
  const gate = { mech: 'A', hook: 'Stop', verifier: { kind: 'artifact_check', params: { path: '.forgen/state/e2e-result.json' } } } as never;
  it('trigger·policy 어디에도 파일이 없을 때만 낡은 게이트다', () => {
    expect(artifactGateIsStale({ trigger: 't', policy: '프로덕션 환경을 먼저 확인' }, gate)).toBe(true);
    expect(artifactGateIsStale({ trigger: 't', policy: '완료 전 e2e-result.json 증거 확인' }, gate)).toBe(false);
    expect(artifactGateIsStale({ trigger: '.forgen/state/e2e-result.json 없으면', policy: '완료 금지' }, gate)).toBe(false);
  });
  it('구체적 파일명이 아니면 낡았다고 판정하지 않는다', () => {
    const at = (p: string) => ({ mech: 'A', hook: 'Stop', verifier: { kind: 'artifact_check', params: { path: p } } }) as never;
    expect(artifactGateIsStale({ trigger: 't', policy: '본문' }, at('out/*.json'))).toBe(false);
    expect(artifactGateIsStale({ trigger: 't', policy: '본문' }, at('out/reports/'))).toBe(false);
  });
});

describe('업그레이드 상태 복구 (dist 실제 실행)', () => {
  let home: string;
  let rules: string;
  const env = () => ({ ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), FORGEN_NO_BLOCK_JUDGE: '1', FORGEN_NESTED_RUN: '' });
  const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(DIST, 'cli.js'), ...args], { encoding: 'utf-8', cwd: home, env: env() }).stdout;
  const rule = (id: string, over: object) => fs.writeFileSync(path.join(rules, `${id}.json`), JSON.stringify({
    rule_id: id, category: 'workflow', scope: 'me', trigger: 't', policy: `${id} 정책`, strength: 'default', source: 'explicit_correction',
    status: 'active', evidence_refs: [], render_key: `w.${id}`, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...over,
  }));
  const evidence = (id: string, summary: string, kind = 'avoid-this') => fs.writeFileSync(path.join(home, '.forgen', 'me', 'behavior', `${id}.json`), JSON.stringify({
    evidence_id: id, type: 'explicit_correction', session_id: 's', timestamp: '2026-05-01T00:00:00.000Z', source_component: 'Hooks', summary,
    axis_refs: [], candidate_rule_refs: [], confidence: 0.9, raw_payload: { kind, target: '대상', axis_hint: 'quality_safety' },
  }));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-upgrade-'));
    rules = path.join(home, '.forgen', 'me', 'rules');
    fs.mkdirSync(rules, { recursive: true });
    fs.mkdirSync(path.join(home, '.forgen', 'me', 'behavior'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('활성 룰에 남은 옛 게이트는 완료 보고를 막지 않고, 본문에 있는 게이트는 막는다', () => {
    const gate = [{ mech: 'A', hook: 'Stop', verifier: { kind: 'artifact_check', params: { path: '.forgen/state/e2e-result.json', max_age_s: 3600 } } }];
    rule('stale', { policy: '프로덕션 환경을 먼저 확인', enforce_via: gate });
    const stop = () => JSON.parse(spawnSync(process.execPath, [path.join(DIST, 'hooks', 'stop-guard.js')], {
      input: JSON.stringify({ session_id: 'u1', cwd: home, last_assistant_message: '구현 완료했습니다.' }), encoding: 'utf-8', cwd: home, env: env(),
    }).stdout.trim().split('\n').pop() as string);
    expect(stop().decision).toBeUndefined();
    rule('stale', { policy: '완료 전 e2e-result.json 증거 확인', enforce_via: gate });
    expect(stop().decision).toBe('block');
  });

  it('rule recover: 미리보기 → 룰 없는 교정 생성·꺼진 룰 복구·프로젝트 지정 → 목록에서 빠짐', () => {
    evidence('aaaa1111', '룰이 사라진 교정');
    evidence('bbbb2222', '꺼진 룰의 교정');
    evidence('cccc3333', '살아 있는 교정');
    rule('off-rule', { policy: '꺼진 룰의 교정', status: 'suppressed', evidence_refs: ['bbbb2222'] });
    rule('live-rule', { policy: '살아 있는 교정', evidence_refs: ['cccc3333'] });

    const preview = cli('rule', 'recover');
    expect(preview).toContain('2건');
    expect(preview).not.toContain('살아 있는 교정');
    expect(fs.readdirSync(rules)).toHaveLength(2); // 미리보기는 바꾸지 않는다

    expect(cli('rule', 'recover', '--apply', 'zzzz')).not.toContain('✓');
    cli('rule', 'recover', '--apply', 'aaaa', '--project', 'MyRepo');
    cli('rule', 'recover', '--apply', 'bbbb');
    const saved = fs.readdirSync(rules).map((f) => JSON.parse(fs.readFileSync(path.join(rules, f), 'utf-8')));
    const created = saved.find((r) => r.policy === '룰이 사라진 교정');
    expect(created).toMatchObject({ status: 'active', scope: 'me', strength: 'strong', category: 'quality', projects: ['myrepo'], evidence_refs: ['aaaa1111'] });
    expect(saved.find((r) => r.rule_id === 'off-rule')).toMatchObject({ status: 'active' });
    expect(cli('rule', 'recover')).toContain('복구할 교정이 없습니다');
  });

  it('의도적으로 사라진 교정은 잃은 교정으로 세지 않는다', () => {
    evidence('dddd4444', '세션 한정 지시', 'fix-now');
    evidence('eeee5555', '내가 끈 룰의 교정');
    rule('user-off', { policy: '내가 끈 룰의 교정', status: 'suppressed', evidence_refs: ['eeee5555'],
      status_history: [{ at: '2026-06-01T00:00:00Z', from: 'active', to: 'suppressed', reason: 'user: suppress-rule', by: 'cli' }] });
    evidence('ffff6666', '병합 전 원문');
    rule('merged-to', { policy: '병합된 대표 문장' });
    rule('merged-src', { policy: '병합 전 원문', status: 'superseded', evidence_refs: ['ffff6666'], clustered_into: 'merged-to' });
    expect(cli('rule', 'recover')).toContain('복구할 교정이 없습니다');
  });

  it('실행 위치의 프로젝트 룰에 영향받지 않는다', () => {
    evidence('abab1212', '프로젝트에도 있는 문장');
    const repo = path.join(home, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.forgen', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.forgen', 'rules', 'p.json'), JSON.stringify({ rule_id: 'p', category: 'workflow', scope: 'project', trigger: 't', policy: '프로젝트에도 있는 문장', strength: 'default', source: 'explicit_correction', status: 'suppressed', evidence_refs: ['abab1212'], render_key: 'w.p', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }));
    const r = spawnSync(process.execPath, [path.join(DIST, 'cli.js'), 'rule', 'recover', '--apply', 'abab'], { encoding: 'utf-8', cwd: repo, env: env() });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('✓');
  });
});

describe('교정 승급은 모델이 넘긴 세션 ID 에 의존하지 않는다 (실제 MCP·hook 프로세스)', () => {
  let home: string;
  const env = () => ({ ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), FORGEN_NESTED_RUN: '', FORGEN_NO_AUTO_COMPOUND: '1' });
  const rulesNow = () => {
    const dir = path.join(home, '.forgen', 'me', 'rules');
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
  };
  const record = (kind: string, message: string, projects?: string[]) => {
    const code = `import { processCorrection } from ${JSON.stringify(path.join(DIST, 'forge', 'evidence-processor.js'))};
      processCorrection({ session_id: 'current-session', kind: ${JSON.stringify(kind)}, message: ${JSON.stringify(message)}, target: ${JSON.stringify(message)}, axis_hint: null, ${projects ? `projects: ${JSON.stringify(projects)}` : ''} });`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf-8', cwd: home, env: env() });
    expect(r.status, r.stderr).toBe(0);
  };
  const promote = (sid: string) => {
    const code = `import { promoteSessionCandidates as p } from ${JSON.stringify(path.join(DIST, 'store', 'evidence-store.js'))}; console.log(p(${JSON.stringify(sid)}));`;
    return Number(spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf-8', cwd: home, env: env() }).stdout.trim());
  };
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-promote-'));
    fs.mkdirSync(path.join(home, '.forgen', 'me', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(home, '.forgen', 'me', 'behavior'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('avoid-this 는 ID 가 달라도 다음 세션 종료 때 영구 룰이 되고, 두 번 승급되지 않는다', () => {
    record('avoid-this', '답변 끝에 표식을 붙여라');
    expect(promote('real-session-uuid')).toBe(1);
    expect(rulesNow().filter((r) => r.scope === 'me' && r.status === 'active')).toHaveLength(1);
    expect(promote('another-session')).toBe(0);
    expect(rulesNow().filter((r) => r.scope === 'me')).toHaveLength(1);
  });

  it('prefer-from-now 도 같고, fix-now 는 승급하지 않는다', () => {
    record('prefer-from-now', 'async await 를 선호');
    record('fix-now', '이번만 고쳐');
    expect(promote('real-session-uuid')).toBe(1);
    const me = rulesNow().filter((r) => r.scope === 'me');
    expect(me.map((r) => r.policy)).toEqual(['async await 를 선호']);
  });

  it('표시 없는 옛 교정은 다른 세션에서 자동 승급하지 않는다 (rule recover 로만)', () => {
    fs.writeFileSync(path.join(home, '.forgen', 'me', 'behavior', 'old1.json'), JSON.stringify({ evidence_id: 'old1', type: 'explicit_correction', session_id: 'old', timestamp: '2026-05-01T00:00:00.000Z', source_component: 'Hooks', summary: '옛 교정', axis_refs: [], candidate_rule_refs: [], confidence: 0.9, raw_payload: { kind: 'avoid-this', target: 'x' } }));
    expect(promote('real-session-uuid')).toBe(0);
  });

  const onlyMe = () => {
    const me = rulesNow().filter((r) => r.scope === 'me');
    expect(me).toHaveLength(1);
    return me[0];
  };

  it('프로젝트가 다른 같은 교정이 합쳐져도 어느 프로젝트의 범위도 잃지 않는다', () => {
    record('prefer-from-now', '탭을 써라', ['/a']);
    record('prefer-from-now', '탭을 써라', ['/b']);
    expect(promote('s')).toBe(2);
    expect(onlyMe().projects.sort()).toEqual(['/a', '/b']);
  });

  it('전역 룰은 프로젝트 교정으로 좁혀지지 않는다', () => {
    record('prefer-from-now', '탭을 써라');
    promote('s1');
    record('prefer-from-now', '탭을 써라', ['/a']);
    promote('s2');
    expect(onlyMe().projects).toBeUndefined();
  });

  it('범위 없는 교정이 프로젝트 룰을 전역으로 넓히지 않는다', () => {
    record('prefer-from-now', '탭을 써라', ['/a']);
    promote('s1');
    record('prefer-from-now', '탭을 써라');
    promote('s2');
    expect(onlyMe().projects).toEqual(['/a']);
  });

  it('꺼진 룰이 새 교정으로 살아나면 이번 교정의 범위를 따른다', () => {
    record('prefer-from-now', '탭을 써라', ['/a']);
    promote('s1');
    const rule = onlyMe();
    fs.writeFileSync(path.join(home, '.forgen', 'me', 'rules', `${rule.rule_id}.json`), JSON.stringify({ ...rule, status: 'suppressed' }));
    record('prefer-from-now', '탭을 써라', ['/b']);
    promote('s2');
    expect(onlyMe().status).toBe('active');
    expect(onlyMe().projects).toEqual(['/b']);
  });

  it('프로필이 없어도 세션 시작에서 승급된다', () => {
    record('prefer-from-now', '탭을 써라');
    const code = `import { bootstrapV1Session as b } from ${JSON.stringify(path.join(DIST, 'core', 'v1-bootstrap.js'))}; console.log(b(${JSON.stringify(home)}).needsOnboarding);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf-8', cwd: home, env: env() });
    expect(r.stdout.trim()).toBe('true');
    expect(onlyMe().status).toBe('active');
  });
});
