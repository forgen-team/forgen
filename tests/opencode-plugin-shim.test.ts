/**
 * OpenCode plugin 슬림 통합 테스트 — 가드 러너/브릿지 CLI 가 실제 forgen 가드 바이너리
 * (dist)로 tool.execute.before 를 브릿지해 위험 명령을 block 하는지 실측 (W3-3 P1).
 * 실 spawn 이라 dist 빌드 선행 필요.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distHooks = path.join(repoRoot, 'dist', 'hooks');
const distCli = path.join(repoRoot, 'dist', 'cli.js');

beforeAll(() => {
  if (!fs.existsSync(path.join(distHooks, 'db-guard.js')) || !fs.existsSync(distCli)) {
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'ignore' });
  }
});

describe('opencode 가드 러너 (async, 실 forgen 가드 브릿지)', () => {
  it('rm -rf → db-guard block (async runPreToolGuards)', async () => {
    const { runPreToolGuards } = await import('../src/host/opencode/plugin/forgen.js');
    const { toolBeforeToClaudeInput } = await import('../src/host/opencode/translate.js');
    const input = toolBeforeToClaudeInput('bash', { command: 'rm -rf /tmp/important-data' });
    const decision = await runPreToolGuards(input, { hookDir: distHooks });
    expect(decision.block).toBe(true);
    expect(decision.reason).toMatch(/rm -rf|confirm/i);
  });

  it('안전 명령(ls) → block 없음', async () => {
    const { runPreToolGuards } = await import('../src/host/opencode/plugin/forgen.js');
    const { toolBeforeToClaudeInput } = await import('../src/host/opencode/translate.js');
    const input = toolBeforeToClaudeInput('bash', { command: 'ls -la' });
    expect((await runPreToolGuards(input, { hookDir: distHooks })).block).toBe(false);
  });

  it('fail-open: 미존재 hookDir → block 없음 (로그 남기고 계속)', async () => {
    const { runPreToolGuards } = await import('../src/host/opencode/plugin/forgen.js');
    const { toolBeforeToClaudeInput } = await import('../src/host/opencode/translate.js');
    const input = toolBeforeToClaudeInput('bash', { command: 'rm -rf /' });
    expect((await runPreToolGuards(input, { hookDir: '/nonexistent/hooks' })).block).toBe(false);
  });
});

describe('forgen opencode-guard CLI (실 배포 플러그인이 호출하는 브릿지)', () => {
  function guard(payload: unknown): { block?: boolean; reason?: string } {
    const out = execFileSync('node', [distCli, 'opencode-guard'], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
    });
    return JSON.parse(out);
  }

  it('rm -rf → block + reason', () => {
    const d = guard({ tool: 'bash', args: { command: 'rm -rf /tmp/x' } });
    expect(d.block).toBe(true);
    expect(d.reason).toMatch(/rm -rf|confirm/i);
  });

  it('안전 명령 → block 없음', () => {
    expect(guard({ tool: 'bash', args: { command: 'echo hi' } }).block).toBe(false);
  });

  it('빈/깨진 입력 → fail-open', () => {
    expect(guard({}).block).toBe(false);
  });
});

describe('forgen opencode-context CLI (compaction 시 forge-loop 상태 주입)', () => {
  const home = path.join(repoRoot, 'node_modules', '.tmp-oc-ctx-home');
  function ctx(): string {
    return execFileSync('node', [distCli, 'opencode-context'], {
      encoding: 'utf-8',
      env: { ...process.env, FORGEN_HOME: home },
    });
  }
  beforeAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  });

  it('활성 forge-loop → <forge-loop-state> 블록 출력', () => {
    fs.writeFileSync(
      path.join(home, 'state', 'forge-loop.json'),
      JSON.stringify({
        active: true,
        task: 'W3-3 슬림',
        startedAt: new Date().toISOString(),
        stories: [{ id: 'S1', title: 'context 증분', passes: false }],
      }),
    );
    const out = ctx();
    expect(out).toContain('<forge-loop-state>');
    expect(out).toContain('S1');
  });

  it('활성 forge-loop 없음 → 빈 출력(주입 안 함)', () => {
    fs.rmSync(path.join(home, 'state', 'forge-loop.json'), { force: true });
    expect(ctx().trim()).toBe('');
  });
});
