import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { planOpencodeInstall } from '../src/host/install-opencode.js';
import { planOpencodeUninstall, removeOpencodeMcp, renderOpencodeUninstall } from '../src/host/uninstall-opencode.js';
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

  it('MED4: 배포 plugin 이 절대 CLI 경로 임베드 (guard+context, 런타임 PATH 비의존)', () => {
    const r = planOpencodeInstall(opts());
    const plugin = fs.readFileSync(r.pluginPath, 'utf-8');
    expect(plugin).toMatch(/\["node", ".*dist\/cli\.js", "opencode-guard"\]/);
    expect(plugin).toMatch(/\["node", ".*dist\/cli\.js", "opencode-context"\]/);
    expect(plugin).not.toContain('["forgen", "opencode-guard"]');
    expect(plugin).not.toContain('["forgen", "opencode-context"]');
  });

  it('배포 plugin 에 tool.execute.before + compaction 훅 둘 다 포함', () => {
    const r = planOpencodeInstall(opts());
    const plugin = fs.readFileSync(r.pluginPath, 'utf-8');
    expect(plugin).toContain('tool.execute.before');
    expect(plugin).toContain('experimental.session.compacting');
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

describe('uninstall-opencode (ADR-016 0.5.9)', () => {
  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

  it('install → uninstall: plugin·MCP·AGENTS.md 블록이 사라지고 사용자 config 는 남는다', () => {
    fs.mkdirSync(CFG, { recursive: true });
    const userCfg = '{\n  // my config\n  "theme": "dark",\n  "mcp": {\n    "other": { "type": "local", "command": ["x"] },\n  },\n}\n';
    fs.writeFileSync(path.join(CFG, 'opencode.jsonc'), userCfg);
    const inst = planOpencodeInstall(opts());
    expect(inst.mcpRegistered).toBe(true);

    const r = planOpencodeUninstall(opts());
    expect(r.pluginRemoved).toBe(true);
    expect(r.pluginRestoredFromBackup).toBe(false);
    expect(r.mcpRemoved).toBe(true);
    expect(r.agentsMdCleanedPaths).toEqual([AGENTS]);
    expect(fs.existsSync(inst.pluginPath)).toBe(false);
    const after = fs.readFileSync(path.join(CFG, 'opencode.jsonc'), 'utf-8');
    expect(after).toContain('// my config'); // 주석 보존
    const parsed = parseJsonc(after, [], { allowTrailingComma: true });
    expect(parsed.theme).toBe('dark');
    expect(Object.keys(parsed.mcp)).toEqual(['other']);
    expect(fs.existsSync(AGENTS)).toBe(false);
    expect(fs.existsSync(path.join(CFG, 'forgen-agents-md.json'))).toBe(false);
    expect(renderOpencodeUninstall(r).length).toBeGreaterThanOrEqual(3);
    // 두 번째 실행은 no-op
    const again = planOpencodeUninstall(opts());
    expect([again.pluginRemoved, again.mcpRemoved, again.agentsMdCleanedPaths.length]).toEqual([false, false, 0]);
  });

  it('forgen 만 있던 mcp 는 키째 제거한다; 같은 이름의 사용자 서버는 건드리지 않는다', () => {
    planOpencodeInstall(opts());
    const cfgPath = path.join(CFG, 'opencode.json');
    planOpencodeUninstall(opts());
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).mcp).toBeUndefined();

    const mine = JSON.stringify({ mcp: { 'forgen-compound': { type: 'local', command: ['python', '/mine/server.py'] } } }, null, 2);
    expect(removeOpencodeMcp(mine)).toEqual({ content: mine, removed: false, unparseable: false });
  });

  it('설치 때 백업한 사용자 plugin 을 되돌린다; 마커 없는 사용자 plugin 은 지우지 않는다', () => {
    const pluginPath = path.join(CFG, 'plugins', 'forgen.ts');
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.writeFileSync(pluginPath, '// my own plugin named forgen.ts\nexport default {};\n');
    const inst = planOpencodeInstall(opts());
    expect(inst.pluginBackupPath).toBe(`${pluginPath}.bak`);
    const r = planOpencodeUninstall(opts());
    expect(r.pluginRestoredFromBackup).toBe(true);
    expect(fs.readFileSync(pluginPath, 'utf-8')).toContain('my own plugin');
    expect(fs.existsSync(`${pluginPath}.bak`)).toBe(false);
    // 이제 그 파일은 사용자 것 — 다시 uninstall 해도 남는다
    expect(planOpencodeUninstall(opts()).pluginRemoved).toBe(false);
    expect(fs.existsSync(pluginPath)).toBe(true);
  });

  it('파싱 불가 config 는 건드리지 않고 알린다; dry-run 은 아무것도 쓰지 않는다; config dir 없으면 no-op', () => {
    const inst = planOpencodeInstall(opts());
    const cfgPath = path.join(CFG, 'opencode.json');
    const good = fs.readFileSync(cfgPath, 'utf-8');
    const dry = planOpencodeUninstall(opts({ dryRun: true }));
    expect([dry.pluginRemoved, dry.mcpRemoved]).toEqual([true, true]);
    expect(fs.readFileSync(cfgPath, 'utf-8')).toBe(good);
    expect(fs.existsSync(inst.pluginPath)).toBe(true);

    fs.writeFileSync(cfgPath, '{ broken');
    const r = planOpencodeUninstall(opts());
    expect(r.mcpSkippedUnparseable).toBe(true);
    expect(fs.readFileSync(cfgPath, 'utf-8')).toBe('{ broken');
    expect(renderOpencodeUninstall(r).join('\n')).toMatch(/not valid JSONC/);

    expect(planOpencodeUninstall(opts({ opencodeConfigDir: path.join(TMP, 'nope') })).present).toBe(false);
  });
});

describe('uninstall-opencode — 0.5.9 critic', () => {
  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

  it('m4: 본문에 "forgen-managed" 문자열이 있을 뿐인 사용자 plugin 은 지우지 않는다 (첫 줄 마커만 소유)', () => {
    const pluginPath = path.join(CFG, 'plugins', 'forgen.ts');
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    const mine = '// NOT forgen-managed: my fork of the forgen plugin\nexport default {};\n';
    fs.writeFileSync(pluginPath, mine);
    const r = planOpencodeUninstall(opts());
    expect(r.pluginRemoved).toBe(false);
    expect(fs.readFileSync(pluginPath, 'utf-8')).toBe(mine);
    // install 은 그것을 사용자 파일로 보고 백업한다
    expect(planOpencodeInstall(opts()).pluginBackupPath).toBe(`${pluginPath}.bak`);
    expect(fs.readFileSync(`${pluginPath}.bak`, 'utf-8')).toBe(mine);
  });

  it('m5: forgen-managed 내용의 .bak 은 "사용자 원본" 이 아니다 — 되돌리지 않는다', () => {
    const inst = planOpencodeInstall(opts());
    fs.copyFileSync(inst.pluginPath, `${inst.pluginPath}.bak`);
    const r = planOpencodeUninstall(opts());
    expect([r.pluginRemoved, r.pluginRestoredFromBackup]).toEqual([true, false]);
    expect(fs.existsSync(inst.pluginPath)).toBe(false);
  });

  it('m6: opencode.json 에 설치한 뒤 opencode.jsonc 가 생겨도 MCP 항목을 찾아 지운다', () => {
    planOpencodeInstall(opts());
    fs.writeFileSync(path.join(CFG, 'opencode.jsonc'), '{\n  // newer config\n  "theme": "dark"\n}\n');
    const r = planOpencodeUninstall(opts());
    expect(r.mcpRemoved).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(CFG, 'opencode.json'), 'utf-8')).mcp).toBeUndefined();
    expect(fs.readFileSync(path.join(CFG, 'opencode.jsonc'), 'utf-8')).toContain('// newer config');
  });

  it('m3: 중복 mcp 키처럼 편집 결과가 기대와 다르면 아무것도 쓰지 않는다 (다른 서버를 잃지 않는다)', () => {
    const forgen = { type: 'local', command: ['node', '/p/dist/mcp/server.js', '--host=opencode'], enabled: true };
    const dup = `{ "mcp": { "a": { "type": "local", "command": ["x"] } }, "mcp": { "forgen-compound": ${JSON.stringify(forgen)} } }`;
    const r = removeOpencodeMcp(dup);
    if (r.removed) {
      // 편집이 안전하게 적용된 경우: 다른 서버가 남아 있어야 한다
      expect(r.content).toContain('"a"');
    } else {
      expect(r.content).toBe(dup);
    }
    expect(r.content.includes('"a"')).toBe(true);
  });

  it('m2: 다른 키와 서버의 값은 그대로다 (인접 주석/포맷은 바뀔 수 있다)', () => {
    const before = '{\n  "theme": "dark",\n  "mcp": {\n    "first": { "type": "local", "command": ["a"] },\n    "forgen-compound": { "type": "local", "command": ["node", "/p/dist/mcp/server.js", "--host=opencode"], "enabled": true },\n    "last": { "type": "remote", "url": "https://x" }\n  },\n  "model": "m"\n}\n';
    const r = removeOpencodeMcp(before);
    expect(r.removed).toBe(true);
    expect(parseJsonc(r.content)).toEqual({ theme: 'dark', mcp: { first: { type: 'local', command: ['a'] }, last: { type: 'remote', url: 'https://x' } }, model: 'm' });
  });
});
