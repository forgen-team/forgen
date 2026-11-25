/**
 * 프로젝트 키 등록부 (0.8.0 S3).
 *
 * 한 프로젝트가 저장소 여러 개와 git 아닌 폴더로 나뉘어 있을 때 하나의 키로 묶는다.
 * 파일: `<FORGEN_HOME>/projects.json` — `{ "version": 1, "projects": { "<키>": { "paths": [...], "aliases": [...] } } }`
 *   paths   — 이 키에 속하는 폴더(하위 폴더 포함). 가장 긴 경로가 이긴다.
 *   aliases — 예전 키(보통 저장소 이름). 기존 룰의 `projects` 를 고치지 않고 새 키로 읽기 위해 쓴다.
 * 파일이 없거나 깨지면 등록부가 없는 것으로 보고 git 판정으로 돌아간다(파일을 지우면 예전 동작).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { atomicWriteJSON } from '../hooks/shared/atomic-write.js';

// paths.ts 의 FORGEN_HOME 과 같은 규칙(테스트가 paths 모듈을 부분 mock 해도 깨지지 않게 여기서 계산).
export const PROJECT_REGISTRY_PATH = path.join(process.env.FORGEN_HOME ? path.resolve(process.env.FORGEN_HOME) : path.join(os.homedir(), '.forgen'), 'projects.json');
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface ProjectEntry { paths: string[]; aliases?: string[] }
export interface ProjectRegistry { version: 1; projects: Record<string, ProjectEntry> }

interface Loaded { reg: ProjectRegistry; mtimeMs: number; size: number; realPaths: Array<{ key: string; dir: string }>; aliasTo: Map<string, string> }
let cache: Loaded | null = null;

function realOrResolved(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function empty(): ProjectRegistry { return { version: 1, projects: {} }; }

function sanitize(raw: unknown): ProjectRegistry {
  const out = empty();
  const projects = (raw as { projects?: unknown } | null)?.projects;
  if (!projects || typeof projects !== 'object') return out;
  for (const [key, v] of Object.entries(projects as Record<string, unknown>)) {
    if (!KEY_RE.test(key) || !v || typeof v !== 'object') continue;
    const e = v as { paths?: unknown; aliases?: unknown };
    const paths = Array.isArray(e.paths) ? e.paths.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)) : [];
    const aliases = Array.isArray(e.aliases) ? e.aliases.filter((a): a is string => typeof a === 'string' && KEY_RE.test(a) && a !== key) : [];
    out.projects[key] = { paths, ...(aliases.length ? { aliases } : {}) };
  }
  return out;
}

/**
 * 등록부 읽기. 같은 프로세스에서는 mtime+size 가 같으면 캐시를 쓴다. CLI 로 바꾸면 캐시를 지운다.
 * 한계: 같은 크기로 같은 밀리초에 손으로 고치면 오래 사는 프로세스(MCP)는 다음 변경까지 옛 값을 볼 수 있다.
 */
function load(): Loaded | null {
  let st: fs.Stats;
  try { st = fs.statSync(PROJECT_REGISTRY_PATH); } catch { cache = null; return null; }
  if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache;
  let reg: ProjectRegistry;
  try { reg = sanitize(JSON.parse(fs.readFileSync(PROJECT_REGISTRY_PATH, 'utf-8'))); } catch { cache = null; return null; }
  const realPaths: Array<{ key: string; dir: string }> = [];
  const aliasTo = new Map<string, string>();
  for (const [key, e] of Object.entries(reg.projects)) {
    for (const p of e.paths) realPaths.push({ key, dir: realOrResolved(p) });
    for (const a of e.aliases ?? []) if (!aliasTo.has(a) && !reg.projects[a]) aliasTo.set(a, key);
  }
  realPaths.sort((a, b) => b.dir.length - a.dir.length);
  cache = { reg, mtimeMs: st.mtimeMs, size: st.size, realPaths, aliasTo };
  return cache;
}

/** 실제 경로가 등록부의 어느 키에 속하는가. 가장 긴 경로가 이긴다. 없으면 null. */
export function registryKeyFor(realDir: string): string | null {
  const l = load();
  if (!l) return null;
  for (const { key, dir } of l.realPaths) {
    if (realDir === dir || realDir.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)) return key;
  }
  return null;
}

/** 예전 키(별칭)를 등록부의 키로. 등록부에 없으면 그대로. */
export function canonicalProjectKey(key: string): string {
  const k = key.toLowerCase();
  return load()?.aliasTo.get(k) ?? k;
}

/** 이 키로 읽히는 모든 이름(키 자신 + 별칭). */
export function projectKeyNames(key: string): string[] {
  const l = load();
  const canon = canonicalProjectKey(key);
  return [canon, ...(l?.reg.projects[canon]?.aliases ?? [])];
}

export function readProjectRegistry(): ProjectRegistry {
  return load()?.reg ?? empty();
}

/** 폴더(와 별칭)를 키에 더한다. 같은 폴더가 다른 키에 있으면 거기서 뺀다. */
export function addProjectPaths(key: string, dirs: string[], aliases: string[] = []): ProjectRegistry {
  const k = key.toLowerCase();
  if (!KEY_RE.test(k)) throw new Error(`invalid project key: ${key} (소문자·숫자·.-_ , 64자 이하)`);
  const reg = readProjectRegistry();
  for (const d of dirs) if (!fs.existsSync(path.resolve(d))) throw new Error(`folder not found: ${path.resolve(d)}`);
  // 저장도 조회와 같은 실제 경로로(심링크를 풀어서). 홈·루트는 심링크로 가려도 거부한다 — 모든 작업이 그 키가 된다.
  const abs = dirs.map((d) => realOrResolved(path.resolve(d)));
  const home = realOrResolved(os.homedir());
  for (const d of abs) if (d === home || d === path.parse(d).root) throw new Error(`홈 폴더나 루트는 프로젝트로 묶을 수 없습니다: ${d}`);
  for (const [other, e] of Object.entries(reg.projects)) {
    if (other !== k) e.paths = e.paths.filter((p) => !abs.includes(p));
  }
  const cur = reg.projects[k] ?? { paths: [] };
  const al = [...new Set([...(cur.aliases ?? []), ...aliases.map((a) => a.toLowerCase())])].filter((a) => a !== k && KEY_RE.test(a));
  reg.projects[k] = { paths: [...new Set([...cur.paths, ...abs])], ...(al.length ? { aliases: al } : {}) };
  atomicWriteJSON(PROJECT_REGISTRY_PATH, reg, { pretty: true });
  cache = null;
  return reg;
}

export function removeProject(key: string): boolean {
  const k = key.toLowerCase();
  const reg = readProjectRegistry();
  if (!reg.projects[k]) return false;
  delete reg.projects[k];
  atomicWriteJSON(PROJECT_REGISTRY_PATH, reg, { pretty: true });
  cache = null;
  return true;
}

/** 등록부에 적힌 폴더 중 지금 없는 것 (doctor 용). */
export function missingRegistryPaths(): Array<{ key: string; path: string }> {
  const out: Array<{ key: string; path: string }> = [];
  for (const [key, e] of Object.entries(readProjectRegistry().projects)) for (const p of e.paths) if (!fs.existsSync(p)) out.push({ key, path: p });
  return out;
}
