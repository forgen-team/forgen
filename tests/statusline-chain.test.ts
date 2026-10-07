/**
 * statusline 체인 — `forgen statusline --after "<cmd>"` 와 `install --chain` (오너 요청 2026-10-07).
 * Node spawn(socketpair stdin) 경로로 검증한다 — 셸 파이프만으로는 stdin 리더 회귀를 못 잡는다.
 */
import { describe, it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installStatusline, shQuote } from '../src/core/statusline-install.js';
import { parseStatuslineArgs } from '../src/core/statusline-cli.js';

const CLI = path.resolve(import.meta.dirname, '..', 'dist', 'cli.js');
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const payload = {
  session_id: 'chain-A', model: { id: 'claude-fable-5-1', display_name: 'Fable' }, workspace: { current_dir: '/' },
  context_window: { used_percentage: 42, context_window_size: 1_000_000 },
};
const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-sl-chain-'));

function run(args: string[], home: string): Promise<{ out: string; raw: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [CLI, 'statusline', ...args], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen') },
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d.toString(); });
    c.on('close', () => resolve({ out: strip(out), raw: out, ms: Date.now() - t0 }));
    c.stdin.write(JSON.stringify(payload));
    c.stdin.end();
  });
}

describe('parseStatuslineArgs', () => {
  it('--after / --forgen-lines 파싱', () => {
    expect(parseStatuslineArgs(['--after', 'echo hi', '--forgen-lines', 'all'])).toEqual({ after: 'echo hi', forgenLines: 'all' });
    expect(parseStatuslineArgs(['--after=x'])).toEqual({ after: 'x' });
    expect(parseStatuslineArgs([])).toEqual({});
  });
});

describe.skipIf(!fs.existsSync(CLI))('forgen statusline --after (Node spawn)', () => {
  it('하위 출력(ANSI 포함)을 먼저, 그 뒤 forgen 데이터 줄만 덧붙인다', async () => {
    const { out, raw } = await run(['--after', "printf '\\033[31mHUD LINE\\033[0m\\n'"], mkdir());
    const lines = out.trimEnd().split('\n');
    expect(raw.startsWith('\x1b[31mHUD LINE')).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('HUD LINE');
    expect(lines[1]).toMatch(/^forgen/);
    expect(out).not.toContain('ctx');
  });

  it('같은 JSON 이 하위 stdin 으로 전달된다', async () => {
    const { out } = await run(['--after', 'cat'], mkdir());
    expect(JSON.parse(out.split('\n')[0]).session_id).toBe('chain-A');
  });

  it('--forgen-lines all 이면 forgen 3줄 전부', async () => {
    const { out } = await run(['--after', "printf 'HUD LINE\\n'", '--forgen-lines', 'all'], mkdir());
    const lines = out.trimEnd().split('\n');
    expect(lines[0]).toBe('HUD LINE');
    expect(lines).toHaveLength(4);
    expect(out).toMatch(/ctx ▓+░* 42%\/1M/);
  });

  it('하위 명령이 타임아웃되면 forgen 전체 출력으로 폴백', async () => {
    const { out, ms } = await run(['--after', 'sleep 10; echo LATE'], mkdir());
    expect(out).not.toContain('LATE');
    expect(out).toContain('Fable');
    expect(ms).toBeLessThan(5000);
  }, 10_000);

  it('하위 명령이 실패(비0 종료)해도 하위 출력/stderr 없이 forgen 전체 출력', async () => {
    const { out } = await run(['--after', 'echo PARTIAL; echo err >&2; exit 3'], mkdir());
    expect(out).not.toContain('PARTIAL');
    expect(out).not.toContain('err');
    expect(out).toContain('Fable');
  });
});

describe('statusline install --chain', () => {
  const HUD = `bash -c '"/home/u/.bun/bin/bun" "/home/u/.claude/plugins/cache/claude-hud/claude-hud/0.1/src/index.ts"'`;
  const settingsWith = (cmd: string) => {
    const p = path.join(mkdir(), 'settings.json');
    fs.writeFileSync(p, JSON.stringify({ statusLine: { type: 'command', command: cmd } }));
    return p;
  };
  const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));

  it('커스텀을 --after 로 감싸고 원본을 statusLine_backup 에 보관, 재실행은 no-op', () => {
    const p = settingsWith(HUD);
    expect(installStatusline({ chain: true, settingsPath: p }).status).toBe('updated');
    const s = read(p);
    expect(s.statusLine_backup).toBe(HUD);
    expect(s.statusLine.command).toContain(' statusline --after ');
    const before = fs.readFileSync(p, 'utf-8');
    expect(installStatusline({ chain: true, settingsPath: p }).status).toBe('unchanged');
    expect(fs.readFileSync(p, 'utf-8')).toBe(before);
    installStatusline({ settingsPath: p }); // 일반 install 도 체인을 풀지 않는다
    expect(read(p).statusLine.command).toContain(' --after ');
  });

  it.each([
    ['claude-hud 형태(bash -c + 큰따옴표)', HUD],
    ['작은따옴표+큰따옴표+$(...)', `printf '%s\\n' "it's $(echo 'a b')" '"q"'`],
  ])('이스케이프 왕복 — %s: 체인 명령의 --after 인자가 원본과 바이트 동일', (_n, original) => {
    const p = settingsWith(original);
    installStatusline({ chain: true, settingsPath: p });
    const chained = read(p).statusLine.command as string;
    // forgen 실행부만 인자 에코 스텁으로 바꿔 sh 가 파싱한 --after 값을 그대로 받는다
    const stub = chained.replace(/^"[^"]*" "[^"]*" statusline --after /, "node -e 'process.stdout.write(process.argv[1])' -- ");
    expect(stub).not.toBe(chained);
    expect(execFileSync('sh', ['-c', stub], { encoding: 'utf-8' })).toBe(original);
  });

  it('shQuote 는 작은따옴표를 닫고 다시 연다', () => {
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it.skipIf(!fs.existsSync(CLI))('설정에 쓴 체인 명령을 sh 로 끝까지 실행하면 원본 출력 + forgen 줄', () => {
    const home = mkdir();
    const p = settingsWith(`bash -c 'echo "HUD:$(echo ok) it'"'"'s"'`);
    installStatusline({ chain: true, settingsPath: p });
    const cmd = (read(p).statusLine.command as string).replace(/"[^"]*cli\.js"/, `"${CLI}"`);
    const out = strip(execFileSync('sh', ['-c', cmd], {
      input: JSON.stringify(payload), encoding: 'utf-8',
      env: { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen') },
    }));
    const lines = out.trimEnd().split('\n');
    expect(lines[0]).toBe("HUD:ok it's");
    expect(lines[1]).toMatch(/^forgen/);
  });
});
