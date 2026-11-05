/**
 * D12-E: hook 프로토콜 결함 회귀 (H6, H8, H10, H11, H13 일부, failOpen 사유 전수) — 프로세스 실행.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DIST = path.join(ROOT, 'dist', 'hooks');
const have = fs.existsSync(path.join(DIST, 'pre-tool-use.js'));
const RM = ['r', 'm'].join('');

let root: string; let home: string; let fhome: string; let work: string;
const env = (extra: Record<string, string> = {}) => ({ ...process.env, HOME: home, FORGEN_HOME: fhome, FORGEN_CWD: work, FORGEN_NO_BLOCK_JUDGE: '1', FORGEN_NESTED_RUN: '', ...extra });
function run(hook: string, payload: unknown, extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [path.join(DIST, `${hook}.js`)], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf-8', timeout: 20000, cwd: work, env: env(extra) });
  return { out: r.stdout.trim(), err: r.stderr, status: r.status };
}
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-proto-'));
  home = path.join(root, 'home'); fhome = path.join(home, '.forgen'); work = path.join(root, 'work');
  fs.mkdirSync(path.join(fhome, 'state'), { recursive: true }); fs.mkdirSync(work, { recursive: true });
});
afterAll(() => { try { fs.chmodSync(path.join(root, 'ro'), 0o755); } catch { /* */ } fs.rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!have)('H10 pre-compact stdout', () => {
  it('자동 compound 안내가 stdout 을 오염시키지 않는다 (JSON 1개)', () => {
    const r = run('pre-compact', { session_id: '44444444-4444-4444-8444-444444444444', cwd: work, trigger: 'auto', transcript_path: path.join(root, 't.jsonl') });
    expect(r.status).toBe(0);
    expect(() => JSON.parse(r.out)).not.toThrow();
  });
});

describe.skipIf(!have)('H6 autopilot 키워드 상태가 새 세션으로 새지 않는다', () => {
  const statePath = () => path.join(fhome, 'state', 'autopilot-state.json');
  const write = (sessionId: string | undefined) => fs.writeFileSync(statePath(), JSON.stringify({ active: true, startedAt: new Date().toISOString(), prompt: 'build everything', ...(sessionId ? { sessionId } : {}) }));
  it('다른 세션이 켠 상태는 새 세션 SessionStart 에 주입되지 않는다', () => {
    write('old-session');
    const r = run('session-recovery', { session_id: 'brand-new-session', cwd: work, source: 'startup' });
    expect(r.out).not.toContain('compound-recovery');
    expect(r.out).not.toContain('build everything');
  });
  it('sessionId 없는 레거시 상태도 새 세션엔 주입하지 않는다', () => {
    write(undefined);
    expect(run('session-recovery', { session_id: 'another', cwd: work, source: 'startup' }).out).not.toContain('compound-recovery');
  });
  it('같은 세션(resume/compact)이면 복구한다', () => {
    write('same-session');
    expect(run('session-recovery', { session_id: 'same-session', cwd: work, source: 'resume' }).out).toContain('compound-recovery');
  });
  afterAll(() => { try { fs.unlinkSync(statePath()); } catch { /* */ } });
});

describe.skipIf(!have)('H11 permission-handler 는 실제 결정을 낸다', () => {
  it('root 삭제는 deny 결정', () => {
    const r = run('permission-handler', { session_id: 's', tool_name: 'Bash', tool_input: { command: `${RM} -rf /` } });
    const j = JSON.parse(r.out);
    expect(j.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
    expect(j.hookSpecificOutput.decision.behavior).toBe('deny');
  });
  it('평범한 명령은 기본 권한 흐름(결정 없음)', () => {
    const j = JSON.parse(run('permission-handler', { session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } }).out);
    expect(j.hookSpecificOutput).toBeUndefined();
  });
  it('다른 세션의 autopilot 상태는 이 세션의 경고에 영향 없음', () => {
    fs.writeFileSync(path.join(fhome, 'state', 'autopilot-state.json'), JSON.stringify({ active: true, startedAt: new Date().toISOString(), sessionId: 'other' }));
    const j = JSON.parse(run('permission-handler', { session_id: 'mine', tool_name: 'Bash', tool_input: { command: 'ls' } }).out);
    expect(j.systemMessage).toBeUndefined();
    fs.unlinkSync(path.join(fhome, 'state', 'autopilot-state.json'));
  });
});

describe.skipIf(!have)('H8 rate-limiter', () => {
  const call = (i: number) => new Promise<number>((resolve) => {
    const c = spawn(process.execPath, [path.join(DIST, 'rate-limiter.js')], { env: env(), cwd: work, stdio: ['pipe', 'pipe', 'ignore'] });
    c.stdin.end(JSON.stringify({ session_id: 's', tool_name: `mcp__srv__t${i}` }));
    c.on('close', (code) => resolve(code ?? -1));
  });
  it('동시 20회 호출이 전부 기록된다 (유실 없음)', async () => {
    const rl = path.join(fhome, 'state', 'rate-limit.json');
    try { fs.unlinkSync(rl); } catch { /* */ }
    const codes = await Promise.all(Array.from({ length: 20 }, (_, i) => call(i)));
    expect(codes.every((c) => c === 0)).toBe(true);
    expect(JSON.parse(fs.readFileSync(rl, 'utf-8')).calls).toHaveLength(20);
  }, 60000);
  it('stdin 이 깨지면 사유가 hook-errors.jsonl 에 남는다', () => {
    const log = path.join(fhome, 'state', 'hook-errors.jsonl');
    try { fs.unlinkSync(log); } catch { /* */ }
    run('rate-limiter', '{broken');
    const rows = fs.readFileSync(log, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const row = rows.find((r) => r.hook === 'rate-limiter');
    expect(row?.error).toMatch(/stdin/);
  });
  it('읽기 전용 상태 디렉터리: 통과(fail-open)하되 실패 사유를 stderr 로 알린다', () => {
    const ro = path.join(root, 'ro'); const rofh = path.join(ro, '.forgen');
    fs.mkdirSync(path.join(rofh, 'state'), { recursive: true });
    fs.chmodSync(path.join(rofh, 'state'), 0o555);
    const r = spawnSync(process.execPath, [path.join(DIST, 'rate-limiter.js')], { input: JSON.stringify({ session_id: 's', tool_name: 'mcp__a__b' }), encoding: 'utf-8', env: { ...env(), HOME: ro, FORGEN_HOME: rofh }, cwd: work, timeout: 15000 });
    fs.chmodSync(path.join(rofh, 'state'), 0o755);
    expect(JSON.parse(r.stdout.trim()).continue).toBe(true);
    expect(r.stderr).toMatch(/lock|EACCES|permission/i);
  });
});

describe('failOpenWithTracking 사유 전수 (정적 스캔)', () => {
  it('src/hooks 의 모든 failOpenWithTracking 호출이 사유(두 번째 인자)를 전달한다', () => {
    const dir = path.join(ROOT, 'src', 'hooks');
    const bad: string[] = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf-8');
      for (const m of src.matchAll(/failOpenWithTracking\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
        if (!m[1].includes(',')) bad.push(`${f}: failOpenWithTracking(${m[1]})`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('session-end 도 실패를 추적한다', () => {
    expect(fs.readFileSync(path.join(ROOT, 'src', 'hooks', 'session-end.ts'), 'utf-8')).toContain("failOpenWithTracking('session-end'");
  });
});
