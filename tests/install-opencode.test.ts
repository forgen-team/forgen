import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { planOpencodeInstall } from '../src/host/install-opencode.js';

const TMP = path.join(os.tmpdir(), 'forgen-test-install-opencode');
const CFG = path.join(TMP, 'config-opencode');
const AGENTS = path.join(TMP, 'AGENTS.md');
// pkgRoot = repo root (assets/opencode/forgen.ts 존재)
const pkgRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function opts(extra: Record<string, unknown> = {}) {
  return { pkgRoot, opencodeConfigDir: CFG, agentsMdPath: AGENTS, ...extra };
}

describe('install-opencode (W3-3 P1)', () => {
  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

  it('plugin 을 plugins/forgen.ts 로 배포', () => {
    const r = planOpencodeInstall(opts());
    expect(r.pluginInstalled).toBe(true);
    expect(fs.existsSync(r.pluginPath)).toBe(true);
    const src = fs.readFileSync(r.pluginPath, 'utf-8');
    // 배포된 plugin 이 tool.execute.before + opencode-guard 브릿지를 포함
    expect(src).toContain('tool.execute.before');
    expect(src).toContain('opencode-guard');
  });

  it('opencode.json 에 mcp.forgen-compound 등록 (local, node server, --host=opencode)', () => {
    const r = planOpencodeInstall(opts());
    expect(r.mcpRegistered).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(CFG, 'opencode.json'), 'utf-8'));
    const mcp = cfg.mcp['forgen-compound'];
    expect(mcp.type).toBe('local');
    expect(mcp.enabled).toBe(true);
    expect(mcp.command[0]).toBe('node');
    expect(mcp.command).toContain('--host=opencode');
    expect(mcp.command[1]).toMatch(/dist\/mcp\/server\.js$/);
    expect(cfg.$schema).toContain('opencode.ai');
  });

  it('재실행 시 MCP 이미 존재로 인식 (idempotent)', () => {
    planOpencodeInstall(opts());
    const r2 = planOpencodeInstall(opts());
    expect(r2.mcpAlreadyPresent).toBe(true);
    expect(r2.mcpRegistered).toBe(false);
  });

  it('기존 사용자 opencode.json 의 다른 키 보존', () => {
    fs.mkdirSync(CFG, { recursive: true });
    fs.writeFileSync(path.join(CFG, 'opencode.json'), JSON.stringify({ theme: 'dark', model: 'x' }));
    planOpencodeInstall(opts());
    const cfg = JSON.parse(fs.readFileSync(path.join(CFG, 'opencode.json'), 'utf-8'));
    expect(cfg.theme).toBe('dark');
    expect(cfg.model).toBe('x');
    expect(cfg.mcp['forgen-compound']).toBeDefined();
  });

  it('dry-run: 파일 미작성', () => {
    const r = planOpencodeInstall(opts({ dryRun: true }));
    expect(fs.existsSync(r.pluginPath)).toBe(false);
    expect(fs.existsSync(path.join(CFG, 'opencode.json'))).toBe(false);
  });

  it('AGENTS.md 에 forgen rules 주입', () => {
    const r = planOpencodeInstall(opts());
    expect(r.agentsMdInjected).toBe(true);
    expect(fs.readFileSync(AGENTS, 'utf-8')).toContain('forgen-managed-rules');
  });
});
