import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { planOpencodeInstall } from '../src/host/install-opencode.js';
import { parse as parseJsonc } from 'jsonc-parser';

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

  it('HIGH 회귀: JSONC(주석+trailing comma) config 를 clobber 하지 않고 설정·주석 보존', () => {
    fs.mkdirSync(CFG, { recursive: true });
    const jsonc = '{\n  // user model\n  "model": "anthropic/claude",\n  "theme": "dark",\n  "keybinds": { "x": "y" },\n}';
    fs.writeFileSync(path.join(CFG, 'opencode.jsonc'), jsonc);
    const r = planOpencodeInstall(opts());
    // .jsonc 를 대상으로 감지
    expect(r.mcpConfigPath.endsWith('opencode.jsonc')).toBe(true);
    const raw = fs.readFileSync(r.mcpConfigPath, 'utf-8');
    expect(raw).toContain('// user model'); // 주석 보존
    const parsed = parseJsonc(raw, [], { allowTrailingComma: true }) as Record<string, unknown>;
    expect(parsed.model).toBe('anthropic/claude'); // 설정 미소실
    expect(parsed.theme).toBe('dark');
    expect(parsed.keybinds).toEqual({ x: 'y' });
    expect((parsed.mcp as Record<string, unknown>)['forgen-compound']).toBeDefined();
    // 백업 생성
    expect(r.mcpBackupPath && fs.existsSync(r.mcpBackupPath)).toBe(true);
  });

  it('HIGH 회귀: 파싱 불가 config → clobber 안 하고 skip (사용자 파일 보존)', () => {
    fs.mkdirSync(CFG, { recursive: true });
    const broken = '{ this is not valid json ]]]';
    fs.writeFileSync(path.join(CFG, 'opencode.json'), broken);
    const r = planOpencodeInstall(opts());
    expect(r.mcpSkippedUnparseable).toBe(true);
    expect(fs.readFileSync(path.join(CFG, 'opencode.json'), 'utf-8')).toBe(broken); // 미변경
  });

  it('MED4: 배포 plugin 이 절대 CLI 경로 임베드 (런타임 PATH 비의존)', () => {
    const r = planOpencodeInstall(opts());
    const plugin = fs.readFileSync(r.pluginPath, 'utf-8');
    expect(plugin).toMatch(/\["node", ".*dist\/cli\.js", "opencode-guard"\]/);
    expect(plugin).not.toContain('["forgen", "opencode-guard"]');
  });

  it('MED3: 사용자 소유 plugin(비-managed) 은 덮어쓰기 전 백업', () => {
    fs.mkdirSync(path.join(CFG, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(CFG, 'plugins', 'forgen.ts'), 'export const mine = 1 // user own');
    const r = planOpencodeInstall(opts());
    expect(r.pluginBackupPath && fs.existsSync(r.pluginBackupPath)).toBe(true);
    expect(fs.readFileSync(r.pluginBackupPath!, 'utf-8')).toContain('user own');
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
