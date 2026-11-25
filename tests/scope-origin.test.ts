/**
 * 0.8.0 S1~S3: 교정 범위가 저장 시점에 사라지지 않는다 — 실제 dist 프로세스(훅·MCP 서버)로 검증.
 *
 *   S1  훅이 correction-record 호출에 실제 session_id·호출 시점 cwd 를 붙인다(updatedInput),
 *       MCP 는 그 값(없으면 세션 파일)으로 프로젝트를 푼다. MCP 프로세스의 시작 폴더는 쓰지 않는다.
 *   S2  프로젝트 한정인데 위치를 못 풀면 전역이 아니라 scope_state 'unresolved'.
 *   S3  프로젝트 키 등록부: git 아닌 폴더·여러 저장소를 한 키로, 별칭으로 옛 키를 새 키로.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const have = fs.existsSync(path.join(DIST, 'mcp', 'server.js')) && fs.existsSync(path.join(DIST, 'hooks', 'pre-tool-use.js'));

let root: string; let home: string; let fhome: string;
let repoA: string; let repoB: string; let plain: string;

const baseEnv = () => {
  const e: Record<string, string | undefined> = { ...process.env, HOME: home, FORGEN_HOME: fhome, FORGEN_NO_BLOCK_JUDGE: '1', FORGEN_NESTED_RUN: '' };
  delete e.FORGEN_CWD; delete e.COMPOUND_CWD; delete e.FORGEN_SESSION_ID;
  return e as NodeJS.ProcessEnv;
};

function hook(name: string, payload: unknown, cwd = home) {
  const r = spawnSync(process.execPath, [path.join(DIST, 'hooks', `${name}.js`)], { input: JSON.stringify(payload), encoding: 'utf-8', timeout: 20000, cwd, env: baseEnv() });
  return { out: r.stdout.trim(), status: r.status, err: r.stderr };
}

function forgen(args: string[]) {
  return spawnSync(process.execPath, [path.join(DIST, 'cli.js'), ...args], { encoding: 'utf-8', timeout: 20000, cwd: home, env: baseEnv() });
}

class Mcp {
  proc: ChildProcess; buf = ''; id = 1; pending = new Map<number, (r: any) => void>();
  constructor() {
    // 홈에서 뜬 MCP — 예전 결함(시작 폴더 고정)이 재현되는 조건
    this.proc = spawn(process.execPath, [path.join(DIST, 'mcp', 'server.js')], { cwd: home, env: baseEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout!.on('data', (c) => {
      this.buf += c.toString();
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        try { const m = JSON.parse(line); this.pending.get(Number(m.id))?.(m); this.pending.delete(Number(m.id)); } catch { /* */ }
      }
    });
    this.proc.stderr!.on('data', () => {});
  }
  send(method: string, params?: unknown): Promise<any> {
    const id = this.id++;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 10000);
      this.pending.set(id, (r) => { clearTimeout(t); res(r); });
      this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async record(args: Record<string, unknown>): Promise<{ text: string; payload: any; evidenceSession: string }> {
    const r = await this.send('tools/call', { name: 'correction-record', arguments: { kind: 'prefer-from-now', message: '범위 실험용 교정 문장입니다', target: '범위 실험', axis_hint: null, ...args } });
    const text: string = r.result.content[0].text;
    const id = /Evidence: (\S+)/.exec(text)![1];
    const ev = JSON.parse(fs.readFileSync(path.join(fhome, 'me', 'behavior', `${id}.json`), 'utf-8'));
    return { text, payload: ev.raw_payload, evidenceSession: ev.session_id };
  }
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-scope080-')));
  home = path.join(root, 'home'); fhome = path.join(home, '.forgen');
  repoA = path.join(home, 'ws', 'repo-a'); repoB = path.join(home, 'ws', 'repo-b'); plain = path.join(home, 'ws', 'notes');
  for (const d of [repoA, repoB, plain, path.join(fhome, 'state'), path.join(fhome, 'me', 'behavior'), path.join(fhome, 'me', 'rules')]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(repoA, '.git')); fs.mkdirSync(path.join(repoB, '.git'));
  fs.mkdirSync(path.join(repoA, 'src'));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(!have)('S1 훅이 correction-record 호출을 보강한다', () => {
  it('실제 session_id 와 호출 시점 cwd 를 updatedInput 으로 보낸다', () => {
    const r = hook('pre-tool-use', {
      session_id: 'sess-hook-1', hook_event_name: 'PreToolUse', cwd: path.join(repoA, 'src'), tool_use_id: 'toolu_1',
      tool_name: 'mcp__forgen-compound__correction-record', tool_input: { session_id: 'unknown', kind: 'prefer-from-now', message: 'm', target: 't', axis_hint: null },
    });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' });
    expect(j.hookSpecificOutput.updatedInput).toMatchObject({ session_id: 'sess-hook-1', kind: 'prefer-from-now', message: 'm', origin: { cwd: path.join(repoA, 'src'), tool_use_id: 'toolu_1' } });
  });
  it('플러그인 설치 이름(mcp__plugin_…forgen…__correction-record)도 잡는다', () => {
    const r = hook('pre-tool-use', { session_id: 's2', cwd: repoA, tool_name: 'mcp__plugin_forgen_forgen-compound__correction-record', tool_input: { session_id: 'x' } });
    expect(JSON.parse(r.out).hookSpecificOutput?.updatedInput?.session_id).toBe('s2');
  });
  it('Codex 의 밑줄 이름(mcp__forgen_compound__correction_record)도 잡는다', () => {
    const r = hook('pre-tool-use', { session_id: 'cx1', cwd: repoA, tool_name: 'mcp__forgen_compound__correction_record', tool_input: { session_id: 'unknown' } });
    expect(JSON.parse(r.out).hookSpecificOutput?.updatedInput).toMatchObject({ session_id: 'cx1', origin: { cwd: repoA } });
  });
  it('다른 MCP 도구는 건드리지 않는다', () => {
    const r = hook('pre-tool-use', { session_id: 's3', cwd: repoA, tool_name: 'mcp__other__correction-record', tool_input: { a: 1 } });
    expect(JSON.parse(r.out).hookSpecificOutput?.updatedInput).toBeUndefined();
  });
  it('도구 호출마다 세션 위치 파일을 적는다(값이 바뀔 때만)', () => {
    hook('pre-tool-use', { session_id: 'sess-file-1', cwd: repoB, tool_name: 'Read', tool_input: { file_path: '/x' } });
    const f = JSON.parse(fs.readFileSync(path.join(fhome, 'state', 'work-context-sess-file-1.json'), 'utf-8'));
    expect(f).toMatchObject({ session_id: 'sess-file-1', cwd: repoB, project: 'repo-b' });
  });
  it('UserPromptSubmit 은 프로젝트별 턴을 센다', () => {
    hook('context-guard', { session_id: 'sess-turns', hook_event_name: 'UserPromptSubmit', cwd: repoA, prompt: 'hello' });
    hook('context-guard', { session_id: 'sess-turns', hook_event_name: 'UserPromptSubmit', cwd: repoA, prompt: 'again' });
    const f = JSON.parse(fs.readFileSync(path.join(fhome, 'state', 'work-context-sess-turns.json'), 'utf-8'));
    expect(f.turns).toEqual({ 'repo-a': 2 });
  });
});

describe.skipIf(!have)('S1·S2 MCP 는 호출 시점 위치로 범위를 정한다 (홈에서 뜬 서버)', () => {
  let mcp: Mcp;
  beforeAll(async () => {
    mcp = new Mcp();
    await mcp.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  });
  afterAll(() => mcp.proc.kill());

  it('훅이 붙인 origin.cwd 가 저장소 안이면 그 프로젝트로 저장 (예전: recorded as global)', async () => {
    const r = await mcp.record({ session_id: 'sess-a', this_project_only: true, origin: { cwd: path.join(repoA, 'src') } });
    expect(r.text).toContain('Project: repo-a only');
    expect(r.payload.projects).toEqual(['repo-a']);
    expect(r.payload.origin).toMatchObject({ cwd: path.join(repoA, 'src'), project: 'repo-a', via: 'hook-input' });
    expect(r.payload.scope_state).toBeUndefined();
  });
  it('origin 이 없으면 세션 파일로 푼다', async () => {
    const r = await mcp.record({ session_id: 'sess-file-1', this_project_only: true });
    expect(r.payload.projects).toEqual(['repo-b']);
    expect(r.payload.origin.via).toBe('session-file');
  });
  it('위치를 못 풀면 전역이 아니라 미정', async () => {
    const r = await mcp.record({ session_id: 'no-such-session', this_project_only: true });
    expect(r.payload.projects).toBeUndefined();
    expect(r.payload.scope_state).toBe('unresolved');
    expect(r.text).toContain('scope-unresolved');
    expect(r.text).not.toContain('recorded as global');
  });
  it('git 아닌 폴더도 등록 전에는 미정', async () => {
    const r = await mcp.record({ session_id: 'sess-p', this_project_only: true, origin: { cwd: plain } });
    expect(r.payload.scope_state).toBe('unresolved');
  });
  it('this_project_only 를 주지 않으면 전역으로 두고 위치를 남기며, 범위 제안 대상임을 알린다 (§12)', async () => {
    const r = await mcp.record({ session_id: 'sess-g', origin: { cwd: repoA } });
    expect(r.payload.projects).toBeUndefined();
    expect(r.payload.scope_state).toBeUndefined();
    expect(r.payload.origin.project).toBe('repo-a');
    expect(r.text).toContain('Location: inside project "repo-a"');
    expect(r.text).toContain('classify-projects --from-sessions');
  });
  it('위치 기록만으로(대화 기록 없이) 범위 제안 목록에 오른다', async () => {
    await mcp.record({ session_id: 'sess-g2', origin: { cwd: repoA }, message: '표시 없이 온 프로젝트 교정 문장입니다', target: '표시 누락 실험' });
    const promote = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(path.join(DIST, 'store', 'evidence-store.js'))}).then(m=>m.promoteSessionCandidates('sess-g2'))`], { encoding: 'utf-8', env: baseEnv(), cwd: home });
    expect(promote.status).toBe(0);
    const out = forgen(['rule', 'classify-projects', '--from-sessions', '--no-llm']).stdout;
    expect(out).toMatch(/→ repo-a .*표시 없이 온 프로젝트 교정/);
  });

  it('S3 등록부: git 아닌 폴더와 저장소를 한 키로 묶고, 옛 키는 별칭으로', async () => {
    const add = forgen(['project', 'add', 'prod', repoA, plain, '--alias', 'repo-a']);
    expect(add.status, add.stderr).toBe(0);
    const p1 = await mcp.record({ session_id: 'sess-r1', this_project_only: true, origin: { cwd: plain } });
    expect(p1.payload.projects).toEqual(['prod']);
    const p2 = await mcp.record({ session_id: 'sess-r2', this_project_only: true, origin: { cwd: path.join(repoA, 'src') } });
    expect(p2.payload.projects).toEqual(['prod']);
    expect(forgen(['project', 'which', repoB]).stdout).toContain('repo-b');
    expect(forgen(['project', 'add', 'x', home]).status).toBe(1); // 홈은 묶지 않는다
  });
});

describe.skipIf(!have)('S2 미정 룰의 적용 규칙 (in-process)', () => {
  it('주입은 하되 차단은 하지 않고, 렌더 예산에서 먼저 빠진다', async () => {
    process.env.FORGEN_HOME = fhome;
    const { appliesForContext, appliesForEnforcement } = await import('../src/store/rule-scope.js');
    const un = { scope_state: 'unresolved' } as never;
    expect(appliesForContext(un, 'repo-a')).toBe(true);
    expect(appliesForEnforcement(un, 'repo-a')).toBe(false);
    expect(appliesForEnforcement(un, null)).toBe(false);
    const { renderRulesDetailed } = await import('../src/renderer/rule-renderer.js');
    const mk = (id: string, extra: object) => ({ rule_id: id, category: 'workflow', scope: 'me', trigger: 't', policy: `${id} ${'x'.repeat(60)}`, strength: 'default', source: 'explicit_correction', status: 'active', evidence_refs: [], render_key: id, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...extra });
    const res = renderRulesDetailed([mk('unres', { scope_state: 'unresolved', updated_at: '2026-11-20T00:00:00Z' }), mk('glob', {})] as never, { warnings: [] } as never, null, { surface: 'inspect', max_rules: 1, max_chars: 100000, include_pack_summary: false });
    expect(res.included.map((r) => r.rule_id)).toEqual(['glob']);
    expect(res.omitted.map((r) => r.rule_id)).toEqual(['unres']);
  });
});

describe.skipIf(!have)('S2 미정 표시가 룰 승급·병합에서 유지된다 (프로세스)', () => {
  it('미정 교정 → 미정 룰, 같은 교정이 프로젝트에서 다시 오면 그 프로젝트로', async () => {
    const mcp = new Mcp();
    await mcp.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    await mcp.record({ session_id: 'sess-promo', this_project_only: true, message: '승급 실험 문장은 미정으로 남아야 한다', target: '승급 실험' });
    mcp.proc.kill();
    const promote = (sid: string) => spawnSync(process.execPath, ['-e', `import(${JSON.stringify(path.join(DIST, 'store', 'evidence-store.js'))}).then(m=>console.log(m.promoteSessionCandidates(${JSON.stringify(sid)})))`], { encoding: 'utf-8', env: baseEnv(), cwd: home });
    expect(Number(promote('sess-promo').stdout.trim())).toBeGreaterThan(0); // pending_promotion 은 세션과 무관하게 승급된다
    const rules = () => fs.readdirSync(path.join(fhome, 'me', 'rules')).map((f) => JSON.parse(fs.readFileSync(path.join(fhome, 'me', 'rules', f), 'utf-8')))
      .filter((r) => r.scope === 'me' && r.trigger === '승급 실험');
    expect(rules()).toHaveLength(1);
    expect(rules()[0]).toMatchObject({ status: 'active', scope_state: 'unresolved' });
    expect(rules()[0].projects).toBeUndefined();

    const mcp2 = new Mcp();
    await mcp2.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    await mcp2.record({ session_id: 'sess-promo2', this_project_only: true, message: '승급 실험 문장은 미정으로 남아야 한다', target: '승급 실험', origin: { cwd: repoB } });
    mcp2.proc.kill();
    promote('sess-promo2');
    expect(rules()).toHaveLength(1);
    expect(rules()[0].projects).toEqual(['repo-b']);
    expect(rules()[0].scope_state).toBeUndefined();
  });
});

describe.skipIf(!have)('S1·S3 경계 경우', () => {
  it('동시 세션 2개가 서로 다른 저장소에 있어도 각 호출은 자기 위치를 받는다', () => {
    const a = JSON.parse(hook('pre-tool-use', { session_id: 'par-a', cwd: repoA, tool_name: 'mcp__forgen-compound__correction-record', tool_input: { session_id: 'par-b' } }).out);
    const b = JSON.parse(hook('pre-tool-use', { session_id: 'par-b', cwd: repoB, tool_name: 'mcp__forgen-compound__correction-record', tool_input: { session_id: 'par-a' } }).out);
    // 모델이 서로의 세션 ID 를 잘못 넘겨도 훅이 실제 값으로 덮는다
    expect(a.hookSpecificOutput.updatedInput).toMatchObject({ session_id: 'par-a', origin: { cwd: repoA } });
    expect(b.hookSpecificOutput.updatedInput).toMatchObject({ session_id: 'par-b', origin: { cwd: repoB } });
  });
  it('추출용 중첩 실행(FORGEN_NESTED_RUN=1)에서는 보강·기록하지 않는다', () => {
    const r = spawnSync(process.execPath, [path.join(DIST, 'hooks', 'pre-tool-use.js')], { input: JSON.stringify({ session_id: 'nested-1', cwd: repoA, tool_name: 'mcp__forgen-compound__correction-record', tool_input: {} }), encoding: 'utf-8', env: { ...baseEnv(), FORGEN_NESTED_RUN: '1' } });
    expect(JSON.parse(r.stdout.trim()).hookSpecificOutput?.updatedInput).toBeUndefined();
    expect(fs.existsSync(path.join(fhome, 'state', 'work-context-nested-1.json'))).toBe(false);
  });
  it('worktree 는 본 저장소 키로 푼다', () => {
    const main = path.join(home, 'ws', 'mainrepo'); const wt = path.join(home, 'ws', 'mainrepo-wt');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true }); fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
    expect(forgen(['project', 'which', wt]).stdout).toContain('→ mainrepo');
  });
  it('심링크로 가린 홈은 등록하지 않는다', () => {
    const link = path.join(root, 'home-link'); fs.symlinkSync(home, link);
    const r = forgen(['project', 'add', 'evil', link]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('홈 폴더나 루트');
  });
  it('등록부가 깨지면 git 판정으로 돌아간다', () => {
    const reg = path.join(fhome, 'projects.json');
    const saved = fs.readFileSync(reg, 'utf-8');
    fs.writeFileSync(reg, '{ not json');
    try {
      expect(forgen(['project', 'which', repoA]).stdout).toContain('→ repo-a');
      expect(forgen(['project', 'which', plain]).stdout).toContain('프로젝트 아님');
    } finally { fs.writeFileSync(reg, saved); }
  });
  it('중첩 경로는 더 긴 등록 경로가 이긴다', () => {
    const inner = path.join(plain, 'inner'); fs.mkdirSync(inner, { recursive: true });
    expect(forgen(['project', 'add', 'inner-key', inner]).status).toBe(0);
    expect(forgen(['project', 'which', path.join(inner)]).stdout).toContain('→ inner-key');
    expect(forgen(['project', 'which', plain]).stdout).toContain('→ prod');
  });
});
