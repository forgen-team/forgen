/**
 * doctor 변이 시험 (D8, F-01). mock 없음.
 * 격리 HOME 에 실제로 설치한 뒤 대상을 실제로 부수고, doctor 가 ✗ 와 exit 1 을 내는지 확인한다.
 * 12종 동시 파손(F-01 재현)과, 기본 설치가 깨끗하게 통과하는 대조군을 포함한다.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOOK_REGISTRY } from '../src/hooks/hook-registry.js';

const ROOT = path.resolve(__dirname, '..');
/** 등록되는 hook 총수 — 하드코딩하지 않고 레지스트리에서 읽는다. */
const N = HOOK_REGISTRY.length;
const N_STOP = HOOK_REGISTRY.filter((h) => h.event === 'Stop').length;
const IS_ROOT = process.getuid?.() === 0;
const CLI = path.join(ROOT, 'dist', 'cli.js');

let BIN: string; // 가짜 claude 실행 파일만 둔 PATH 디렉터리 (claude CLI 존재 확인용)
let counter = 0;

function envFor(home: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), CODEX_HOME: path.join(home, '.codex'), PATH: `${BIN}:${process.env.PATH}`, FORGEN_FORCE_POSTINSTALL: '' };
  for (const k of Object.keys(env)) if (/^(TMUX|FORGEN_(SESSION_ID|NESTED_RUN|CWD|HARNESS)|CLAUDE_.*)/.test(k)) delete env[k];
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

function run(home: string, args: string[], extra: Record<string, string | undefined> = {}): Promise<{ rc: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn('node', [CLI, ...args], { env: envFor(home, extra), cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (rc) => resolve({ rc, out }));
  });
}

/** 설치 + 정상 데이터(프로필·룰·솔루션) 까지 갖춘 격리 홈 */
async function freshHome(): Promise<string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `doctor-mut-${++counter}-`));
  const inst = await run(home, ['install', 'claude']);
  if (inst.rc !== 0) throw new Error(`install failed: ${inst.out}`);
  const fh = path.join(home, '.forgen');
  for (const d of ['me/solutions', 'me/behavior', 'me/rules', 'sessions', 'state/sessions']) fs.mkdirSync(path.join(fh, d), { recursive: true });
  fs.writeFileSync(path.join(fh, 'me', 'forge-profile.json'), JSON.stringify({ version: 1 }));
  fs.writeFileSync(path.join(fh, 'config.json'), JSON.stringify({ autoCompoundHaiku: false }));
  const now = new Date().toISOString();
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(fh, 'me', 'rules', `r${i}.json`), JSON.stringify({ rule_id: `r${i}`, status: 'active', strength: 'default', category: 'workflow', policy: 'p', trigger: 't', created_at: now }));
  }
  fs.writeFileSync(path.join(fh, 'me', 'solutions', 's1.md'), `---\nname: s1\ncreated: ${now}\n---\nbody\n`);
  return home;
}

const S = (h: string) => path.join(h, '.claude', 'settings.json');
const readJ = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const writeJ = (p: string, o: unknown) => fs.writeFileSync(p, JSON.stringify(o, null, 2));
const shimOf = (h: string) => path.join(h, '.forgen', 'bin', 'forgen-run');

/** 설치된 shim 이 가리키는 패키지를 "있지만 부서진" 가짜 패키지로 바꾼다 (hook·MCP·statusLine 이 실제로 실행되며 실패). */
function pointShimAtCrashingPackage(h: string): void {
  const pkg = path.join(h, 'crashing-pkg');
  for (const f of ['cli.js', 'hooks/a.js', 'mcp/server.js']) {
    fs.mkdirSync(path.dirname(path.join(pkg, 'dist', f)), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'dist', f), 'process.stderr.write("boom\\n"); process.exit(1);\n');
  }
  // 설치된 hook 스크립트 이름마다 같은 부서진 스크립트를 둔다
  const settings = readJ(S(h));
  for (const groups of Object.values(settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)) {
    for (const g of groups) for (const hk of g.hooks) {
      const rel = hk.command.match(/"(hooks\/[^"]+\.js)"/)?.[1];
      if (rel) { fs.mkdirSync(path.dirname(path.join(pkg, 'dist', rel)), { recursive: true }); fs.writeFileSync(path.join(pkg, 'dist', rel), 'process.exit(1);\n'); }
    }
  }
  const shim = fs.readFileSync(shimOf(h), 'utf-8').replace(/^FORGEN_PKG='.*'$/m, `FORGEN_PKG='${pkg}'`);
  fs.writeFileSync(shimOf(h), shim);
}

interface Mutation { name: string; apply: (h: string) => void; expect: RegExp | RegExp[]; /** root 는 chmod 000 을 무시한다 */ skip?: boolean }
const expectAll = (out: string, e: RegExp | RegExp[]) => { for (const r of Array.isArray(e) ? e : [e]) expect(out, `${r} 가 출력에 없음\n${out}`).toMatch(r); };
const sethooks = (h: string, f: (s: Record<string, any>) => void) => { const s = readJ(S(h)); f(s); writeJ(S(h), s); };
const corruptAll = (dir: string, ext: string) => { for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(ext))) fs.writeFileSync(path.join(dir, f), '{broken\0'); };

const MUTATIONS: Mutation[] = [
  { name: 'settings hooks 전부 삭제', apply: (h) => sethooks(h, (s) => { s.hooks = {}; }), expect: new RegExp(`✗ settings hook 등록 0/${N}\\b`) },
  { name: 'Stop hook 만 삭제', apply: (h) => sethooks(h, (s) => { delete s.hooks.Stop; }), expect: new RegExp(`✗ settings hook 등록 ${N - N_STOP}/${N}\\b`) },
  { name: 'hook 경로 오타', apply: (h) => fs.writeFileSync(S(h), fs.readFileSync(S(h), 'utf-8').replaceAll('"hooks/', '"hookz/')), expect: [new RegExp(`✗ settings hook 등록 0/${N}\\b`), new RegExp(`✗ hook 실행 0/${N}\\b`)] },
  { name: 'hook 이중 등록', apply: (h) => sethooks(h, (s) => { for (const k of Object.keys(s.hooks)) s.hooks[k] = [...s.hooks[k], ...s.hooks[k]]; }), expect: /✗ hook 이중 등록 없음/ },
  { name: '구버전 절대경로 hook', apply: (h) => fs.writeFileSync(S(h), fs.readFileSync(S(h), 'utf-8').replaceAll(shimOf(h), '/opt/forgen-OLD/dist/hooks/x.js')), expect: new RegExp(`✗ settings hook 등록 0/${N}\\b`) },
  { name: 'disableAllHooks', apply: (h) => sethooks(h, (s) => { s.disableAllHooks = true; }), expect: /✗ disableAllHooks 꺼짐/ },
  { name: 'settings.json 깨짐', apply: (h) => fs.writeFileSync(S(h), '{"hooks": {oops'), expect: /✗ settings\.json 읽기/ },
  { name: 'settings.json 삭제', apply: (h) => fs.rmSync(S(h)), expect: /✗ settings\.json 읽기/ },
  { name: 'shim 삭제', apply: (h) => fs.rmSync(shimOf(h)), expect: /✗ hook\/MCP shim/ },
  { name: 'shim 이 가리키는 패키지 삭제', apply: (h) => fs.writeFileSync(shimOf(h), fs.readFileSync(shimOf(h), 'utf-8').replace(/^FORGEN_PKG='.*'$/m, "FORGEN_PKG='/nonexistent/pkg'")), expect: /✗ hook\/MCP shim/ },
  { name: '대상은 있으나 hook·MCP·statusLine 이 죽음', apply: pointShimAtCrashingPackage, expect: new RegExp(`✗ hook 실행 0/${N}\\b`) },
  { name: 'MCP 대상 부서짐', apply: pointShimAtCrashingPackage, expect: /✗ MCP forgen-compound initialize/ },
  { name: 'statusLine 대상 부서짐', apply: pointShimAtCrashingPackage, expect: /✗ statusLine 실행/ },
  { name: 'MCP 인자 경로 오타', apply: (h) => fs.writeFileSync(path.join(h, '.claude.json'), fs.readFileSync(path.join(h, '.claude.json'), 'utf-8').replace('mcp/server.js', 'mcp/serverX.js')), expect: /✗ MCP forgen-compound initialize/ },
  { name: 'MCP 등록 삭제', apply: (h) => writeJ(path.join(h, '.claude.json'), {}), expect: /✗ MCP forgen-compound 등록/ },
  { name: '.claude.json 깨짐', apply: (h) => fs.writeFileSync(path.join(h, '.claude.json'), '{bad'), expect: /✗ ~\/\.claude\.json 읽기/ },
  { name: 'statusLine 경로 오타', apply: (h) => fs.writeFileSync(S(h), fs.readFileSync(S(h), 'utf-8').replace('cli.js\\" statusline', 'cliX.js\\" statusline')), expect: /✗ statusLine 실행/ },
  { name: '프로필 깨짐', apply: (h) => fs.writeFileSync(path.join(h, '.forgen/me/forge-profile.json'), '{x'), expect: /✗ Profile 파싱/ },
  { name: 'config.json 깨짐', apply: (h) => fs.writeFileSync(path.join(h, '.forgen/config.json'), '{x'), expect: /✗ config\.json 파싱/ },
  { name: 'hook-config.json 깨짐', apply: (h) => fs.writeFileSync(path.join(h, '.forgen/hook-config.json'), '{x'), expect: /✗ hook-config\.json 파싱/ },
  { name: 'sessions.db 쓰레기', apply: (h) => fs.writeFileSync(path.join(h, '.forgen/sessions.db'), Buffer.from('garbage'.repeat(100))), expect: /✗ sessions\.db 열기/ },
  { name: '룰 1개 깨짐', apply: (h) => fs.writeFileSync(path.join(h, '.forgen/me/rules/r0.json'), '{broken'), expect: /✗ 룰 파일 3개 파싱 \(깨진 1개\)/ },
  { name: '룰 전부 깨짐', apply: (h) => corruptAll(path.join(h, '.forgen/me/rules'), '.json'), expect: /✗ 룰 파일 3개 파싱 \(깨진 3개\)/ },
  { name: '룰 디렉터리 권한 000', apply: (h) => fs.chmodSync(path.join(h, '.forgen/me/rules'), 0), expect: /✗ 룰 디렉터리 읽기/, skip: IS_ROOT },
  { name: '솔루션 frontmatter 깨짐', apply: (h) => fs.writeFileSync(path.join(h, '.forgen/me/solutions/s1.md'), 'not frontmatter \0'), expect: /✗ 솔루션 1개 frontmatter/ },
  { name: '슬래시 명령 삭제', apply: (h) => fs.rmSync(path.join(h, '.claude/commands/forgen'), { recursive: true }), expect: /✗ 슬래시 명령 설치/ },
  { name: '스킬 삭제', apply: (h) => fs.rmSync(path.join(h, '.claude/skills'), { recursive: true }), expect: /✗ forgen 스킬 설치/ },
  { name: '끊긴 심링크', apply: (h) => fs.symlinkSync('/nonexistent/skill', path.join(h, '.claude/skills/forgen-dangling')), expect: /✗ 끊긴 심링크 없음/ },
  { name: 'hook 오류 폭주', apply: (h) => fs.appendFileSync(path.join(h, '.forgen/state/hook-errors.jsonl'), Array.from({ length: 50 }, () => JSON.stringify({ hook: 'stop-guard', error: 'boom', timestamp: new Date().toISOString() })).join('\n') + '\n'), expect: /✗ 최근 24h hook 오류/ },
  { name: '~/.forgen 이 끊긴 심링크', apply: (h) => { fs.rmSync(path.join(h, '.forgen'), { recursive: true }); fs.symlinkSync('/nonexistent/forgen', path.join(h, '.forgen')); }, expect: /✗ ~\/\.forgen\// },
];

beforeAll(() => {
  BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-mut-bin-'));
  fs.writeFileSync(path.join(BIN, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
});

describe('doctor 변이 시험 — 대조군', () => {
  it('정상 설치는 ✗ 없이 통과하고 exit 0', async () => {
    const h = await freshHome();
    const { rc, out } = await run(h, ['doctor']);
    expect(out).not.toMatch(/✗/);
    expect(out).toMatch(new RegExp(`hook 실행 ${N}/${N} `));
    expect(out).toMatch(/MCP forgen-compound initialize 왕복/);
    expect(rc).toBe(0);
  }, 120_000);

  it('statusLine·플러그인·tmux 부재는 ✓ 로 표시되지 않고 실패로도 세지 않는 정보 줄이다', async () => {
    const h = await freshHome();
    const { out } = await run(h, ['doctor']);
    expect(out).toMatch(/△ ralph-loop 플러그인 없음/);
    expect(out).toMatch(/△ tmux:/);
  }, 120_000);
});

describe('doctor 변이 시험 — 하나씩 부수면 ✗ 와 exit 1', () => {
  for (const m of MUTATIONS) {
    it.skipIf(!!m.skip)(m.name, async () => {
      const h = await freshHome();
      m.apply(h);
      const { rc, out } = await run(h, ['doctor']);
      try { fs.chmodSync(path.join(h, '.forgen/me/rules'), 0o755); } catch { /* ignore */ }
      expectAll(out, m.expect);
      expect(rc).toBe(1);
    }, 120_000);
  }
});

describe('F-01 — 12종 동시 파손', () => {
  it('각각을 따로 짚고 exit 1', async () => {
    const h = await freshHome();
    const pick = (n: string) => MUTATIONS.find((m) => m.name === n)!;
    const names = ['settings hooks 전부 삭제', 'MCP 등록 삭제', '프로필 깨짐', 'config.json 깨짐', 'sessions.db 쓰레기', '룰 전부 깨짐',
      'statusLine 경로 오타', '슬래시 명령 삭제', '스킬 삭제', 'hook 오류 폭주', '솔루션 frontmatter 깨짐', '구버전 절대경로 hook'];
    // 12번째는 hooks 삭제 뒤에 의미가 없으므로 hook-config.json 깨짐으로 대체
    names[names.length - 1] = 'hook-config.json 깨짐';
    expect(names).toHaveLength(12);
    for (const n of names) pick(n).apply(h);
    const { rc, out } = await run(h, ['doctor']);
    const failed = out.split('\n').filter((l) => /^\s+✗/.test(l));
    for (const n of names) expectAll(out, pick(n).expect);
    expect(failed.length).toBeGreaterThanOrEqual(12);
    expect(rc).toBe(1);
  }, 180_000);
});

describe('doctor --repair — 재설치 경로로 고치고 재검증', () => {
  const REPAIRABLE = ['settings hooks 전부 삭제', 'hook 이중 등록', 'MCP 등록 삭제', 'MCP 인자 경로 오타', '슬래시 명령 삭제', 'shim 삭제'];
  for (const name of REPAIRABLE.filter((n) => MUTATIONS.some((m) => m.name === n))) {
    it(`${name} → repair 후 통과`, async () => {
      const h = await freshHome();
      MUTATIONS.find((m) => m.name === name)!.apply(h);
      const before = await run(h, ['doctor']);
      expect(before.rc).toBe(1);
      const repaired = await run(h, ['doctor', '--repair']);
      expect(repaired.out).toMatch(/\[Repair\] ✓ 복구 확인/);
      expect(repaired.rc).toBe(0);
      const after = await run(h, ['doctor']);
      expect(after.rc).toBe(0);
    }, 180_000);
  }

  it('데이터 파손(프로필)은 재설치로 못 고치므로 정직하게 남는다', async () => {
    const h = await freshHome();
    MUTATIONS.find((m) => m.name === '프로필 깨짐')!.apply(h);
    const r = await run(h, ['doctor', '--repair']);
    expect(r.out).toMatch(/\[Repair\] ✗ 재검증 후에도/);
    expect(r.rc).toBe(1);
  }, 120_000);
});

/** 설치만 한 갓 설치 상태 (프로필·룰·세션 폴더 없음) */
async function installOnlyHome(): Promise<string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `doctor-fresh-${++counter}-`));
  const inst = await run(home, ['install', 'claude']);
  if (inst.rc !== 0) throw new Error(`install failed: ${inst.out}`);
  return home;
}
const noX = (out: string) => out.split('\n').filter((l) => /^\s+✗/.test(l) && !/check\(s\) failed/.test(l));

describe('정상 상태는 ✗ 도 exit 1 도 아니다', () => {
  it('갓 설치(첫 세션 전): 프로필·폴더 없음은 △ 정보이고 exit 0', async () => {
    const h = await installOnlyHome();
    const { rc, out } = await run(h, ['doctor']);
    expect(noX(out), out).toEqual([]);
    expect(out).toMatch(/△ 프로필 없음 \(me\/forge-profile\.json\) — 룰은 동작함. forgen 으로 온보딩하면 4축 프로필을 사용/);
    expect(out).toMatch(/△ ~\/\.forgen\/state\/sessions\/ \(v1 effective state\) 아직 없음/);
    expect(out).toMatch(/△ ~\/\.forgen\/sessions\/ \(session logs\) 아직 없음/);
    expect(rc).toBe(0);
  }, 120_000);

  it('프로필 삭제는 △ 이고 exit 0', async () => {
    const h = await freshHome();
    fs.rmSync(path.join(h, '.forgen/me/forge-profile.json'));
    const { rc, out } = await run(h, ['doctor']);
    expect(out).toMatch(/△ 프로필 없음/);
    expect(noX(out), out).toEqual([]);
    expect(rc).toBe(0);
  }, 120_000);

  it('Codex 전용: ~/.claude 없음 + Codex hook 설치 → Claude 항목 ✗ 없음, exit 0', async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), `doctor-codex-${++counter}-`));
    const inst = await run(h, ['install', 'codex']);
    expect(inst.rc, inst.out).toBe(0);
    expect(fs.existsSync(path.join(h, '.claude'))).toBe(false);
    const { rc, out } = await run(h, ['doctor']);
    expect(noX(out), out).toEqual([]);
    expect(out).toMatch(/△ Claude Code 에는 설치되지 않음 \(Codex 전용\)/);
    expect(out).not.toMatch(/settings hook 등록|MCP forgen-compound/);
    expect(rc).toBe(0);
  }, 120_000);

  it('Claude hook 미설치 + Codex 설치: Claude 설치 흔적이 없으면 호스트 분기', async () => {
    const h = await freshHome();
    // Claude 쪽 설치를 모두 걷어낸 뒤 Codex 를 설치한다
    fs.rmSync(path.join(h, '.claude'), { recursive: true, force: true });
    fs.rmSync(path.join(h, '.claude.json'), { force: true });
    fs.rmSync(path.join(h, '.forgen', 'bin'), { recursive: true, force: true });
    const inst = await run(h, ['install', 'codex']);
    expect(inst.rc, inst.out).toBe(0);
    const { rc, out } = await run(h, ['doctor']);
    expect(noX(out), out).toEqual([]);
    expect(rc).toBe(0);
  }, 120_000);

  it('어느 호스트에도 설치 안 됨: ✗ 하나와 재설치 안내', async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), `doctor-none-${++counter}-`));
    const { rc, out } = await run(h, ['doctor']);
    const bullets = out.split('\n').filter((l) => /^\s+• /.test(l));
    expect(bullets, out).toHaveLength(1);
    expect(out).toMatch(/✗ forgen 이 어느 호스트\(Claude Code·Codex\)에도 설치되지 않음 — Fix: forgen install claude/);
    expect(rc).toBe(1);
  }, 120_000);

  it('FORGEN_HOME 이 지정되고 settings 의 shim 경로가 달라도, 그 명령이 실제로 성공하면 ✗ 아님', async () => {
    const h = await freshHome(); // 설치는 h/.forgen/bin/forgen-run 을 가리킨다
    const alt = path.join(h, 'alt-forgen-home');
    fs.mkdirSync(alt, { recursive: true });
    const { rc, out } = await run(h, ['doctor'], { FORGEN_HOME: alt });
    expect(noX(out), out).toEqual([]);
    expect(out).toMatch(new RegExp(`hook 실행 ${N}/${N} `));
    expect(out).toMatch(/MCP forgen-compound initialize 왕복/);
    expect(out).toMatch(/△ settings 의 shim .* FORGEN_HOME 의 shim 과 다름/);
    expect(rc).toBe(0);
  }, 120_000);

  it('FORGEN_HOME 이 달라도 가리키는 shim 이 실제로 죽으면 ✗', async () => {
    const h = await freshHome();
    const alt = path.join(h, 'alt-forgen-home');
    fs.mkdirSync(alt, { recursive: true });
    pointShimAtCrashingPackage(h);
    const { rc, out } = await run(h, ['doctor'], { FORGEN_HOME: alt });
    expect(out).toMatch(new RegExp(`✗ hook 실행 0/${N} `));
    expect(rc).toBe(1);
  }, 120_000);

  it('statusLine 없음(의도적으로 비움)은 △ 이고 exit 0', async () => {
    const h = await freshHome();
    sethooks(h, (s) => { delete s.statusLine; });
    const { rc, out } = await run(h, ['doctor']);
    expect(out).toMatch(/△ statusLine 없음/);
    expect(noX(out), out).toEqual([]);
    expect(rc).toBe(0);
  }, 120_000);

  it('forgen 을 쓴 적 없는 사용자 statusLine 은 △ 이고 exit 0', async () => {
    const h = await freshHome();
    sethooks(h, (s) => { s.statusLine = { type: 'command', command: 'echo my-own-line' }; });
    const { rc, out } = await run(h, ['doctor']);
    expect(out).toMatch(/△ statusLine 은 다른 명령 \(echo my-own-line\)/);
    expect(noX(out), out).toEqual([]);
    expect(rc).toBe(0);
  }, 120_000);

  it('체인 statusLine: 사용자 원본 명령이 실패해도 forgen ✗ 로 보고하지 않는다', async () => {
    const h = await freshHome();
    sethooks(h, (s) => { s.statusLine = { type: 'command', command: `${s.statusLine.command} --after 'exit 7'` }; });
    const { rc, out } = await run(h, ['doctor']);
    expect(out).toMatch(/✓ statusLine 실행 \(빈 JSON 입력 → 출력\) — forgen 부분만/);
    expect(noX(out), out).toEqual([]);
    expect(rc).toBe(0);
  }, 120_000);

  it('체인 statusLine 의 forgen 부분이 깨지면 ✗', async () => {
    const h = await freshHome();
    sethooks(h, (s) => { s.statusLine = { type: 'command', command: `${s.statusLine.command.replace('cli.js', 'cliX.js')} --after 'echo ok'` }; });
    const { rc, out } = await run(h, ['doctor']);
    expect(out).toMatch(/✗ statusLine 실행/);
    expect(rc).toBe(1);
  }, 120_000);
});

describe('hook 프로브가 멈추지 않는다 (프로세스 그룹 kill)', () => {
  it('sleep 31 hook 과 파이프를 쥔 손자 프로세스가 있어도 doctor 가 끝나고 사유를 보고한다', async () => {
    const h = await freshHome();
    sethooks(h, (s) => {
      // forgen-run 으로 끝나는 명령은 forgen 소유로 취급돼 실행 프로브 대상이 된다 (셸 주석으로 무해화).
      s.hooks.Stop.push({ matcher: '*', hooks: [{ type: 'command', command: 'sleep 31; echo x # /fake/forgen-run', timeout: 5 }] });
      s.hooks.Stop.push({ matcher: '*', hooks: [{ type: 'command', command: "(sleep 31 &) ; echo '{}' # /fake/forgen-run", timeout: 5 }] });
    });
    const t0 = Date.now();
    const { rc, out } = await run(h, ['doctor']);
    const elapsed = Date.now() - t0;
    expect(out).toMatch(/✗ hook 실행 \d+\/\d+/);
    expect(out).toMatch(/Stop:.*→ 시간 초과/);
    expect(rc).toBe(1);
    expect(elapsed, `doctor 소요 ${elapsed}ms`).toBeLessThan(26_000); // 31초 sleep 을 기다렸다면 31초를 넘는다
    // 프로세스 그룹이 정리돼 sleep 이 남지 않는다 (종료 반영까지 잠깐 기다린다)
    const leftover = () => spawnSync('ps', ['-eo', 'pid,args']).stdout.toString().split('\n').filter((l) => /^\s*\d+\s+sleep 31\s*$/.test(l));
    let left = leftover();
    for (let i = 0; i < 40 && left.length > 0; i++) { await new Promise((r) => setTimeout(r, 100)); left = leftover(); }
    expect(left, '남은 sleep 31 프로세스').toEqual([]);
  }, 120_000);
});

describe('doctor --quick — 실행 없이 설정·파일만', () => {
  it('hook·MCP·statusLine 을 실행하지 않는다: 죽은 대상이어도 실행 ✗ 가 없고 훨씬 빠르다', async () => {
    const h = await freshHome();
    pointShimAtCrashingPackage(h);
    const t0 = Date.now();
    const quick = await run(h, ['doctor', '--quick']);
    const quickMs = Date.now() - t0;
    expect(quick.out).not.toMatch(/hook 실행|MCP forgen-compound initialize|statusLine 실행/);
    expect(quick.out).toMatch(/△ 실행 검증 생략 \(--quick\)/);
    expect(quick.rc).toBe(0);
    const t1 = Date.now();
    const full = await run(h, ['doctor']);
    const fullMs = Date.now() - t1;
    expect(full.out).toMatch(new RegExp(`✗ hook 실행 0/${N} `));
    expect(quickMs, `quick ${quickMs}ms vs full ${fullMs}ms`).toBeLessThan(fullMs);
  }, 120_000);

  it('quick 에서도 설정 파손(hook 삭제)은 ✗', async () => {
    const h = await freshHome();
    sethooks(h, (s) => { s.hooks = {}; });
    const { rc, out } = await run(h, ['doctor', '--quick']);
    expect(out).toMatch(new RegExp(`✗ settings hook 등록 0/${N}\\b`));
    expect(rc).toBe(1);
  }, 120_000);
});
