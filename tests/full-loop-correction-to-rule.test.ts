/**
 * V8: 풀 루프 — correction (MCP) → rule 생성 (evidence-processor) → stop-guard
 * 에서 rule 이 Mech-B 로 fire → block 발생.
 *
 * "Session 1 에서 기록한 correction 이 Session 2 에서 실제로 작동한다" 는 것을
 * 한 TEST_HOME 내 두 개의 독립 프로세스로 증명.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';

const TEST_HOME = `/tmp/forgen-test-v8-${process.pid}`;
const MCP_BIN = path.resolve('dist/mcp/server.js');
const STOP_GUARD = path.resolve('dist/hooks/stop-guard.js');

class McpClient {
  private proc: ChildProcess;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, (r: any) => void>();
  constructor(home: string) {
    this.proc = spawn('node', [MCP_BIN], {
      env: { ...process.env, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.on('data', (c) => {
      this.buffer += c.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const cb = this.pending.get(Number(msg.id));
          if (cb) { this.pending.delete(Number(msg.id)); cb(msg); }
        } catch { /* ignore */ }
      }
    });
    this.proc.stderr!.on('data', () => {});
  }
  send(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)); }, 5000);
      this.pending.set(id, (r) => { clearTimeout(to); resolve(r); });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  close() { this.proc.kill(); }
}

function callStopGuard(home: string, lastMessage: string): any {
  const r = spawnSync('node', [STOP_GUARD], {
    input: JSON.stringify({ session_id: 'v8-session-2', stop_hook_active: true }),
    env: { ...process.env, HOME: home, FORGEN_SPIKE_LAST_MESSAGE: lastMessage },
    encoding: 'utf-8',
    timeout: 5000,
  });
  const last = (r.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
  try { return { ...JSON.parse(last), exitCode: r.status }; }
  catch { return { exitCode: r.status, raw: r.stdout, err: r.stderr }; }
}

describe('V8: correction → rule → cross-session activation', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('Session 1 MCP correction → rule 파일 생성 → Session 2 stop-guard 가 block', async () => {
    fs.mkdirSync(TEST_HOME, { recursive: true });

    // ── Session 1: MCP 로 avoid-this correction 기록 ──
    const client = new McpClient(TEST_HOME);
    try {
      await client.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'v8', version: '1' },
      });
      const r = await client.send('tools/call', {
        name: 'correction-record',
        arguments: {
          session_id: 'v8-session-1',
          kind: 'avoid-this',
          message: '"완성됐습니다" 같은 자화자찬 완료 선언 금지. 검증 후 발언하라.',
          target: '완성됐습니다',
          axis_hint: 'quality_safety',
        },
      });
      expect(r.error).toBeUndefined();
      expect(r.result?.isError).not.toBe(true);
    } finally {
      client.close();
    }

    // ── Rule 실제 디스크 저장 확인 ──
    const rulesDir = path.join(TEST_HOME, '.forgen', 'me', 'rules');
    expect(fs.existsSync(rulesDir)).toBe(true);
    const ruleFiles = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.json'));
    expect(ruleFiles.length).toBeGreaterThanOrEqual(1);
    const ruleContent = JSON.parse(fs.readFileSync(path.join(rulesDir, ruleFiles[0]), 'utf-8'));
    expect(ruleContent.strength).toBe('strong');
    expect(ruleContent.status).toBe('active');
    // auto-classify 가 enforce_via 를 채웠어야 다음 세션에서 fire 함
    expect(Array.isArray(ruleContent.enforce_via)).toBe(true);
    expect(ruleContent.enforce_via.length).toBeGreaterThanOrEqual(1);
    // Mech-B Stop hook 으로 분류됐어야 — trigger_keywords 기반
    const hasStopMech = ruleContent.enforce_via.some((e: any) => e.hook === 'Stop');
    expect(hasStopMech).toBe(true);

    // ── Session 2: 독립 spawn stop-guard 가 같은 HOME 에서 rule 로드 ──
    // 의미 룰은 기본이 기록만: 다음 세션에 판정되지만 차단하지 않는다
    const defaultResp = callStopGuard(TEST_HOME, '기능 구현이 완성됐습니다.');
    expect(defaultResp.exitCode).toBe(0);
    expect(defaultResp.decision).not.toBe('block');
    const violations = path.join(TEST_HOME, '.forgen', 'state', 'enforcement', 'violations.jsonl');
    expect(fs.readFileSync(violations, 'utf-8')).toContain('"kind":"correction"');

    // 실제 CLI `forgen rule enforce` 로 켜면 다음 세션에서 차단한다
    const enforce = spawnSync(process.execPath, [path.join(process.cwd(), 'dist', 'cli.js'), 'rule', 'enforce', ruleContent.rule_id], {
      encoding: 'utf-8', cwd: TEST_HOME, env: { ...process.env, HOME: TEST_HOME, FORGEN_HOME: path.join(TEST_HOME, '.forgen') },
    });
    expect(enforce.stdout).toContain('advise → block');
    const triggerResp = callStopGuard(TEST_HOME, '기능 구현이 완성됐습니다.');
    expect(triggerResp.exitCode).toBe(0);
    expect(triggerResp.decision).toBe('block');
    expect(triggerResp.reason).toMatch(/완성|검증|forgen/i);

    // ── Control: trigger 없는 발언은 approve ──
    const neutralResp = callStopGuard(TEST_HOME, '작업을 계속 진행하고 있습니다.');
    expect(neutralResp.exitCode).toBe(0);
    expect(neutralResp.decision).not.toBe('block');
  });

  it('prefer-from-now correction: evidence 만 생성, rule 없음 (block 안 함)', async () => {
    fs.mkdirSync(TEST_HOME, { recursive: true });
    const client = new McpClient(TEST_HOME);
    try {
      await client.send('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'v8', version: '1' },
      });
      await client.send('tools/call', {
        name: 'correction-record',
        arguments: {
          session_id: 'v8-s1',
          kind: 'prefer-from-now',
          message: '앞으로는 async/await 선호',
          target: '.then() 체인',
          axis_hint: 'quality_safety',
        },
      });
    } finally {
      client.close();
    }

    // evidence 는 생성
    const behaviorDir = path.join(TEST_HOME, '.forgen', 'me', 'behavior');
    expect(fs.existsSync(behaviorDir)).toBe(true);
    expect(fs.readdirSync(behaviorDir).filter((f) => f.endsWith('.json')).length).toBeGreaterThanOrEqual(1);

    // rule 은 생성 안 됨 (prefer-from-now 정책)
    const rulesDir = path.join(TEST_HOME, '.forgen', 'me', 'rules');
    const ruleFiles = fs.existsSync(rulesDir) ? fs.readdirSync(rulesDir).filter((f) => f.endsWith('.json')) : [];
    expect(ruleFiles.length).toBe(0);
  });

  it('fix-now correction: default-strength session rule 생성', async () => {
    fs.mkdirSync(TEST_HOME, { recursive: true });
    const client = new McpClient(TEST_HOME);
    try {
      await client.send('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'v8', version: '1' },
      });
      await client.send('tools/call', {
        name: 'correction-record',
        arguments: {
          session_id: 'v8-s1',
          kind: 'fix-now',
          message: '당장 this approach 멈춰',
          target: '이 접근법',
          axis_hint: 'judgment_philosophy',
        },
      });
    } finally {
      client.close();
    }

    const rulesDir = path.join(TEST_HOME, '.forgen', 'me', 'rules');
    expect(fs.existsSync(rulesDir)).toBe(true);
    const ruleFiles = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.json'));
    expect(ruleFiles.length).toBe(1);
    const rule = JSON.parse(fs.readFileSync(path.join(rulesDir, ruleFiles[0]), 'utf-8'));
    expect(rule.strength).toBe('default');
    expect(rule.scope).toBe('session');
  });
});
