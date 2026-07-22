/**
 * OpenCode plugin 슬림 통합 테스트 — 슬림이 실제 forgen 가드 바이너리(dist)로
 * tool.execute.before 를 브릿지해 위험 명령을 block 하는지 실측 (W3-3 P1).
 * 실 spawn 이라 dist 빌드 선행 필요.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distHooks = path.join(repoRoot, 'dist', 'hooks');

// dist 가 없으면 빌드 (CI 는 build 후 test 라 보통 존재)
beforeAll(() => {
  if (!fs.existsSync(path.join(distHooks, 'db-guard.js'))) {
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'ignore' });
  }
});

describe('opencode plugin 슬림 (실 forgen 가드 브릿지)', () => {
  it('rm -rf bash 명령 → db-guard 가 block (throw 신호)', async () => {
    const { runPreToolGuards } = await import('../src/host/opencode/plugin/forgen.js');
    const { toolBeforeToClaudeInput } = await import('../src/host/opencode/translate.js');
    const input = toolBeforeToClaudeInput('bash', { command: 'rm -rf /tmp/important-data' });
    const decision = runPreToolGuards(input, { hookDir: distHooks });
    expect(decision.block).toBe(true);
    expect(decision.reason).toMatch(/rm -rf|confirm/i);
  });

  it('안전 명령(ls) → block 없음', async () => {
    const { runPreToolGuards } = await import('../src/host/opencode/plugin/forgen.js');
    const { toolBeforeToClaudeInput } = await import('../src/host/opencode/translate.js');
    const input = toolBeforeToClaudeInput('bash', { command: 'ls -la' });
    expect(runPreToolGuards(input, { hookDir: distHooks }).block).toBe(false);
  });

  it('plugin 팩토리가 tool.execute.before 훅을 노출하고, 위험 tool 에 throw', async () => {
    const { forgen } = await import('../src/host/opencode/plugin/forgen.js');
    const hooks = await forgen({});
    expect(typeof hooks['tool.execute.before']).toBe('function');
    // FORGEN_HOOK_DIR 로 실 가드 지정
    const prev = process.env.FORGEN_HOOK_DIR;
    process.env.FORGEN_HOOK_DIR = distHooks;
    try {
      await expect(
        hooks['tool.execute.before']!({ tool: 'bash' }, { args: { command: 'rm -rf /tmp/x' } }),
      ).rejects.toThrow(/rm -rf|confirm|forgen/i);
      // 안전 명령은 throw 안 함
      await expect(
        hooks['tool.execute.before']!({ tool: 'bash' }, { args: { command: 'echo hi' } }),
      ).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.FORGEN_HOOK_DIR;
      else process.env.FORGEN_HOOK_DIR = prev;
    }
  });

  it('fail-open: 존재하지 않는 hookDir → block 없음(가드 부재가 도구를 막지 않음)', async () => {
    const { runPreToolGuards } = await import('../src/host/opencode/plugin/forgen.js');
    const { toolBeforeToClaudeInput } = await import('../src/host/opencode/translate.js');
    const input = toolBeforeToClaudeInput('bash', { command: 'rm -rf /' });
    expect(runPreToolGuards(input, { hookDir: '/nonexistent/hooks' }).block).toBe(false);
  });
});
