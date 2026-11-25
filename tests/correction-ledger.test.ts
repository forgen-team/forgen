/**
 * 0.8.0 M2: 교정 3분류 — 실제 훅(session-recovery·context-guard)과 MCP correction-record 프로세스로 검증.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DIST = path.resolve(import.meta.dirname, '..', 'dist');
const have = fs.existsSync(path.join(DIST, 'core', 'correction-ledger.js'));
let root: string; let home: string; let fhome: string; let repoA: string; let repoB: string;
const env = () => { const e: Record<string, string | undefined> = { ...process.env, HOME: home, FORGEN_HOME: fhome, FORGEN_NO_BLOCK_JUDGE: '1', FORGEN_NESTED_RUN: '' }; delete e.FORGEN_CWD; delete e.COMPOUND_CWD; return e as NodeJS.ProcessEnv; };
const hook = (name: string, payload: object) => spawnSync(process.execPath, [path.join(DIST, 'hooks', `${name}.js`)], { input: JSON.stringify(payload), encoding: 'utf-8', cwd: home, env: env(), timeout: 20000 });
const rule = (id: string, policy: string, extra: object = {}) => {
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(fhome, 'me', 'rules', `${id}.json`), JSON.stringify({ rule_id: id, category: 'workflow', scope: 'me', trigger: 't', policy, strength: 'default', source: 'explicit_correction', status: 'active', evidence_refs: [], render_key: `k.${id}`, created_at: now, updated_at: now, ...extra }));
};
const ledger = () => fs.readFileSync(path.join(fhome, 'state', 'metrics', 'corrections.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));

class Mcp {
  p: ChildProcess; buf = ''; id = 1; pend = new Map<number, (r: any) => void>();
  constructor() {
    this.p = spawn(process.execPath, [path.join(DIST, 'mcp', 'server.js')], { cwd: home, env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.p.stdout!.on('data', (c) => { this.buf += c; let i: number; while ((i = this.buf.indexOf('\n')) >= 0) { const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); try { const m = JSON.parse(l); this.pend.get(m.id)?.(m); } catch { /* */ } } });
    this.p.stderr!.on('data', () => {});
  }
  send(method: string, params?: unknown): Promise<any> { const id = this.id++; return new Promise((res) => { this.pend.set(id, res); this.p.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }); }
  record(sid: string, cwd: string, message: string) { return this.send('tools/call', { name: 'correction-record', arguments: { session_id: sid, kind: 'prefer-from-now', message, target: `ledger ${message.slice(0, 6)}`, axis_hint: null, origin: { cwd } } }); }
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-ledger-')));
  home = path.join(root, 'home'); fhome = path.join(home, '.forgen');
  repoA = path.join(home, 'repo-a'); repoB = path.join(home, 'repo-b');
  for (const d of [path.join(repoA, '.git'), path.join(repoB, '.git'), path.join(fhome, 'me', 'rules'), path.join(fhome, 'state')]) fs.mkdirSync(d, { recursive: true });
  rule('g1', '작업 결과를 보고할 때는 항상 확인한 것과 못 한 것을 나눠서 적는다');
  rule('b1', '레포 B 에서는 배포 전에 마이그레이션 목록을 반드시 먼저 보여 준다', { projects: ['repo-b'] });
});
afterAll(() => { if (!process.env.KEEP) fs.rmSync(root, { recursive: true, force: true }); else console.log("ROOT", root); });

describe.skipIf(!have)('M2 교정 3분류', () => {
  it('재발 / 전달 실패(범위) / 신규 / 판정 불가', async () => {
    hook('session-recovery', { session_id: 'L1', cwd: home, source: 'startup', hook_event_name: 'SessionStart' });
    const m = new Mcp();
    await m.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    await m.record('L1', home, '작업 결과를 보고할 때는 항상 확인한 것과 못 한 것을 나눠서 적는다');        // g1 은 이 세션에 들어갔다 → 재발
    await m.record('L1', home, '레포 B 에서는 배포 전에 마이그레이션 목록을 반드시 먼저 보여 준다');      // b1 은 프로젝트 밖이라 안 들어갔다 → 전달 실패(scope)
    await m.record('L1', home, '테스트 픽스처 이름은 시나리오를 한국어로 짧게 적는다 새로운 교정 문장');  // 같은 뜻 룰 없음 → 신규
    await m.record('NO-SESSION-FILE', home, '작업 결과를 보고할 때는 항상 확인한 것과 못 한 것을 나눠서 적는다'); // 세션 기록 없음
    m.p.kill();
    const rows = ledger();
    expect(rows.map((r) => r.class)).toEqual(['recurrence', 'delivery-failure', 'new', 'unknown-delivery']);
    expect(rows[0].match.rule_id).toBe('g1');
    expect(rows[1]).toMatchObject({ reason: 'scope', match: { rule_id: 'b1' } });
  });
  it('위치 전환으로 들어간 프로젝트 룰은 "들어갔다"로 센다', async () => {
    hook('session-recovery', { session_id: 'L2', cwd: home, source: 'startup', hook_event_name: 'SessionStart' });
    hook('context-guard', { session_id: 'L2', cwd: repoB, prompt: 'p', hook_event_name: 'UserPromptSubmit' });
    const m = new Mcp();
    await m.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    await m.record('L2', repoB, '레포 B 에서는 배포 전에 마이그레이션 목록을 반드시 먼저 보여 준다');
    m.p.kill();
    expect(ledger().pop().class).toBe('recurrence');
  });
  it('같은 세션에서 같은 교정을 되풀이하면(임시 룰이 이미 있음) 재발', async () => {
    hook('session-recovery', { session_id: 'L3', cwd: home, source: 'startup', hook_event_name: 'SessionStart' });
    const m = new Mcp();
    await m.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const fix = (msg: string) => m.send('tools/call', { name: 'correction-record', arguments: { session_id: 'L3', kind: 'fix-now', message: msg, target: 'same target twice', axis_hint: null, origin: { cwd: home } } });
    await fix('도커 볼륨 마운트 경로는 절대 경로만 허용 반복 확인용 문장');
    await fix('도커 볼륨 마운트 경로는 절대 경로만 허용 반복 확인용 문장');
    m.p.kill();
    const rows = ledger().filter((r) => r.session === "L3");
    expect(rows.map((r) => r.class)).toEqual(['new', 'recurrence']);
  });
  it('status 가 분류를 보여 준다', () => {
    const r = spawnSync(process.execPath, [path.join(DIST, 'cli.js'), 'status'], { encoding: 'utf-8', cwd: home, env: env() });
    expect(r.stdout).toMatch(/재발 3 · 전달 실패 1 · 신규 2 · 판정 불가 1/);
  });
});
