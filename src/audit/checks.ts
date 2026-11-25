/**
 * 결정적 검사 (docs/plans/2026-11-25-v1.0-plan.md §4.1 중 모델이 필요 없는 것).
 *   잘림 · 크기·토큰 · 같은 문장 · 낡음(가리키는 파일·링크·npm 스크립트가 지금 없음) · 다른 프로젝트 섞임 후보 · paths: 없는 룰
 * 같은 뜻 중복·부딪힘·섞임 확정은 모델 판정이라 model-checks.ts 가 한다. 여기서는 후보만 낸다.
 * 입력은 sources.ts 가 읽은 것뿐이고, 결과는 경로·줄 순으로 정렬해 같은 원천이면 같은 결과가 나온다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { splitFrontmatter, MEMORY_MAX_BYTES, MEMORY_MAX_LINES, type Layer, type MemoryDir, type SourceFile } from './sources.js';
import { estimateTokens } from './tokens.js';

export type UnitLayer = Layer | 'forgen-rule';

/** 비교 단위 — 지시 한 줄(마크다운) 또는 forgen 룰 하나. */
export interface Unit {
  text: string;
  norm: string;
  path: string;
  line: number;
  layer: UnitLayer;
  ruleId?: string;
  tokens: number;
  /** 메모 주제 파일이면 앞머리 type(feedback 등). */
  memoryType?: string;
}

const byLoc = (a: { path: string; line: number }, b: { path: string; line: number }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line);

/** 같은 문장 비교용 정규화: 목록 표지·강조·링크 주소·문장부호·공백을 걷고 소문자로. */
export function normalizeSentence(s: string): string {
  return s
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~>#]/g, '')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 마크다운 파일의 지시 줄(앞머리·코드 블록·제목·표 구분선·빈 줄 제외). */
export function markdownUnits(sf: SourceFile, layer: Layer, maxLine = Infinity): Unit[] {
  if (sf.error) return [];
  const { body, bodyStartLine } = splitFrontmatter(sf.text);
  const out: Unit[] = [];
  let fence = false;
  body.split('\n').forEach((raw, i) => {
    const line = bodyStartLine + i;
    if (line > maxLine) return;
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
    const t = raw.trim();
    if (fence || !t || t.startsWith('#') || /^\|?[\s:|-]+\|?$/.test(t) || t.startsWith('<!--')) return;
    out.push({ text: t, norm: normalizeSentence(t), path: sf.path, line, layer, tokens: estimateTokens(raw) });
  });
  return out;
}

// ── 잘림 ──

export interface TruncationResult {
  dir: string;
  folder: string | null;
  lines: number;
  bytes: number;
  loadedLines: number;
  overLines: boolean;
  overBytes: boolean;
  /** 잘려서 세션 시작에 안 실리는 색인 줄. */
  cutItems: Array<{ line: number; text: string }>;
  spareLines: number;
  spareBytes: number;
  /** 줄 평균 바이트로 어림한 남은 색인 항목 수(줄·바이트 중 먼저 닿는 쪽). */
  spareItems: number;
  /** 어느 상한이 먼저 오나. */
  firstLimit: 'lines' | 'bytes';
  /** MEMORY.md 색인에서 가리키지 않는 주제 파일(세션 시작에 존재가 안 알려짐). */
  unindexedTopics: string[];
}

export function checkTruncation(m: MemoryDir): TruncationResult | null {
  if (!m.index || m.index.error) return null;
  const lines = m.index.text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const cutItems = lines.slice(m.loadedLines).map((t, i) => ({ line: m.loadedLines + i + 1, text: t.trim() })).filter((x) => x.text && !x.text.startsWith('#'));
  const itemLines = lines.filter((l) => l.trim().startsWith('-'));
  const avg = itemLines.length ? itemLines.reduce((n, l) => n + Buffer.byteLength(`${l}\n`), 0) / itemLines.length : 120;
  const spareLines = Math.max(0, MEMORY_MAX_LINES - lines.length);
  const spareBytes = Math.max(0, MEMORY_MAX_BYTES - m.index.bytes);
  const byBytes = Math.floor(spareBytes / avg);
  const linked = new Set<string>();
  for (const l of lines) for (const mm of l.matchAll(/\]\(([^)\s#]+)\)/g)) linked.add(path.basename(mm[1]));
  return {
    dir: m.dir, folder: m.folder, lines: lines.length, bytes: m.index.bytes, loadedLines: m.loadedLines,
    overLines: lines.length > MEMORY_MAX_LINES, overBytes: m.index.bytes > MEMORY_MAX_BYTES, cutItems,
    spareLines, spareBytes, spareItems: Math.min(spareLines, byBytes), firstLimit: byBytes < spareLines ? 'bytes' : 'lines',
    unindexedTopics: m.topics.map((t) => path.basename(t.path)).filter((n) => !linked.has(n)).sort(),
  };
}

// ── 같은 문장 ──

export interface SameSentenceGroup {
  text: string;
  norm: string;
  occurrences: Array<{ path: string; line: number; layer: UnitLayer; ruleId?: string }>;
  tokens: number;
}

/** 정규화 문장이 같은 것이 서로 다른 파일(또는 룰)에 두 번 이상. 짧은 줄(20자 미만)은 보지 않는다. */
export function checkSameSentence(units: Unit[]): SameSentenceGroup[] {
  const groups = new Map<string, Unit[]>();
  for (const u of [...units].sort(byLoc)) {
    if (u.norm.length < 20) continue;
    const g = groups.get(u.norm);
    if (g) g.push(u); else groups.set(u.norm, [u]);
  }
  const out: SameSentenceGroup[] = [];
  for (const [norm, us] of groups) {
    const files = new Set(us.map((u) => u.ruleId ?? u.path));
    if (files.size < 2) continue;
    const occ = us.map((u) => ({ path: u.path, line: u.line, layer: u.layer, ...(u.ruleId ? { ruleId: u.ruleId } : {}) })).sort(byLoc);
    out.push({ text: us[0].text, norm, occurrences: occ, tokens: Math.max(...us.map((u) => u.tokens)) });
  }
  return out.sort((a, b) => (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0));
}

// ── 낡음 ──

export interface StaleRef {
  path: string;
  line: number;
  layer: UnitLayer;
  ruleId?: string;
  kind: 'file' | 'link' | 'npm-script';
  ref: string;
  text: string;
  tokens: number;
}

const PLACEHOLDER = /[<>*{}$|]|\.\.\.|…|\/path\/to\b|\bexample\b|\byour[-_]|\bfoo\b|\bxxx\b/i;
const VIRTUAL = /^\/(?:dev|proc|sys|run)\//;

function exists(p: string): boolean {
  try { fs.statSync(p); return true; } catch { return false; }
}

function nearestPackageScripts(dir: string, cache: Map<string, Set<string> | null>): Set<string> | null {
  for (let d = dir; ; d = path.dirname(d)) {
    const cached = cache.get(d);
    if (cached !== undefined) return cached;
    const pj = path.join(d, 'package.json');
    if (exists(pj)) {
      let scripts: Set<string> | null = null;
      try { scripts = new Set(Object.keys((JSON.parse(fs.readFileSync(pj, 'utf-8')) as { scripts?: Record<string, string> }).scripts ?? {})); } catch { scripts = null; }
      cache.set(d, scripts);
      return scripts;
    }
    if (d === path.dirname(d)) { cache.set(d, null); return null; }
  }
}

/** 실행 중에만 생기는 파일(임시 폴더·pid·소켓·잠금)은 없어도 낡은 것이 아니다. */
const EPHEMERAL = /^\/tmp\/|^\/var\/(?:run|tmp)\/|\.(?:pid|sock|lock)$/;

/**
 * 지금 없는 것을 가리키는 줄. 결정적인 것만 본다:
 *   - 절대 경로(맨 앞 폴더가 실제로 있을 때만 — `/apps/x` 같은 URL·저장소 기준 표기는 건너뜀)·`~/` 경로
 *   - 마크다운 링크의 상대 경로(그 파일 기준, 없으면 그 기억의 프로젝트 폴더 기준)
 *   - 프로젝트 층의 백틱 상대 경로(맨 앞 폴더는 있는데 파일이 없을 때만)
 *   - `npm run <x>` 인데 그 기억의 프로젝트 package.json 에 그 스크립트가 없음
 * 자리 표시(<…>, *, /path/to)·가상 파일 시스템·임시 파일은 보지 않는다.
 */
export function checkStale(units: Unit[], opts: { home: string; projectDirOf: (u: Unit) => string | null }): StaleRef[] {
  const out: StaleRef[] = [];
  const pkgCache = new Map<string, Set<string> | null>();
  const firstSegExists = (root: string, ref: string) => { const seg = ref.split('/').filter(Boolean)[0]; return !!seg && exists(path.join(root, seg)); };
  for (const u of units) {
    const seen = new Set<string>();
    const add = (kind: StaleRef['kind'], ref: string) => {
      if (seen.has(`${kind}:${ref}`)) return;
      seen.add(`${kind}:${ref}`);
      out.push({ path: u.path, line: u.line, layer: u.layer, ...(u.ruleId ? { ruleId: u.ruleId } : {}), kind, ref, text: u.text, tokens: u.tokens });
    };
    const base = u.layer === 'forgen-rule' ? null : path.dirname(u.path);
    const proj = opts.projectDirOf(u);
    // 마크다운 링크
    for (const m of u.text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || PLACEHOLDER.test(target) || !base) continue;
      let rel = target;
      try { rel = decodeURI(target); } catch { /* 그대로 */ }
      const abs = rel.startsWith('~/') ? path.join(opts.home, rel.slice(2)) : path.isAbsolute(rel) ? rel : path.resolve(base, rel);
      if (exists(abs)) continue;
      if (proj && !path.isAbsolute(rel) && exists(path.resolve(proj, rel.replace(/^(?:\.\.?\/)+/, '')))) continue;
      add('link', target);
    }
    // 절대·홈 경로 (링크 주소 부분은 위에서 봤으므로 지운다)
    const plain = u.text.replace(/\]\([^)]*\)/g, ']');
    for (const m of plain.matchAll(/(?:^|[\s`'"(=:])((?:~\/|\/)[A-Za-z0-9._@+\-/]*[A-Za-z0-9_\-/])/g)) {
      const ref = m[1];
      if (ref.startsWith('//') || PLACEHOLDER.test(ref) || VIRTUAL.test(ref) || EPHEMERAL.test(ref)) continue;
      if (ref.replace(/^~\//, '').split('/').filter(Boolean).length < 2) continue;
      if (ref.startsWith('~/')) { if (!exists(path.join(opts.home, ref.slice(2)))) add('file', ref); continue; }
      if (exists(ref)) continue;
      if (firstSegExists('/', ref)) add('file', ref);
    }
    // 프로젝트 층의 백틱 상대 경로
    const projectLayer = u.layer === 'project' || u.layer === 'project-local' || u.layer === 'project-rules' || u.layer === 'agents';
    if (base && projectLayer) {
      for (const m of u.text.matchAll(/`([A-Za-z0-9_][A-Za-z0-9._\-/]*\/[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,6})`/g)) {
        const ref = m[1];
        if (PLACEHOLDER.test(ref) || ref.startsWith('node_modules/')) continue;
        const roots = [base, proj].filter((x): x is string => !!x);
        if (roots.some((r) => exists(path.resolve(r, ref)))) continue;
        if (roots.some((r) => firstSegExists(r, ref))) add('file', ref);
      }
    }
    // npm run <스크립트>
    if (proj) {
      for (const m of u.text.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) {
        const scripts = nearestPackageScripts(proj, pkgCache);
        if (scripts && !scripts.has(m[1])) add('npm-script', `npm run ${m[1]}`);
      }
    }
  }
  return out.sort((a, b) => byLoc(a, b) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

// ── 다른 프로젝트 섞임 후보 ──

export interface MixCandidate {
  path: string;
  line: number;
  layer: UnitLayer;
  ruleId?: string;
  text: string;
  /** 이 지시가 속해 보이는 프로젝트(하나일 때만). */
  project: string | null;
  why: string[];
  tokens: number;
}

/** 두 신호를 한 줄로 합친다(같은 위치). 결정적 신호뿐이라 "후보"다 — 내용 판정은 모델(다음 덩어리). */
export function mergeMixCandidates(list: MixCandidate[]): MixCandidate[] {
  const m = new Map<string, MixCandidate>();
  for (const c of list) {
    const k = `${c.ruleId ?? c.path}\u0000${c.line}`;
    const prev = m.get(k);
    if (!prev) { m.set(k, { ...c, why: [...c.why] }); continue; }
    for (const w of c.why) if (!prev.why.includes(w)) prev.why.push(w);
    if (!prev.project && c.project) prev.project = c.project;
  }
  return [...m.values()].map((c) => ({ ...c, why: c.why.sort() })).sort(byLoc);
}

// ── paths: 없는 .claude/rules ──

export interface UnscopedRule { path: string; layer: Layer; tokens: number; lines: number; folders: number }
