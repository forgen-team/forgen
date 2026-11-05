/**
 * Windows 분기: MCP 프로브 인용은 플랫폼별이고, shim 을 못 쓰는 Windows 는 shim 항목 ✗ 가 없다.
 * process.platform 만 바꿔 실제 collectProbes 를 돌린다 (설정 파일 점검 경로, 실행 프로브는 생략).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectProbes, quoteShellArg } from '../src/core/doctor-verify.js';
import { generateHooksJson } from '../src/hooks/hooks-generator.js';

const ROOT = path.resolve(__dirname, '..');
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => Object.defineProperty(process, 'platform', realPlatform));
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p, configurable: true });

describe('quoteShellArg', () => {
  it('POSIX: 단일 인용, 내부 작은따옴표는 이스케이프 — sh 가 실제로 한 인자로 읽는다', () => {
    const tricky = `a b'c$HOME "d"`;
    const q = quoteShellArg(tricky, 'linux');
    expect(q).toBe(`'a b'\\''c$HOME "d"'`);
    const r = spawnSync('sh', ['-c', `printf %s ${q}`], { encoding: 'utf-8' });
    expect(r.stdout).toBe(tricky);
  });

  it('Windows: cmd.exe 는 단일 인용을 모르므로 큰따옴표', () => {
    expect(quoteShellArg('C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe('"C:\\Program Files\\nodejs\\node.exe"');
    expect(quoteShellArg('a"b', 'win32')).toBe('"a\\"b"');
    expect(quoteShellArg('x', 'win32')).not.toContain("'");
  });
});

describe('shim 없는 Windows', () => {
  it('절대경로 설치는 shim 항목이 없고, 등록·이중·구형 항목이 전부 ✓', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-win-'));
    try {
      setPlatform('win32');
      const gen = generateHooksJson({ pluginRoot: path.join(ROOT, 'dist'), runtime: 'claude', releaseMode: true });
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: gen.hooks }));
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'forgen-compound': { command: 'node', args: [path.join(ROOT, 'dist', 'mcp', 'server.js')] } } }));
      const probes = await collectProbes({ homeDir: home, forgenHome: path.join(home, '.forgen'), pkgRoot: ROOT, skipExec: true });
      setPlatform(realPlatform.value);
      expect(probes.filter((p) => /shim/.test(p.label) && !/shim 또는 절대경로/.test(p.label))).toEqual([]);
      const hookItems = probes.filter((p) => /^settings hook 등록|^hook 이중 등록|^구형·다른 경로/.test(p.label));
      expect(hookItems).toHaveLength(3);
      for (const p of hookItems) expect(p.ok, `${p.label}: ${p.hint}`).toBe(true);
    } finally {
      setPlatform(realPlatform.value);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
