/**
 * doctor 의 "실제 실행" 검증 (D8).
 *
 * 파일이 있다/설정에 적혀 있다가 아니라, Claude Code 가 하는 그대로 settings.json 의 명령을 실행해
 * shim → node → 대상 체인이 살아 있는지 본다.
 *   - hook: 빈 입력으로 실행 → rc 0 + stdout 이 유효 JSON 1개 (shim 의 "대상 없음" 경고 JSON 도 실패로 본다)
 *   - MCP: initialize 왕복
 *   - statusLine: 빈 JSON 입력으로 실행 → rc 0 + 출력 있음
 * 프로브는 임시 FORGEN_HOME 에서 돌려 실제 상태 디렉터리에 기록을 남기지 않는다.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { generateHooksJson } from '../hooks/hooks-generator.js';
import { forgenRunShimPath, isForgenRunCommand, shimSupported } from '../host/claude-shim.js';
import { isForgenHookCommand } from '../host/install-claude.js';
import { isForgenStatusline } from './statusline-install.js';
import { scanRuleFiles } from '../store/rule-store.js';

export interface Probe {
  section: string;
  label: string;
  ok: boolean;
  hint?: string;
  /** true 면 실패로 세지 않는 정보 표시 (△) */
  info?: boolean;
}

type Json = Record<string, unknown>;

function readJson(p: string): { value?: Json; error?: string } {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'JSON 객체가 아님' };
    return { value: v as Json };
  } catch (e) {
    return { error: e instanceof Error ? e.message.split('\n')[0] : String(e) };
  }
}

interface RunResult { rc: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string }

/** 프로세스 그룹 전체를 죽인다 (손자가 파이프를 쥐고 있어도 정리). */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => { /* ignore */ });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* 이미 종료 */ }
  }
}

/** exit 뒤 파이프 flush 를 기다리는 유예. 손자가 파이프를 쥐고 있으면 close 가 영영 안 오므로 이 시간 뒤 확정한다. */
const EXIT_GRACE_MS = 250;

function spawnGroup(command: string, env: NodeJS.ProcessEnv, cwd: string): ChildProcess {
  return spawn(command, { shell: true, env, cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
}

function runCommand(command: string, input: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let rcSeen: number | null = null;
    const child = spawnGroup(command, env, cwd);
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      killTree(child); // 남은 손자 정리
      child.stdout?.destroy(); child.stderr?.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => { timedOut = true; done({ rc: rcSeen, stdout, stderr, timedOut }); }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => done({ rc: null, stdout, stderr, timedOut, spawnError: e.message }));
    child.on('exit', (rc) => { rcSeen = rc; setTimeout(() => done({ rc, stdout, stderr, timedOut }), EXIT_GRACE_MS); });
    child.on('close', (rc) => done({ rc, stdout, stderr, timedOut }));
    child.stdin?.on('error', () => { /* 입력을 읽지 않고 끝난 프로세스 */ });
    child.stdin?.end(input);
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/** settings.json 에서 이벤트별 forgen 소유 hook 명령을 모은다. */
function collectForgenHooks(settings: Json, pkgRoot: string): Array<{ event: string; command: string }> {
  const out: Array<{ event: string; command: string }> = [];
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const group = g as { command?: unknown; hooks?: Array<{ command?: unknown }> };
      const cmds: unknown[] = typeof group.command === 'string' ? [group.command] : (group.hooks ?? []).map((h) => h?.command);
      for (const c of cmds) if (typeof c === 'string' && isForgenHookCommand(c, pkgRoot)) out.push({ event, command: c });
    }
  }
  return out;
}

/** `forgen config hooks` 용: 실제 settings.json 에 등록된 forgen hook 과 disableAllHooks 상태. */
export function readSettingsHooks(homeDir: string, pkgRoot: string): { error?: string; disableAll: boolean; entries: Array<{ event: string; command: string }> } {
  const r = readJson(path.join(homeDir, '.claude', 'settings.json'));
  if (!r.value) return { error: fs.existsSync(path.join(homeDir, '.claude', 'settings.json')) ? `settings.json 파싱 실패 (${r.error})` : 'settings.json 없음', disableAll: false, entries: [] };
  return { disableAll: r.value.disableAllHooks === true, entries: collectForgenHooks(r.value, pkgRoot) };
}

function short(command: string): string {
  const m = command.match(/(hooks\/[\w.-]+\.js)"?(?:\s+"?(\w+)"?)?\s*$/);
  return m ? (m[2] ? `${m[1]} ${m[2]}` : m[1]) : command.slice(-40);
}

function probeHookOutput(r: RunResult): string | null {
  if (r.spawnError) return `실행 실패: ${r.spawnError}`;
  if (r.timedOut) return '시간 초과';
  if (r.rc !== 0) return `rc ${r.rc}${r.stderr.trim() ? ` (${r.stderr.trim().split('\n')[0].slice(0, 80)})` : ''}`;
  const out = r.stdout.trim();
  if (!out) return '출력 없음';
  let parsed: unknown;
  try { parsed = JSON.parse(out); } catch { return '출력이 JSON 1개가 아님'; }
  const msg = (parsed as { systemMessage?: unknown })?.systemMessage;
  if (typeof msg === 'string' && msg.includes('forgen hooks are not running')) return 'shim 이 대상 또는 node 를 못 찾음';
  return null;
}

function dangling(dir: string, depth = 1): string[] {
  const bad: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return bad; }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        try { fs.statSync(p); } catch { bad.push(p); }
      } else if (st.isDirectory() && depth > 0) {
        bad.push(...dangling(p, depth - 1));
      }
    } catch { /* race */ }
  }
  return bad;
}

export interface VerifyOptions {
  homeDir: string;
  forgenHome: string;
  /** 실행 중인 forgen 패키지 루트 (shim 이 없을 때의 절대경로 비교용) */
  pkgRoot: string;
  /** 느린 실행 프로브 생략 (--quick): hook·MCP·statusLine 은 실행하지 않고 설정·파일만 본다. */
  skipExec?: boolean;
}

/** 플랫폼별 셸 인용. POSIX 는 단일 인용, Windows(cmd) 는 큰따옴표. */
export function quoteShellArg(s: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `"${s.replace(/"/g, '\\"')}"`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface HostPresence { claude: boolean; codex: boolean }

/** forgen 이 설치된 호스트. 파일 하나가 아니라 설치 흔적(shim·hook·MCP·명령·statusLine) 중 하나라도 있으면 설치된 것으로 본다. */
export function detectHosts(homeDir: string, pkgRoot: string): HostPresence {
  let claude = false;
  try { if (shimSupported() && fs.existsSync(forgenRunShimPath(homeDir))) claude = true; } catch { /* ignore */ }
  const settings = readJson(path.join(homeDir, '.claude', 'settings.json')).value;
  if (settings) {
    if (collectForgenHooks(settings, pkgRoot).length > 0) claude = true;
    const sl = (settings.statusLine as { command?: string } | undefined)?.command;
    if (typeof sl === 'string' && sl.trim() && (isForgenStatusline(sl) || isForgenRunCommand(sl))) claude = true;
  }
  const cj = readJson(path.join(homeDir, '.claude.json')).value;
  if ((cj?.mcpServers as Json | undefined)?.['forgen-compound']) claude = true;
  if (fs.existsSync(path.join(homeDir, '.claude', 'commands', 'forgen'))) claude = true;

  let codex = false;
  const codexHome = process.env.CODEX_HOME ?? path.join(homeDir, '.codex');
  try { if (/forgen/i.test(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf-8'))) codex = true; } catch { /* 없음 */ }
  try { if (/forgen-compound/.test(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf-8'))) codex = true; } catch { /* 없음 */ }
  return { claude, codex };
}

function shimTarget(shimPath: string): { ok: boolean; why: string } {
  let why = 'shim 파일 없음';
  try {
    const content = fs.readFileSync(shimPath, 'utf-8');
    const pkg = content.match(/^FORGEN_PKG='(.*)'$/m)?.[1];
    if (pkg && fs.existsSync(path.join(pkg, 'dist', 'cli.js'))) return { ok: true, why: '' };
    why = `shim 이 가리키는 패키지가 없음 (${pkg ?? '?'})`;
  } catch { /* 파일 없음 */ }
  return { ok: false, why };
}

/** settings 명령 맨 앞의 forgen-run shim 경로 (인용 해제). */
function referencedShim(command: string): string | null {
  const m = command.match(/^"((?:[^"\\]|\\.)*[\\/]forgen-run)"/);
  return m ? m[1].replace(/\\(.)/g, '$1') : null;
}

/** settings·shim·hook·MCP·statusLine·데이터 파일 전체 검증. 순서는 출력 순서. */
export async function collectProbes(opts: VerifyOptions): Promise<Probe[]> {
  const probes: Probe[] = [];
  const add = (p: Probe) => probes.push(p);
  const { homeDir, forgenHome, pkgRoot } = opts;
  const claudeDir = path.join(homeDir, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const claudeJsonPath = path.join(homeDir, '.claude.json');
  const reinstall = 'forgen install claude (또는 forgen doctor --repair)';

  const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-doctor-'));
  // HOME 도 격리한다. SessionStart hook 의 룰 파일 회수 같은 동작이 실제 홈을 건드리면 안 된다.
  // FORGEN_DOCTOR_PROBE=1 은 hook 쪽의 부작용 경로(세션 상태 기록, auto-compound·lifecycle 스폰)를 끈다.
  const probeEnv: NodeJS.ProcessEnv = { ...process.env, HOME: probeHome, USERPROFILE: probeHome, FORGEN_HOME: probeHome, FORGEN_CWD: probeHome, FORGEN_DOCTOR_PROBE: '1' };
  delete probeEnv.FORGEN_NESTED_RUN;

  try {
    const hosts = detectHosts(homeDir, pkgRoot);
    if (!hosts.claude) {
      if (hosts.codex) add({ section: 'Install', label: 'Claude Code 에는 설치되지 않음 (Codex 전용)', ok: true, info: true, hint: 'Claude 항목은 건너뜀. Claude 도 쓰려면: forgen install claude' });
      else add({ section: 'Install', label: 'forgen 이 어느 호스트(Claude Code·Codex)에도 설치되지 않음', ok: false, hint: 'Fix: forgen install claude  (Codex 는 forgen install codex)' });
    }
    if (hosts.claude) {
    const shimPath = shimSupported() ? forgenRunShimPath(homeDir) : null;
    const envHome = !!process.env.FORGEN_HOME;
    // FORGEN_HOME 이 지정된 환경에선 settings 의 shim 경로가 달라도 같은 hook 으로 본다 (실제 실행 성공 여부는 아래 실행 프로브가 판정).
    const canon = (c: string) => (envHome ? c.replace(/^"[^"]*forgen-run"/, '"<shim>"') : c);

    // ── settings.json 읽기 ──
    const sRes = readJson(settingsPath);
    const settings = sRes.value;
    const actual = settings ? collectForgenHooks(settings, pkgRoot) : [];

    // ── shim ──
    if (shimPath) {
      const t = shimTarget(shimPath);
      const other = envHome ? [...new Set(actual.map((a) => referencedShim(a.command)).filter((x): x is string => !!x && x !== shimPath))].find((r) => shimTarget(r).ok) : undefined;
      if (!t.ok && other) {
        add({ section: 'Install', label: `settings 의 shim (${other}) 이 FORGEN_HOME 의 shim 과 다름`, ok: true, info: true, hint: '지정한 FORGEN_HOME 에는 shim 이 없지만 settings 가 가리키는 shim 은 살아 있음. 실행 결과는 아래 Execution 참고' });
      } else {
        add({ section: 'Install', label: 'hook/MCP shim (~/.forgen/bin/forgen-run) → forgen package', ok: t.ok, hint: `${t.why}. Fix: ${reinstall}` });
      }
    }

    // ── hook 등록 ──
    if (!settings) {
      add({ section: 'Install', label: 'settings.json 읽기', ok: false, hint: `${fs.existsSync(settingsPath) ? `파싱 실패 (${sRes.error})` : '파일 없음'} — hook·statusLine 이 연결되지 않음. Fix: ${reinstall}` });
    } else {
      const disabled = settings.disableAllHooks === true;
      add({ section: 'Install', label: 'disableAllHooks 꺼짐', ok: !disabled, hint: 'settings.json 에 disableAllHooks:true — 모든 hook 이 꺼져 있음. 값을 지우세요' });

      const expectedJson = generateHooksJson({
        pluginRoot: path.join(pkgRoot, 'dist'), runtime: 'claude', releaseMode: true, ...(shimPath ? { shimPath } : {}),
      });
      const expected: Array<{ event: string; command: string }> = [];
      for (const [event, groups] of Object.entries(expectedJson.hooks)) for (const g of groups) for (const h of g.hooks) expected.push({ event, command: h.command });
      const same = (a: { event: string; command: string }, e: { event: string; command: string }) => a.event === e.event && canon(a.command) === canon(e.command);
      const count = (list: typeof actual, e: { event: string; command: string }) => list.filter((a) => same(a, e)).length;
      const missing = expected.filter((e) => count(actual, e) === 0);
      const dup = expected.filter((e) => count(actual, e) > 1);
      const stale = actual.filter((a) => !expected.some((e) => same(a, e)));
      add({
        section: 'Install', label: `settings hook 등록 ${expected.length - missing.length}/${expected.length}`, ok: missing.length === 0,
        hint: `누락: ${missing.slice(0, 4).map((m) => `${m.event}:${short(m.command)}`).join(', ')}${missing.length > 4 ? ` 외 ${missing.length - 4}` : ''}. Fix: ${reinstall}`,
      });
      add({
        section: 'Install', label: 'hook 이중 등록 없음', ok: dup.length === 0,
        hint: `중복 ${dup.length}개 (${dup.slice(0, 3).map((m) => short(m.command)).join(', ')}) — 같은 hook 이 두 번 돌아 출력이 겹침. Fix: ${reinstall}`,
      });
      add({
        section: 'Install', label: '구형·다른 경로 forgen hook 없음', ok: stale.length === 0,
        hint: `${stale.length}개 (${stale.slice(0, 2).map((m) => m.command.slice(0, 60)).join(' | ')}) — 현재 shim 이 아닌 경로를 가리킴. Fix: ${reinstall}`,
      });

      // 실제 실행 — 등록된 forgen hook 전부 (중복 제거)
      if (!opts.skipExec) {
        const uniq = [...new Map(actual.map((a) => [`${a.event}\0${a.command}`, a])).values()];
        const results = await mapLimit(uniq, 6, async (h) => ({ h, r: await runCommand(h.command, '', probeEnv, probeHome, 15_000) }));
        const failed = results.map(({ h, r }) => ({ h, why: probeHookOutput(r) })).filter((x) => x.why);
        add({
          section: 'Execution', label: `hook 실행 ${uniq.length - failed.length}/${uniq.length} (빈 입력 → 유효 JSON, rc 0)`, ok: failed.length === 0 && uniq.length > 0,
          hint: uniq.length === 0 ? '실행할 forgen hook 이 settings 에 없음' : `${failed.slice(0, 3).map((f) => `${f.h.event}:${short(f.h.command)} → ${f.why}`).join('; ')}${failed.length > 3 ? ` 외 ${failed.length - 3}` : ''}`,
        });
      }

      // ── statusLine ──
      const sl = (settings.statusLine as { command?: string } | undefined)?.command;
      if (!sl || !sl.trim()) {
        add({ section: 'Statusline', label: 'statusLine 없음', ok: true, info: true, hint: '의도적으로 비웠다면 정상. forgen HUD 를 쓰려면: forgen statusline install' });
      } else if (!isForgenStatusline(sl) && !isForgenRunCommand(sl)) {
        add({ section: 'Statusline', label: `statusLine 은 다른 명령 (${sl.slice(0, 50)})`, ok: true, info: true, hint: 'forgen HUD 로 바꾸려면: forgen statusline install --force' });
      } else {
        add({ section: 'Statusline', label: 'statusLine 이 shim 또는 절대경로 (nvm-safe)', ok: !/^forgen(\s|$)/.test(sl.trim()), hint: 'PATH 의존 `forgen statusline` 은 nvm 버전에 따라 달라짐. Fix: forgen statusline install' });
        if (!opts.skipExec) {
          // 체인(`… statusline --after '<원본>'`)이면 forgen 부분만 실행해 판정한다. 사용자 원본 명령의 실패는 forgen 의 책임이 아니다.
          const chainAt = sl.search(/\sstatusline\s+--after\s/);
          const forgenPart = chainAt >= 0 ? sl.slice(0, chainAt + ' statusline'.length) : sl;
          const r = await runCommand(forgenPart, '{}', probeEnv, probeHome, 15_000);
          const why = r.spawnError ? r.spawnError : r.timedOut ? '시간 초과' : r.rc !== 0 ? `rc ${r.rc}` : !r.stdout.trim() ? '출력 없음' : /forgen: not found|forgen hooks are not running/.test(r.stdout) ? 'shim 이 대상 cli.js 를 못 찾음' : null;
          add({ section: 'Statusline', label: `statusLine 실행 (빈 JSON 입력 → 출력)${chainAt >= 0 ? ' — forgen 부분만' : ''}`, ok: !why, hint: `${why}. Fix: forgen statusline install` });
        }
      }
    }

    // ── MCP ──
    const cj = readJson(claudeJsonPath);
    const mcp = ((cj.value?.mcpServers as Json | undefined)?.['forgen-compound']) as { command?: string; args?: string[] } | undefined;
    if (!cj.value) {
      add({ section: 'Execution', label: '~/.claude.json 읽기', ok: false, hint: `${fs.existsSync(claudeJsonPath) ? `파싱 실패 (${cj.error})` : '파일 없음'} — MCP 등록을 확인할 수 없음. Fix: ${reinstall}` });
    } else if (!mcp?.command) {
      add({ section: 'Execution', label: 'MCP forgen-compound 등록', ok: false, hint: `~/.claude.json 에 forgen-compound 가 없음. Fix: ${reinstall}` });
    } else if (!opts.skipExec) {
      const cmd = [mcp.command, ...(mcp.args ?? [])].map((s) => quoteShellArg(s)).join(' ');
      const why = await mcpInitialize(cmd, probeEnv, probeHome);
      add({ section: 'Execution', label: 'MCP forgen-compound initialize 왕복', ok: !why, hint: `${why}. Fix: ${reinstall}` });
    }
    if (opts.skipExec) add({ section: 'Execution', label: '실행 검증 생략 (--quick)', ok: true, info: true, hint: 'hook·MCP·statusLine 을 실제로 실행해 보려면: forgen doctor' });

    // ── 설치 자산 ──
    const cmdDir = path.join(claudeDir, 'commands', 'forgen');
    const cmdCount = fs.existsSync(cmdDir) ? fs.readdirSync(cmdDir).filter((f) => f.endsWith('.md')).length : 0;
    add({ section: 'Install', label: `슬래시 명령 설치 (${cmdCount})`, ok: cmdCount > 0, hint: `~/.claude/commands/forgen 이 비었거나 없음. Fix: ${reinstall}` });
    const skillsDir = path.join(claudeDir, 'skills');
    let skillCount = 0;
    try { skillCount = fs.readdirSync(skillsDir).filter((f) => f.startsWith('forgen-') || f === 'verify').length; } catch { /* 없음 */ }
    add({ section: 'Install', label: `forgen 스킬 설치 (${skillCount})`, ok: skillCount > 0, hint: `~/.claude/skills 에 forgen-* 스킬 없음. Fix: ${reinstall}` });
    const broken = [skillsDir, path.join(claudeDir, 'commands'), path.join(claudeDir, 'agents'), forgenHome].flatMap((d) => dangling(d));
    add({ section: 'Install', label: '끊긴 심링크 없음', ok: broken.length === 0, hint: `${broken.length}개: ${broken.slice(0, 3).join(', ')}` });
    }

    // ── 데이터 파일 (파싱까지) ──
    const profile = path.join(forgenHome, 'me', 'forge-profile.json');
    if (!fs.existsSync(profile)) add({ section: 'Data', label: '프로필 없음 (me/forge-profile.json)', ok: true, info: true, hint: '룰은 동작함. forgen 으로 온보딩하면 4축 프로필을 사용' });
    else { const r = readJson(profile); add({ section: 'Data', label: 'Profile 파싱 (me/forge-profile.json)', ok: !!r.value, hint: `깨짐 (${r.error}). 복구: forgen forge --reset 후 온보딩` }); }
    for (const rel of ['forge-profile.json', 'config.json', 'hook-config.json']) {
      const p = path.join(forgenHome, rel);
      if (!fs.existsSync(p)) continue;
      const r = readJson(p);
      add({ section: 'Data', label: `${rel} 파싱`, ok: !!r.value, hint: `깨짐 (${r.error}) — ${p}` });
    }
    const dbPath = path.join(forgenHome, 'sessions.db');
    if (fs.existsSync(dbPath)) add({ section: 'Data', label: 'sessions.db 열기', ok: sqliteOk(dbPath), hint: 'SQLite 파일이 아니거나 손상됨. 백업 후 삭제하면 새로 만들어짐' });

    const scan = scanRuleFiles();
    if (scan.dirError) add({ section: 'Data', label: '룰 디렉터리 읽기', ok: false, hint: `읽을 수 없음: ${scan.dirError}` });
    else add({ section: 'Data', label: `룰 파일 ${scan.rules.length + scan.broken.length}개 파싱 (깨진 ${scan.broken.length}개)`, ok: scan.broken.length === 0, hint: `깨진 룰: ${scan.broken.slice(0, 3).map((b) => b.file).join(', ')}${scan.broken.length > 3 ? ' …' : ''}` });

    const solDir = path.join(forgenHome, 'me', 'solutions');
    if (fs.existsSync(solDir)) {
      let badSol = 0; let totalSol = 0;
      try {
        for (const f of fs.readdirSync(solDir).filter((x) => x.endsWith('.md'))) {
          totalSol++;
          const head = fs.readFileSync(path.join(solDir, f), 'utf-8').slice(0, 200);
          if (!head.startsWith('---') || head.includes('\0')) badSol++;
        }
      } catch { badSol = -1; }
      add({ section: 'Data', label: `솔루션 ${totalSol}개 frontmatter 확인`, ok: badSol === 0, hint: badSol < 0 ? '솔루션 디렉터리를 읽을 수 없음' : `${badSol}개 frontmatter 깨짐` });
    }

    // ── 최근 hook 오류 (24h) ──
    try {
      const errPath = path.join(forgenHome, 'state', 'hook-errors.jsonl');
      if (fs.existsSync(errPath)) {
        const cutoff = Date.now() - 24 * 3600_000;
        const byHook = new Map<string, number>();
        for (const line of fs.readFileSync(errPath, 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line) as { hook?: string; timestamp?: string };
            if (Date.parse(e.timestamp ?? '') >= cutoff) byHook.set(e.hook ?? '?', (byHook.get(e.hook ?? '?') ?? 0) + 1);
          } catch { /* skip */ }
        }
        const noisy = [...byHook.entries()].filter(([, n]) => n >= 3);
        add({ section: 'Hook Health', label: '최근 24h hook 오류 3회 미만', ok: noisy.length === 0, hint: noisy.map(([h, n]) => `${h}: ${n}회`).join(', ') });
      }
    } catch { /* 읽기 실패는 아래 Hook Health 출력에서 표시 */ }
  } finally {
    try { fs.rmSync(probeHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return probes;
}

function sqliteOk(dbPath: string): boolean {
  try {
    const fd = fs.openSync(dbPath, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    if (buf.toString('utf-8', 0, 15) !== 'SQLite format 3') return false;
  } catch { return false; }
  try {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string, o?: Record<string, unknown>) => { prepare(s: string): { get(): Record<string, unknown> }; close(): void } };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return Object.values(db.prepare('PRAGMA quick_check').get())[0] === 'ok'; } finally { db.close(); }
  } catch {
    return true; // node:sqlite 없음(Node 20) — 헤더 확인까지만
  }
}

function mcpInitialize(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    let buf = '';
    let stderr = '';
    let settled = false;
    const child = spawnGroup(command, env, cwd);
    const finish = (why: string | null) => { if (settled) return; settled = true; clearTimeout(timer); killTree(child); child.stdout?.destroy(); child.stderr?.destroy(); resolve(why); };
    const timer = setTimeout(() => finish('initialize 응답 시간 초과'), 12_000);
    child.stdout?.on('data', (d) => {
      buf += String(d);
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { serverInfo?: unknown }; error?: unknown };
          if (msg.id === 1) return finish(msg.result?.serverInfo ? null : 'initialize 응답에 serverInfo 없음');
        } catch { /* 다음 줄 */ }
      }
    });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => finish(`실행 실패: ${e.message}`));
    const ended = (rc: number | null) => finish(`응답 없이 종료 (rc ${rc}${stderr.trim() ? `: ${stderr.trim().split('\n')[0].slice(0, 80)}` : ''})`);
    child.on('exit', (rc) => { setTimeout(() => ended(rc), EXIT_GRACE_MS); });
    child.on('close', ended);
    child.stdin?.on('error', () => { /* 이미 종료 */ });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'forgen-doctor', version: '1' } } })}\n`);
  });
}
