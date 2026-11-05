/**
 * 설치 일원화(D1) 약속을 실제 프로세스로 검증한다 — shim 실행, 대상/Node 없음, 재설치 시 settings 불변, 멱등, 사용자 설정 보존,
 * postinstall 실패 가시성, uninstall. mock 없음: 격리 HOME 에 실제로 설치하고 settings 의 명령 문자열을 `sh -c` 로 실행한다.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderForgenRunShim, writeForgenRunShim } from '../src/host/claude-shim.js';
import { applyForgenSettings, planClaudeInstall } from '../src/host/install-claude.js';
import { MIN_NODE_MAJOR, nodeEngineWarning } from '../src/core/node-engine.js';

const PKG_ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

let tmp: string;
let home: string;
const read = (p: string): string => fs.readFileSync(p, 'utf-8');
const settingsPath = (): string => path.join(home, '.claude', 'settings.json');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-install-proc-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
});
afterEach(() => {
  fs.chmodSync(home, 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 가짜 패키지: dist/<rel> 이 argv 를 JSON 으로 출력한다. */
function fakePkg(name: string, rels: string[]): string {
  const root = path.join(tmp, name);
  for (const rel of rels) {
    const f = path.join(root, 'dist', rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), ver: process.version }));\n');
  }
  return root;
}

function run(shim: string, args: string[], env: Record<string, string>) {
  return spawnSync(shim, args, { env, encoding: 'utf-8' });
}

describe('forgen-run shim — 실행', () => {
  it('baked node/패키지로 대상을 실행하고 인자를 넘긴다 (PATH 에 node 가 없어도)', () => {
    const pkg = fakePkg('pkg', ['hooks/x.js']);
    const shim = path.join(tmp, 'bin', 'forgen-run');
    expect(writeForgenRunShim(pkg, NODE, shim)).toBe('written');
    const emptyPath = fs.mkdtempSync(path.join(tmp, 'emptypath-'));
    const r = run(shim, ['hooks/x.js', 'stop', 'a b'], { PATH: emptyPath });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).argv).toEqual(['stop', 'a b']);
  });

  it('baked node 가 사라져도 PATH 의 node 로 실행한다', () => {
    const pkg = fakePkg('pkg', ['hooks/x.js']);
    const shim = path.join(tmp, 'bin', 'forgen-run');
    writeForgenRunShim(pkg, '/gone/v22/bin/node', shim);
    const pathDir = fs.mkdtempSync(path.join(tmp, 'nodepath-'));
    fs.symlinkSync(NODE, path.join(pathDir, 'node'));
    const r = run(shim, ['hooks/x.js'], { PATH: pathDir });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).ver).toBe(process.version);
  });

  it('패키지가 사라졌으면 PATH 의 forgen prefix 에서 찾는다 (nvm 버전 삭제 후 다른 버전에 설치된 경우)', () => {
    const shim = path.join(tmp, 'bin', 'forgen-run');
    writeForgenRunShim(path.join(tmp, 'deleted-v22'), NODE, shim);
    const prefix = path.join(tmp, 'v24');
    const alt = path.join(prefix, 'lib', 'node_modules', '@wooojin', 'forgen', 'dist', 'hooks');
    fs.mkdirSync(alt, { recursive: true });
    fs.copyFileSync(path.join(fakePkg('tmp-src', ['hooks/x.js']), 'dist', 'hooks', 'x.js'), path.join(alt, 'x.js'));
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(prefix, 'bin', 'forgen'), '#!/bin/sh\n', { mode: 0o755 });
    const r = run(shim, ['hooks/x.js'], { PATH: `${path.join(prefix, 'bin')}:/usr/bin:/bin` });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).argv).toEqual([]);
  });

  it('hook: 대상이 없으면 유효 JSON {continue:true,systemMessage} 를 내고 exit 0 — 재설치 명령 안내', () => {
    const shim = path.join(tmp, 'bin', 'forgen-run');
    writeForgenRunShim(path.join(tmp, 'deleted'), NODE, shim);
    const emptyPath = fs.mkdtempSync(path.join(tmp, 'emptypath-'));
    const r = run(shim, ['hooks/x.js'], { PATH: emptyPath });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.continue).toBe(true);
    expect(out.systemMessage).toContain('npm i -g @wooojin/forgen');
  });

  it('hook: node 가 어디에도 없어도 유효 JSON + exit 0', () => {
    const pkg = fakePkg('pkg', ['hooks/x.js']);
    const shim = path.join(tmp, 'bin', 'forgen-run');
    writeForgenRunShim(pkg, '/gone/node', shim);
    const emptyPath = fs.mkdtempSync(path.join(tmp, 'emptypath-'));
    const r = run(shim, ['hooks/x.js'], { PATH: emptyPath });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).continue).toBe(true);
  });

  it('MCP: 대상이 없으면 stdout 은 비우고(프로토콜 보호) stderr 안내 + 비0 종료', () => {
    const shim = path.join(tmp, 'bin', 'forgen-run');
    writeForgenRunShim(path.join(tmp, 'deleted'), NODE, shim);
    const emptyPath = fs.mkdtempSync(path.join(tmp, 'emptypath-'));
    const r = run(shim, ['mcp/server.js'], { PATH: emptyPath });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('npm i -g @wooojin/forgen');
  });

  it('statusLine: 대상이 없으면 한 줄 안내를 내고 exit 0', () => {
    const shim = path.join(tmp, 'bin', 'forgen-run');
    writeForgenRunShim(path.join(tmp, 'deleted'), NODE, shim);
    const r = run(shim, ['cli.js', 'statusline'], { PATH: fs.mkdtempSync(path.join(tmp, 'emptypath-')) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Reinstall');
  });

  it('사용자 파일(마커 없음)이 있는 경로는 덮어쓰지 않는다', () => {
    const shim = path.join(tmp, 'bin', 'forgen-run');
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, '#!/bin/sh\necho mine\n');
    expect(writeForgenRunShim(PKG_ROOT, NODE, shim)).toBe('foreign');
    expect(read(shim)).toContain('echo mine');
  });

  it('FORGEN_HOME 이 있으면 shim 이 그 아래에 놓인다', () => {
    const fh = path.join(tmp, 'fh');
    const prev = process.env.FORGEN_HOME;
    process.env.FORGEN_HOME = fh;
    try {
      const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: home });
      expect(r.shimPath).toBe(path.join(fh, 'bin', 'forgen-run'));
      expect(fs.existsSync(r.shimPath as string)).toBe(true);
      expect(fs.existsSync(path.join(home, '.forgen', 'bin'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.FORGEN_HOME; else process.env.FORGEN_HOME = prev;
    }
  });
});

describe('설치 — settings 의 명령이 실제로 실행된다', () => {
  it('23개 hook 명령 전부를 sh -c 로 실행: PATH 에 node 가 없어도 exit 0', () => {
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: home });
    expect(r.errors).toEqual([]);
    const settings = JSON.parse(read(settingsPath()));
    const commands = Object.values(settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
      .flat().flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toHaveLength(23);
    const emptyPath = fs.mkdtempSync(path.join(tmp, 'emptypath-'));
    const cwd = path.join(tmp, 'proj');
    fs.mkdirSync(cwd);
    const bad: string[] = [];
    for (const cmd of commands) {
      const p = spawnSync('/bin/sh', ['-c', cmd], {
        input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's', cwd, prompt: 'hi', tool_name: 'Bash', tool_input: {} }),
        env: { PATH: emptyPath, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), FORGEN_TEST_NO_NETWORK: '1' },
        cwd, encoding: 'utf-8', timeout: 20000,
      });
      if (p.status !== 0) bad.push(`${cmd} -> rc ${p.status} ${String(p.stderr).slice(0, 200)}`);
    }
    expect(bad).toEqual([]);
  }, 120000);

  it('MCP 항목이 shim 을 가리키고 실제 서버가 기동해 initialize 에 응답한다', () => {
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: home });
    const entry = JSON.parse(read(path.join(home, '.claude.json'))).mcpServers['forgen-compound'];
    expect(entry).toEqual({ command: r.shimPath, args: ['mcp/server.js'] });
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const p = spawnSync(entry.command, entry.args, {
      input: `${init}\n`, env: { PATH: fs.mkdtempSync(path.join(tmp, 'emptypath-')), HOME: home, FORGEN_HOME: path.join(home, '.forgen') },
      encoding: 'utf-8', timeout: 15000,
    });
    expect(p.stdout).toContain('"result"');
    expect(p.stdout).toContain('forgen');
  }, 30000);
});

describe('설치 — 재설치·멱등·보존', () => {
  function copyPkg(name: string): string {
    const root = path.join(tmp, name);
    fs.mkdirSync(root, { recursive: true });
    for (const e of ['dist', 'assets', 'package.json']) fs.symlinkSync(path.join(PKG_ROOT, e), path.join(root, e));
    return root;
  }

  it('Node·패키지 위치가 바뀐 재설치는 shim 내용만 바꾸고 settings.json·.claude.json 바이트는 그대로', () => {
    const a = copyPkg('pkg-a');
    const b = copyPkg('pkg-b');
    planClaudeInstall({ pkgRoot: a, homeDir: home });
    const shimPath = path.join(home, '.forgen', 'bin', 'forgen-run');
    const shim1 = read(shimPath);
    const s1 = read(settingsPath());
    const j1 = read(path.join(home, '.claude.json'));
    // 다른 node 경로로 재설치한 것과 같은 효과: 같은 shim 경로에 다른 node·패키지를 굽는다
    expect(writeForgenRunShim(b, '/other/v24/bin/node', shimPath)).toBe('written');
    planClaudeInstall({ pkgRoot: b, homeDir: home });
    expect(read(shimPath)).not.toBe(shim1);
    expect(read(shimPath)).toContain(b);
    expect(read(settingsPath())).toBe(s1);
    expect(read(path.join(home, '.claude.json'))).toBe(j1);
  });

  it('2회 설치해도 hook 23개·MCP 1개 그대로(중복 없음), 파일 바이트 불변', () => {
    planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: home });
    const s1 = read(settingsPath());
    const r2 = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: home });
    expect(read(settingsPath())).toBe(s1);
    expect(r2.hooksInjected).toBe(23);
    expect(r2.mcpAlreadyPresent).toBe(true);
    expect(r2.statusLine).toBe('unchanged');
  });

  it('사용자 hook·statusLine·MCP·권한·env 는 보존하고, 구형 절대경로 forgen 항목은 교체하며, 플러그인·래퍼 env 잔재를 지운다', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({
      permissions: { allow: ['Bash(ls)'] },
      env: { MY_VAR: '1', FORGEN_CWD: '/old/project', FORGEN_V1: '1', COMPOUND_HARNESS: '1' },
      enabledPlugins: { 'forgen@forgen-local': true, 'omc@x': true },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] },
          { matcher: '*', hooks: [{ type: 'command', command: `node "/old/nvm/v22/lib/node_modules/@wooojin/forgen/dist/hooks/pre-tool-use.js"`, timeout: 3 }] },
          { matcher: '*', hooks: [{ type: 'command', command: 'node "/x/omc/dist/hooks/pre-tool-use.js"' }] },
        ],
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/stop-guard.js"' }, { type: 'command', command: 'my-stop.sh' }] }],
      },
    }));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { a: 1 }, mcpServers: { mine: { command: 'x', args: [] }, 'forgen-compound': { command: 'node', args: ['/old/dist/mcp/server.js'] } } }));
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: home });
    expect(r.errors).toEqual([]);
    const s = JSON.parse(read(settingsPath()));
    expect(s.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(s.env).toEqual({ MY_VAR: '1' });
    expect(s.enabledPlugins).toEqual({ 'omc@x': true });
    const pre = s.hooks.PreToolUse.flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks.map((h) => h.command));
    expect(pre).toContain('my-guard.sh');
    expect(pre).toContain('node "/x/omc/dist/hooks/pre-tool-use.js"'); // forgen 이 아닌 dist/hooks 는 건드리지 않는다
    expect(pre.filter((c: string) => c.includes('/old/nvm'))).toEqual([]);
    expect(pre.filter((c: string) => c.includes('forgen-run')).length).toBeGreaterThanOrEqual(2);
    const stop = s.hooks.Stop.flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks.map((h) => h.command));
    expect(stop).toContain('my-stop.sh'); // forgen 이 아닌 hook 은 같은 그룹에 있어도 보존
    expect(stop.some((c: string) => c.includes('CLAUDE_PLUGIN_ROOT'))).toBe(false);
    const j = JSON.parse(read(path.join(home, '.claude.json')));
    expect(j.projects).toEqual({ a: 1 });
    expect(j.mcpServers.mine).toEqual({ command: 'x', args: [] });
    expect(j.mcpServers['forgen-compound'].args).toEqual(['mcp/server.js']);
  });

  it('구형 절대경로 statusLine 은 shim 으로 교체, 커스텀(claude-hud)은 그대로, 체인은 --after 보존', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ statusLine: { type: 'command', command: '"/old/node" "/old/dist/cli.js" statusline' } }));
    planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: home });
    expect(JSON.parse(read(settingsPath())).statusLine.command).toMatch(/forgen-run" "cli\.js" statusline$/);

    const custom = { type: 'command', command: 'node ~/.claude/hud.js' };
    fs.writeFileSync(settingsPath(), JSON.stringify({ statusLine: custom }));
    expect(planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: home }).statusLine).toBe('custom');
    expect(JSON.parse(read(settingsPath())).statusLine).toEqual(custom);

    fs.writeFileSync(settingsPath(), JSON.stringify({ statusLine: { type: 'command', command: `"/old/node" "/old/dist/cli.js" statusline --after 'node hud.js'` } }));
    planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: home });
    expect(JSON.parse(read(settingsPath())).statusLine.command).toMatch(/forgen-run" "cli\.js" statusline --after 'node hud\.js'$/);
  });

  it('shim 을 못 쓰는 환경(Windows 등)은 기존 절대경로 hook 을 유지한다', () => {
    const settings: Record<string, unknown> = {};
    applyForgenSettings(settings, PKG_ROOT, null);
    const cmds = Object.values(settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).flat().flatMap((g) => g.hooks.map((h) => h.command));
    expect(cmds).toHaveLength(23);
    expect(cmds.every((c) => c.startsWith('node "') && c.includes(path.join(PKG_ROOT, 'dist', 'hooks')))).toBe(true);
  });

  it('손상된 settings.json 은 덮어쓰지 않고 사유를 돌려준다', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), '{broken');
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: home });
    expect(read(settingsPath())).toBe('{broken');
    expect(r.errors.join('\n')).toMatch(/settings\.json.*failed to parse/);
    expect(fs.readdirSync(path.join(home, '.claude')).some((f) => f.includes('.corrupt-'))).toBe(true);
  });

  it('전역 ch-* agents: 설치, forgen 표식 있는 것만 갱신·정리, 사용자 파일 보존', () => {
    const agents = path.join(home, '.claude', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'ch-planner.md'), '---\nname: ch-planner\n---\nmy own planner');
    fs.writeFileSync(path.join(agents, 'ch-old-stale.md'), '---\nname: x\n---\n\n<!-- forgen-managed -->\nstale');
    fs.writeFileSync(path.join(agents, 'ch-mine-stale.md'), 'user file without marker');
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: home });
    expect(r.agentsInstalled).toBeGreaterThan(5);
    expect(read(path.join(agents, 'ch-planner.md'))).toContain('my own planner');
    expect(fs.existsSync(path.join(agents, 'ch-executor.md'))).toBe(true);
    expect(read(path.join(agents, 'ch-executor.md'))).toContain('<!-- forgen-managed -->');
    expect(fs.existsSync(path.join(agents, 'ch-old-stale.md'))).toBe(false);
    expect(read(path.join(agents, 'ch-mine-stale.md'))).toBe('user file without marker');
    expect(planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: home }).agentsInstalled).toBe(0);
  });
});

describe('postinstall — 한 번에 설치, 실패는 보인다', () => {
  const postinstall = (env: Record<string, string>) =>
    spawnSync(NODE, [path.join(PKG_ROOT, 'scripts', 'postinstall.js')], {
      env: { ...process.env, ...env, HOME: home, npm_config_global: 'true', FORGEN_HOME: '', CODEX_HOME: '' }, encoding: 'utf-8',
    });

  it('빈 HOME 에서 hook·MCP·statusLine·commands·skills·verify·agents 가 모두 설치된다', () => {
    const r = postinstall({});
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/incomplete/);
    const s = JSON.parse(read(settingsPath()));
    expect(Object.values(s.hooks as Record<string, unknown[]>).flat()).not.toHaveLength(0);
    expect(s.statusLine.command).toContain('forgen-run');
    expect(JSON.parse(read(path.join(home, '.claude.json'))).mcpServers['forgen-compound']).toBeDefined();
    expect(fs.readdirSync(path.join(home, '.claude', 'commands', 'forgen')).length).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(home, '.claude', 'skills')).filter((n) => n.startsWith('forgen-')).length).toBe(14);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'verify', 'SKILL.md'))).toBe(true);
    expect(fs.readdirSync(path.join(home, '.claude', 'agents')).filter((n) => n.startsWith('ch-')).length).toBeGreaterThan(5);
  });

  it('읽기 전용 settings.json: 출력 0바이트로 끝나지 않고 사유를 말한다 (exit 0 — 패키지 설치는 성공)', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), '{}');
    fs.chmodSync(path.join(home, '.claude'), 0o555);
    try {
      const r = postinstall({});
      expect(r.status).toBe(0);
      expect(r.stderr.length).toBeGreaterThan(0);
      expect(r.stderr).toMatch(/incomplete/);
      expect(r.stderr).toMatch(/settings\.json|EACCES|permission/i);
    } finally {
      fs.chmodSync(path.join(home, '.claude'), 0o755);
    }
  });

  it('읽기 전용(chmod 444)으로 잠근 settings.json 은 교체하지 않고 사유를 말한다', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), '{"model":"opus"}');
    fs.chmodSync(settingsPath(), 0o444);
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: home });
    expect(read(settingsPath())).toBe('{"model":"opus"}');
    expect(r.errors.join('\n')).toMatch(/settings\.json.*read-only/);
  });

  it('HOME 쓰기 불가: 사유를 출력하고 exit 0', () => {
    fs.chmodSync(home, 0o555);
    const r = postinstall({});
    expect(r.status).toBe(0);
    expect(r.stderr + r.stdout).toMatch(/incomplete|warning/i);
  });
});

describe('uninstall', () => {
  it('shim·agents·구형 절대경로 statusLine·전역 rules 잔재를 지우고 사용자 설정은 보존', () => {
    planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: home });
    const agents = path.join(home, '.claude', 'agents');
    fs.writeFileSync(path.join(agents, 'ch-mine.md'), 'my agent');
    const rules = path.join(home, '.claude', 'rules');
    fs.mkdirSync(rules, { recursive: true });
    fs.writeFileSync(path.join(rules, 'v1-rules.md'), '# Forgen v1 — Rendered Rules\n- x');
    fs.writeFileSync(path.join(rules, 'mine.md'), 'my rule');
    const s = JSON.parse(read(settingsPath()));
    s.statusLine = { type: 'command', command: '"/old/node" "/old/dist/cli.js" statusline' };
    s.permissions = { allow: ['Bash(ls)'] };
    s.hooks.Stop.push({ matcher: '*', hooks: [{ type: 'command', command: 'my-stop.sh' }] });
    fs.writeFileSync(settingsPath(), JSON.stringify(s));
    const j = JSON.parse(read(path.join(home, '.claude.json')));
    j.mcpServers.mine = { command: 'x', args: [] };
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(j));

    const cwd = path.join(tmp, 'proj');
    fs.mkdirSync(cwd);
    const r = spawnSync(NODE, [path.join(PKG_ROOT, 'dist', 'cli.js'), 'uninstall', '--force'], {
      cwd, env: { ...process.env, HOME: home, FORGEN_HOME: '', CODEX_HOME: path.join(home, '.codex') }, encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(home, '.forgen', 'bin', 'forgen-run'))).toBe(false);
    expect(fs.readdirSync(agents)).toEqual(['ch-mine.md']);
    const after = JSON.parse(read(settingsPath()));
    expect(after.statusLine).toBeUndefined();
    expect(after.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(JSON.stringify(after.hooks)).not.toContain('forgen-run');
    expect(JSON.stringify(after.hooks)).toContain('my-stop.sh');
    const jAfter = JSON.parse(read(path.join(home, '.claude.json')));
    expect(Object.keys(jAfter.mcpServers)).toEqual(['mine']);
    expect(fs.existsSync(path.join(rules, 'v1-rules.md'))).toBe(false);
    expect(read(path.join(rules, 'mine.md'))).toBe('my rule');
  }, 60000);
});

describe('Node 엔진 경고', () => {
  it('MIN_NODE_MAJOR 는 package.json engines 와 같고, 미달이면 경고·충족이면 없음', () => {
    const engines = JSON.parse(read(path.join(PKG_ROOT, 'package.json'))).engines.node as string;
    expect(engines).toBe(`>=${MIN_NODE_MAJOR}.0.0`);
    expect(nodeEngineWarning('20.19.0')).toMatch(/Node 20\.19\.0 is below/);
    expect(nodeEngineWarning('22.1.0')).toBeNull();
    expect(read(path.join(PKG_ROOT, 'scripts', 'postinstall.js'))).toContain(`MIN_NODE_MAJOR = ${MIN_NODE_MAJOR}`);
  });

  it('shim 내용은 렌더 결과가 결정적이다', () => {
    expect(renderForgenRunShim('/p', '/n')).toBe(renderForgenRunShim('/p', '/n'));
  });
});

describe('다른 도구의 hook 을 건드리지 않는다', () => {
  const pkg = '/x/node_modules/@wooojin/forgen';
  it('소유 판정: forgen hook 만 true', async () => {
    const { isForgenHookCommand: own } = await import('../src/host/install-claude.js');
    expect(own('"/h/.forgen/bin/forgen-run" "hooks/stop-guard.js"', pkg)).toBe(true);
    expect(own('node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/stop-guard.js"', pkg)).toBe(true);
    expect(own(`node "${pkg}/dist/hooks/pre-tool-use.js"`, pkg)).toBe(true);
    expect(own('node "${CLAUDE_PLUGIN_ROOT}/scripts/notify.js"', pkg)).toBe(false);
    expect(own('node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/other-tool.js"', pkg)).toBe(false);
    expect(own('/home/forgen-dev/bin/my-forgen-notify', pkg)).toBe(false);
    expect(own('node /home/forgen-dev/other/dist/hooks/custom.js', pkg)).toBe(false);
  });
  it('같은 그룹의 사용자 hook 은 남는다', async () => {
    const { removeForgenHooks } = await import('../src/host/install-claude.js');
    const hooks: Record<string, unknown[]> = {
      Stop: [{ hooks: [{ type: 'command', command: `node "${pkg}/dist/hooks/stop-guard.js"` }, { type: 'command', command: 'my-forgen-notify' }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: `node "${pkg}/dist/hooks/pre-tool-use.js"` }] }],
    };
    removeForgenHooks(hooks, pkg);
    expect(hooks.PreToolUse).toBeUndefined();
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'my-forgen-notify' }] }]);
  });
  it('sh 가 확장하는 문자를 이스케이프한다', async () => {
    const { quoteArg } = await import('../src/hooks/hooks-generator.js');
    const r = spawnSync('sh', ['-c', `printf %s ${quoteArg('a b$HOME`x`"\\c')}`], { encoding: 'utf-8' });
    expect(r.stdout).toBe('a b$HOME`x`"\\c');
  });
});

describe('postinstall 이 개발자 실제 홈을 바꾸지 않는다', () => {
  const run = (env: Record<string, string>) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-guard-'));
    const root = path.resolve(__dirname, '..');
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'postinstall.js')], {
      encoding: 'utf-8', cwd: root,
      env: { ...process.env, HOME: home, INIT_CWD: root, FORGEN_FORCE_POSTINSTALL: '', npm_config_global: '', ...env },
    });
    const wrote = fs.existsSync(path.join(home, '.claude', 'settings.json'));
    fs.rmSync(home, { recursive: true, force: true });
    return { wrote, stdout: r.stdout };
  };
  it('저장소 체크아웃이면 쓰지 않고 안내한다', () => {
    const r = run({});
    expect(r.wrote).toBe(false);
    expect(r.stdout).toContain('forgen install claude');
  });
  it('SKIP 이면 강제해도 쓰지 않는다', () => {
    expect(run({ FORGEN_FORCE_POSTINSTALL: '1', FORGEN_SKIP_POSTINSTALL: '1' }).wrote).toBe(false);
  });
});
