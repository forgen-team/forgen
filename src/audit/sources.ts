/**
 * 감사 원천 읽기 — **읽기 전용** (docs/plans/2026-11-25-v1.0-plan.md §2.1, §3.1).
 *
 * 호스트(Claude Code)가 세션 시작에 싣는 기억 층을 폴더마다 다시 구성한다.
 *   - 관리형 정책 CLAUDE.md (있을 때만)
 *   - 사용자: <claude-dir>/CLAUDE.md, <claude-dir>/rules/**.md
 *   - 프로젝트: 폴더에서 홈(또는 루트)까지 올라가며 CLAUDE.md · .claude/CLAUDE.md · CLAUDE.local.md · AGENTS.md
 *   - 프로젝트 룰: 폴더와 그 저장소 루트의 .claude/rules/**.md (앞머리 `paths:` 가 있으면 조건부)
 *   - @import: 따라가되 같은 파일은 한 번만, 깊이 5 까지(순환 방지)
 *   - 자동 메모리: <claude-dir>/projects/<인코딩된 저장소 루트>/memory 의 MEMORY.md 앞 200줄·25KB + 주제 파일
 *   - forgen 세션 시작 렌더(renderSessionStartReadOnly — 상태를 쓰지 않는 렌더 경로)
 *
 * 이 모듈은 파일을 쓰지 않는다. 읽기 실패(권한·깨진 파일)는 error 로 남기고 계속한다.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { decodeProjectDir, isHomeDir } from '../way/io.js';
import { estimateTokens } from './tokens.js';

export type Layer =
  | 'managed' | 'user' | 'user-rules' | 'project' | 'project-local' | 'project-rules' | 'agents' | 'import'
  | 'memory-index' | 'memory-topic' | 'forgen-render';

/** Claude Code 문서의 MEMORY.md 상한: 앞 200줄 또는 25KB 중 먼저 오는 쪽만 세션 시작에 실린다. */
export const MEMORY_MAX_LINES = 200;
export const MEMORY_MAX_BYTES = 25 * 1024;
const MAX_IMPORT_DEPTH = 5;
const MAX_READ_BYTES = 4 * 1024 * 1024;

export interface SourceFile {
  path: string;
  bytes: number;
  lines: number;
  sha256: string;
  text: string;
  error?: string;
  /** 룰 파일 앞머리 `paths:`. null = 없음(항상 실림). 룰 파일이 아니면 undefined. */
  paths?: string[] | null;
  /** 메모 주제 파일 앞머리 type. */
  memoryType?: string;
}

export interface LoadEntry {
  path: string;
  layer: Layer;
  /** 세션 시작에 항상 실리는가(paths: 있는 룰·주제 파일은 false). */
  always: boolean;
  tokens: number;
  /** @import 로 들어왔으면 들여온 파일. */
  via?: string;
}

export interface MemoryDir {
  dir: string;
  /** 인코딩된 폴더 이름을 되살린 경로(못 되살리면 null). */
  folder: string | null;
  index: SourceFile | null;
  /** 세션 시작에 실리는 MEMORY.md 의 앞부분(줄 수). */
  loadedLines: number;
  loadedBytes: number;
  topics: SourceFile[];
}

export interface FolderLoad {
  folder: string;
  projectKey: string | null;
  gitRoot: string | null;
  memoryDir: string | null;
  entries: LoadEntry[];
  /** tier2Ids(0.9.0 두 층): 색인 줄로만 보인 2층 룰 — 세션 시작 토큰에는 색인 줄만 들어간다 */
  forgen: { tokens: number; ruleIds: string[]; tier2Ids?: string[]; legacyTokens?: number };
  /** 세션 시작에 실리는 스킬·에이전트 목록 몫(readSkillCatalog). */
  skills?: { tokens: number; count: number; bySource: Record<string, number> };
  totalTokens: number;
}

export interface AuditEnv {
  claudeDir: string;
  home: string;
  managedPaths: string[];
}

export function defaultEnv(claudeDir?: string): AuditEnv {
  const home = os.homedir();
  return {
    claudeDir: path.resolve(claudeDir ?? path.join(home, '.claude')),
    home,
    managedPaths: process.platform === 'darwin'
      ? ['/Library/Application Support/ClaudeCode/CLAUDE.md']
      : process.platform === 'win32' ? ['C:\\Program Files\\ClaudeCode\\CLAUDE.md'] : ['/etc/claude-code/CLAUDE.md'],
  };
}

/** Claude Code 가 ~/.claude/projects 아래 폴더 이름을 만드는 방식: 영숫자 아닌 글자를 모두 '-' 로. */
export function encodeProjectDir(abs: string): string {
  return abs.replace(/[^A-Za-z0-9]/g, '-');
}

function real(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** 앞머리(---) 와 본문. 앞머리가 없으면 fm 은 ''. */
export function splitFrontmatter(text: string): { fm: string; body: string; bodyStartLine: number } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fm: '', body: text, bodyStartLine: 1 };
  return { fm: m[1], body: text.slice(m[0].length), bodyStartLine: m[0].split('\n').length };
}

/** `.claude/rules` 앞머리의 `paths:` — 목록·한 줄·[배열] 셋 다. 없으면 null. */
export function parseRulePaths(text: string): string[] | null {
  const { fm } = splitFrontmatter(text);
  if (!fm) return null;
  const lines = fm.split(/\r?\n/);
  const i = lines.findIndex((l) => /^paths\s*:/.test(l));
  if (i < 0) return null;
  const strip = (s: string) => s.trim().replace(/^["']|["']$/g, '').trim();
  const inline = lines[i].replace(/^paths\s*:/, '').trim();
  let out: string[] = [];
  if (inline.startsWith('[')) out = inline.replace(/^\[|\]$/g, '').split(',').map(strip);
  else if (inline) out = [strip(inline)];
  else {
    for (const l of lines.slice(i + 1)) {
      const m = /^\s*-\s*(.+)$/.exec(l);
      if (!m) { if (/^\S/.test(l)) break; continue; }
      out.push(strip(m[1]));
    }
  }
  out = out.filter(Boolean);
  return out.length ? out : null;
}

export function frontmatterField(text: string, field: string): string | undefined {
  const { fm } = splitFrontmatter(text);
  // 호스트 메모는 type 을 metadata: 아래에 들여 쓰기도 한다(metadata:\n  type: feedback) — 들여 쓴 줄도 읽는다.
  const m = new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm').exec(fm) ?? new RegExp(`^\\s+${field}\\s*:\\s*(.+)$`, 'm').exec(fm);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
}

/** 파일 읽기 캐시. 같은 파일은 한 번만 읽고 해시한다. */
export class SourceReader {
  readonly files = new Map<string, SourceFile>();
  /** 읽으려 했지만 실패한 파일(권한 등) — manifest 에 남긴다. */
  read(p: string): SourceFile | null {
    const abs = real(p);
    const hit = this.files.get(abs);
    if (hit) return hit;
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { return null; }
    if (!st.isFile()) return null;
    let sf: SourceFile;
    try {
      const buf = fs.readFileSync(abs);
      const text = buf.subarray(0, MAX_READ_BYTES).toString('utf-8');
      sf = { path: abs, bytes: buf.length, lines: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0, sha256: createHash('sha256').update(buf).digest('hex'), text };
    } catch (e) {
      sf = { path: abs, bytes: st.size, lines: 0, sha256: '', text: '', error: (e as NodeJS.ErrnoException).code ?? String(e) };
    }
    this.files.set(abs, sf);
    return sf;
  }
}

/** 코드 블록·인라인 코드 밖의 `@경로` 들여오기 대상(존재하는 파일만). */
export function importTargets(file: string, text: string, home: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const raw of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) continue;
    const line = raw.replace(/`[^`]*`/g, ' ');
    for (const m of line.matchAll(/(?:^|\s)@([^\s`'"()<>[\]]+)/g)) {
      const ref = m[1].replace(/[.,;:!?]+$/, '');
      if (!ref || ref.includes('@')) continue;
      const abs = ref.startsWith('~/') ? path.join(home, ref.slice(2)) : path.isAbsolute(ref) ? ref : path.resolve(path.dirname(file), ref);
      if (isFile(abs)) out.push(abs);
    }
  }
  return out;
}

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let names: string[] = [];
    try { names = fs.readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      let st: fs.Stats;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (st.isFile() && n.endsWith('.md')) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

/** 폴더의 저장소 루트(worktree 면 본 저장소). 홈 위로는 올라가지 않는다. */
export function gitRootOf(folder: string, home: string): string | null {
  for (let cur = folder; ; cur = path.dirname(cur)) {
    if (cur === home) return null;
    const g = path.join(cur, '.git');
    try {
      const st = fs.statSync(g);
      if (st.isDirectory()) return cur;
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(g, 'utf-8'));
      const main = m?.[1].trim().match(/(.+)[\\/]\.git[\\/]worktrees[\\/]/)?.[1];
      return main ?? cur;
    } catch { /* 위로 */ }
    if (cur === path.dirname(cur)) return null;
  }
}

/** 메모 폴더 하나 읽기: MEMORY.md 와 세션 시작에 실리는 앞부분, 주제 파일. */
export function readMemoryDir(reader: SourceReader, dir: string): MemoryDir {
  const index = reader.read(path.join(dir, 'MEMORY.md'));
  let loadedLines = 0;
  let loadedBytes = 0;
  if (index && !index.error) {
    const lines = index.text.split('\n');
    for (const l of lines) {
      const b = Buffer.byteLength(`${l}\n`);
      if (loadedLines >= MEMORY_MAX_LINES || loadedBytes + b > MEMORY_MAX_BYTES) break;
      loadedLines++; loadedBytes += b;
    }
    loadedLines = Math.min(loadedLines, index.lines);
    loadedBytes = Math.min(loadedBytes, index.bytes);
  }
  const topics: SourceFile[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md').sort(); } catch { /* 없음 */ }
  for (const n of names) {
    const sf = reader.read(path.join(dir, n));
    if (!sf) continue;
    if (!sf.error) sf.memoryType = frontmatterField(sf.text, 'type');
    topics.push(sf);
  }
  return { dir, folder: decodeProjectDir(path.basename(path.dirname(dir))), index, loadedLines, loadedBytes, topics };
}

export function listMemoryDirs(claudeDir: string): string[] {
  const root = path.join(claudeDir, 'projects');
  let subs: string[] = [];
  try { subs = fs.readdirSync(root).sort(); } catch { return []; }
  return subs.map((s) => path.join(root, s, 'memory')).filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

/** 메모 폴더: 저장소 루트 기준(같은 저장소의 하위 폴더·worktree 가 공유) → 없으면 폴더 자체. */
export function memoryDirFor(env: AuditEnv, folder: string, gitRoot: string | null): string | null {
  for (const base of [gitRoot, folder]) {
    if (!base) continue;
    const d = path.join(env.claudeDir, 'projects', encodeProjectDir(base), 'memory');
    try { if (fs.statSync(d).isDirectory()) return d; } catch { /* 다음 */ }
  }
  return null;
}

export function loadedMemoryText(m: MemoryDir): string {
  if (!m.index || m.index.error) return '';
  return m.index.text.split('\n').slice(0, m.loadedLines).join('\n');
}

/** CLAUDE.md 류 파일 하나와 그 @import 들을 entries 에 더한다. */
function addWithImports(reader: SourceReader, env: AuditEnv, entries: LoadEntry[], seen: Set<string>, p: string, layer: Layer, via?: string, depth = 0): void {
  const sf = reader.read(p);
  if (!sf || seen.has(sf.path)) return;
  seen.add(sf.path);
  entries.push({ path: sf.path, layer, always: true, tokens: estimateTokens(sf.text), via });
  if (depth >= MAX_IMPORT_DEPTH || sf.error) return;
  for (const t of importTargets(sf.path, sf.text, env.home)) addWithImports(reader, env, entries, seen, t, 'import', sf.path, depth + 1);
}

function addRules(reader: SourceReader, entries: LoadEntry[], seen: Set<string>, dir: string, layer: Layer): void {
  for (const p of listMarkdown(dir)) {
    const sf = reader.read(p);
    if (!sf || seen.has(sf.path)) continue;
    seen.add(sf.path);
    if (sf.paths === undefined) sf.paths = sf.error ? null : parseRulePaths(sf.text);
    entries.push({ path: sf.path, layer, always: sf.paths === null, tokens: estimateTokens(sf.text) });
  }
}

/** 홈(또는 /home/<이름>·/Users/<이름>) — 그 아래 .claude 는 사용자 층이라 프로젝트 층으로 세지 않는다. */
const homeLike = (d: string, env: AuditEnv) => d === env.home || isHomeDir(d);
const stopHere = (d: string, env: AuditEnv) => homeLike(d, env) || d === path.dirname(d);

/** 한 폴더에서 세션을 시작하면 실리는 호스트 기억(forgen 렌더 제외). */
export function hostLoadFor(reader: SourceReader, env: AuditEnv, folderIn: string, memory: Map<string, MemoryDir>): Omit<FolderLoad, 'projectKey' | 'forgen' | 'totalTokens'> {
  const folder = real(folderIn);
  const entries: LoadEntry[] = [];
  const seen = new Set<string>();
  const userClaude = real(path.join(env.claudeDir, 'CLAUDE.md'));
  const userRules = real(path.join(env.claudeDir, 'rules'));
  for (const m of env.managedPaths) addWithImports(reader, env, entries, seen, m, 'managed');
  addWithImports(reader, env, entries, seen, userClaude, 'user');
  addRules(reader, entries, seen, userRules, 'user-rules');

  const chain: string[] = [];
  for (let d = folder; ; d = path.dirname(d)) {
    chain.unshift(d);
    if (stopHere(d, env)) break;
  }
  for (const d of chain) {
    addWithImports(reader, env, entries, seen, path.join(d, 'CLAUDE.md'), 'project');
    const dot = path.join(d, '.claude', 'CLAUDE.md');
    if (real(dot) !== userClaude && !homeLike(d, env)) addWithImports(reader, env, entries, seen, dot, 'project');
    addWithImports(reader, env, entries, seen, path.join(d, 'CLAUDE.local.md'), 'project-local');
    addWithImports(reader, env, entries, seen, path.join(d, 'AGENTS.md'), 'agents');
  }
  const gitRoot = gitRootOf(folder, env.home);
  for (const d of [...new Set([gitRoot, folder].filter((x): x is string => !!x))]) {
    const rd = real(path.join(d, '.claude', 'rules'));
    if (rd !== userRules && !homeLike(d, env)) addRules(reader, entries, seen, rd, 'project-rules');
  }
  const memoryDir = memoryDirFor(env, folder, gitRoot);
  if (memoryDir) {
    let m = memory.get(memoryDir);
    if (!m) { m = readMemoryDir(reader, memoryDir); memory.set(memoryDir, m); }
    if (m.index) entries.push({ path: m.index.path, layer: 'memory-index', always: true, tokens: estimateTokens(loadedMemoryText(m)) });
  }
  return { folder, gitRoot, memoryDir, entries };
}

/** 기본 감사 폴더: 지금 폴더 + 홈 + 메모·대화 기록이 있는 폴더 중 지금 있는 것(임시 폴더 제외). */
export function defaultFolders(env: AuditEnv, cwd: string): string[] {
  const out = new Set<string>([real(cwd), real(env.home)]);
  const tmp = real(os.tmpdir());
  let subs: string[] = [];
  try { subs = fs.readdirSync(path.join(env.claudeDir, 'projects')).sort(); } catch { /* 없음 */ }
  for (const s of subs) {
    const abs = decodeProjectDir(s);
    if (!abs) continue;
    const r = real(abs);
    if (r === tmp || r.startsWith(`${tmp}${path.sep}`) || r.startsWith('/tmp/')) continue;
    out.add(r);
  }
  return [...out].sort();
}

/**
 * 세션 시작에 실리는 스킬·에이전트 목록(이름 + 설명 한 줄) — N3 의 "스킬 설명" 층.
 * 원천: 사용자 스킬(<claudeDir>/skills/<이름>/SKILL.md), 켜진 플러그인(settings.json enabledPlugins →
 * installed_plugins.json installPath)의 skills/<이름>/SKILL.md 와 agents/*.md, 프로젝트 <root>/.claude/skills.
 * 본문은 세션 시작에 실리지 않으므로 앞머리의 name·description 만 센다(호스트가 목록으로 보여 주는 몫의 근사).
 */
export interface SkillEntry { source: string; kind: 'skill' | 'agent'; name: string; path: string; tokens: number }

function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function listDir(p: string): string[] {
  try { return fs.readdirSync(p).sort(); } catch { return []; }
}

export function readSkillCatalog(reader: SourceReader, env: AuditEnv, projectRoot?: string | null): SkillEntry[] {
  const out: SkillEntry[] = [];
  const add = (source: string, kind: SkillEntry['kind'], file: string, fallbackName: string) => {
    const sf = reader.read(file);
    if (!sf || sf.error) return;
    const fm = frontmatter(sf.text);
    const name = fm.name || fallbackName;
    const desc = fm.description ?? '';
    out.push({ source, kind, name, path: sf.path, tokens: estimateTokens(`- ${name}: ${desc}`) });
  };
  const skillsIn = (source: string, dir: string) => { for (const n of listDir(dir)) add(source, 'skill', path.join(dir, n, 'SKILL.md'), n); };
  skillsIn('user', path.join(env.claudeDir, 'skills'));
  if (projectRoot) skillsIn('project', path.join(projectRoot, '.claude', 'skills'));
  let enabled: Record<string, unknown> = {};
  try { enabled = (JSON.parse(fs.readFileSync(path.join(env.claudeDir, 'settings.json'), 'utf-8')) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {}; } catch { /* 없음 */ }
  let installed: Record<string, Array<{ installPath?: string }>> = {};
  try {
    const j = JSON.parse(fs.readFileSync(path.join(env.claudeDir, 'plugins', 'installed_plugins.json'), 'utf-8')) as { plugins?: typeof installed };
    installed = j.plugins ?? (j as unknown as typeof installed);
  } catch { /* 없음 */ }
  for (const id of Object.keys(enabled).sort()) {
    if (enabled[id] !== true) continue;
    const ip = installed[id]?.[0]?.installPath;
    if (!ip) continue;
    const plugin = id.split('@')[0];
    skillsIn(`plugin:${plugin}`, path.join(ip, 'skills'));
    for (const n of listDir(path.join(ip, 'agents'))) if (n.endsWith('.md')) add(`plugin:${plugin}`, 'agent', path.join(ip, 'agents', n), n.replace(/\.md$/, ''));
  }
  return out.sort((a, b) => (a.source === b.source ? (a.name < b.name ? -1 : 1) : a.source < b.source ? -1 : 1));
}
