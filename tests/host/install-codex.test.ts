/**
 * Codex InstallPlan — Multi-Host Core Design §10 우선순위 3 단위 테스트
 *
 * 핵심 검증:
 *   - hooks.json 가 절대경로 + codex-adapter wrap 으로 생성된다 (spec §18.5 옵션 1).
 *   - 사용자 비-forgen hook 은 보존된다 (managed marker pattern).
 *   - 재실행 시 idempotent (forgen entry 가 중복되지 않는다).
 *   - MCP 등록은 marker block 으로 idempotent.
 *   - $CODEX_HOME 존중.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planCodexInstall } from '../../src/host/install-codex.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const PKG_ROOT = process.cwd(); // forgen 자체

describe('planCodexInstall', () => {
  let codexHome: string;

  beforeEach(() => {
    codexHome = tmpDir('codex-install-test-');
  });

  afterEach(() => {
    if (fs.existsSync(codexHome)) {
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('빈 codexHome 에 hooks.json 새로 작성, 절대경로 + codex-adapter wrap', () => {
    const result = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    expect(result.hooksWritten).toBe(true);
    expect(result.hooksCount).toBeGreaterThan(0);
    expect(result.preservedUserHookCount).toBe(0);

    const written = JSON.parse(fs.readFileSync(result.hooksPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const allCommands = Object.values(written.hooks)
      .flat()
      .flatMap((g) => g.hooks.map((h) => h.command));
    expect(allCommands.length).toBe(result.hooksCount);
    // 모든 command 가 codex-adapter 를 경유 + 절대경로
    for (const c of allCommands) {
      expect(c).toContain('codex-adapter');
      expect(c).toMatch(/node "\/.+codex-adapter\.js"/);
      expect(c).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    }
  });

  it('사용자가 직접 작성한 hook 항목은 보존된다', () => {
    const userHooksPath = path.join(codexHome, 'hooks.json');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      userHooksPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'node /home/user/my-own-hook.js' }],
            },
          ],
        },
      }),
    );

    const result = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    expect(result.preservedUserHookCount).toBe(1);

    const final = JSON.parse(fs.readFileSync(result.hooksPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const pre = (final.hooks.PreToolUse ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    expect(pre).toContain('node /home/user/my-own-hook.js');
    // forgen 측 entry 도 함께 존재
    expect(pre.some((c) => c.includes('codex-adapter'))).toBe(true);
  });

  it('재실행 시 idempotent — forgen entry 가 중복되지 않음', () => {
    const r1 = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    const r2 = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    expect(r2.hooksCount).toBe(r1.hooksCount);
    expect(r2.preservedUserHookCount).toBe(0);
  });

  it('MCP 등록 marker block 이 idempotent (재실행 시 alreadyPresent=true)', () => {
    const r1 = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    expect(r1.mcpRegistered).toBe(true);
    expect(r1.mcpAlreadyPresent).toBe(false);

    const r2 = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    expect(r2.mcpRegistered).toBe(false);
    expect(r2.mcpAlreadyPresent).toBe(true);

    const toml = fs.readFileSync(r1.configTomlPath, 'utf-8');
    const beginCount = (toml.match(/forgen-managed-mcp/g) || []).length;
    expect(beginCount).toBe(2); // begin + end markers, single block
    expect(toml).toContain('[mcp_servers.forgen-compound]');
    expect(toml).toContain('command = "node"');
  });

  it('config.toml 에 사용자 기존 내용이 있어도 보존', () => {
    const tomlPath = path.join(codexHome, 'config.toml');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(tomlPath, '[user]\nkey = "value"\n');

    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    expect(r.mcpRegistered).toBe(true);

    const toml = fs.readFileSync(tomlPath, 'utf-8');
    expect(toml).toContain('[user]');
    expect(toml).toContain('key = "value"');
    expect(toml).toContain('[mcp_servers.forgen-compound]');
  });

  it('dryRun: 파일 미작성', () => {
    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, dryRun: true });
    expect(r.hooksWritten).toBe(false);
    expect(fs.existsSync(r.hooksPath)).toBe(false);
    expect(fs.existsSync(r.configTomlPath)).toBe(false);
  });

  it('registerMcp:false 면 config.toml 미작성', () => {
    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, registerMcp: false });
    expect(r.mcpRegistered).toBe(false);
    expect(fs.existsSync(r.configTomlPath)).toBe(false);
  });

  it('CODEX_HOME env var 로 위치 재배치', () => {
    const original = process.env.CODEX_HOME;
    const altHome = tmpDir('codex-alt-');
    try {
      process.env.CODEX_HOME = altHome;
      const r = planCodexInstall({ pkgRoot: PKG_ROOT });
      expect(r.codexHome).toBe(altHome);
      expect(fs.existsSync(path.join(altHome, 'hooks.json'))).toBe(true);
    } finally {
      if (original === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = original;
      fs.rmSync(altHome, { recursive: true, force: true });
    }
  });
});
