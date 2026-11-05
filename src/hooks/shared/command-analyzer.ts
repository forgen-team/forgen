/**
 * Command analyzer — 셸 명령을 실제로 파싱해 "실행되는 위험 동작"만 찾는다 (D12).
 *
 * 정규식을 명령 문자열 전체에 대던 방식은 두 방향으로 틀렸다.
 *  - 미탐: `rm -r -f x`, `rm -fr`, `bash -c "rm -rf x"`, `xargs rm -rf`, `find -delete`, `shutil.rmtree` 통과.
 *  - 오탐: `echo pre_mkfs foo`, `grep "DROP TABLE" f`, 커밋 메시지 속 rm -rf 가 차단.
 * 여기서는 따옴표·heredoc·주석·치환($(), 백틱, <())을 구분하는 토크나이저로 문장을 나눈 뒤,
 * 명령어 단어(래퍼 sudo/env/nohup… 벗김)별로 의미를 해석한다. 실행 문맥(bash -c, eval, xargs, find -exec,
 * python -c 안의 문자열)은 재귀 해석하고, 데이터 문맥(echo, grep, git commit -m)은 해석하지 않는다.
 *
 * 한계(정직하게): 외부 스크립트 파일 내용, 별칭, 난독화는 다 해석하지 못한다. 이 hook 은 사고 방지 장치이므로
 * **판별할 수 없으면 통과시키지 않고 확인(ask)** 한다: 명령어 자리의 변수·치환 + 위험 인자, `| sh`, `<<<` → 셸,
 * `sh -c "$(…)"`, 입력 길이·깊이·작업량 상한 초과, 분석 중 예외.
 */
import { isClaudeTempPath } from './command-parser.js';

export type FindingAction = 'block' | 'deny' | 'ask' | 'warn';
export interface CommandFinding {
  id: string;
  action: FindingAction;
  description: string;
  targets?: string[];
}
export interface GitOp {
  sub: string;
  args: string[];
  /** `git -C <dir>` 값 (있으면). */
  dir?: string;
  /** 문장 시점의 cwd (같은 명령 안 `cd` 반영). */
  cwd: string;
}
export interface AnalysisResult {
  findings: CommandFinding[];
  /** git add/commit/push 호출 — commit-guard 가 실제 staged 내용을 확인하는 데 쓴다. */
  gitOps: GitOp[];
  /** SQL 로 실행될 수 있는 텍스트(DB CLI 인자·heredoc·파이프 입력, python/node -c 코드). */
  sqlTexts: string[];
}
export interface AnalyzeOptions { cwd?: string; home?: string }

interface Word { text: string; quoted: boolean; dynamic: boolean }
/** 입력 길이 상한 — 초과는 분석하지 않고 ask (fail-open 금지). pre-tool-use 의 정규식 경로도 같은 상한을 쓴다. */
export const MAX_COMMAND_LENGTH = 50_000;
const WORK_BUDGET = 3_000_000;
class LimitError extends Error {}
let budget = Infinity;
function spend(n = 1): void { if ((budget -= n) < 0) throw new LimitError('work budget exceeded'); }
interface Stmt {
  words: Word[];
  sepBefore: string;
  heredocs: string[];
  subs: string[];
  procSubs: string[];
  hereStrings: Word[];
}

const MAX_DEPTH = 6;

function newStmt(sepBefore: string): Stmt {
  return { words: [], sepBefore, heredocs: [], subs: [], procSubs: [], hereStrings: [] };
}

/** `(`·`$(` 의 짝 `)` 위치를 찾는다 (따옴표 인식). 못 찾으면 src.length. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    spend();
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); if (j < 0) return src.length; i = j; continue; }
    if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) { spend(); if (src[i] === '\\') i++; }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return src.length;
}

export function tokenize(src: string): Stmt[] {
  const stmts: Stmt[] = [];
  let cur = newStmt('');
  let buf = '';
  let inWord = false;
  let quoted = false;
  let dyn = false;
  const pending: Array<{ delim: string; strip: boolean; stmt: Stmt }> = [];
  const pushWord = () => {
    if (!inWord) return;
    cur.words.push({ text: buf, quoted, dynamic: dyn });
    buf = ''; inWord = false; quoted = false; dyn = false;
  };
  const endStmt = (sep: string) => {
    pushWord();
    if (cur.words.length || cur.heredocs.length || pending.some((p) => p.stmt === cur)) stmts.push(cur);
    cur = newStmt(sep);
  };
  let i = 0;
  while (i < src.length) {
    spend();
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 < src.length) { buf += src[i + 1]; inWord = true; quoted = true; }
      i += 2; continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      buf += src.slice(i + 1, end); inWord = true; quoted = true;
      i = end + 1; continue;
    }
    if (c === '"') {
      inWord = true; quoted = true;
      i++;
      while (i < src.length && src[i] !== '"') {
        spend();
        const d = src[i];
        if (d === '\\' && i + 1 < src.length) {
          const n = src[i + 1];
          buf += '$"\\`'.includes(n) ? n : `\\${n}`;
          i += 2; continue;
        }
        if (d === '$' && src[i + 1] === '(' && src[i + 2] !== '(') {
          const e = matchParen(src, i + 1);
          cur.subs.push(src.slice(i + 2, e));
          buf += '$()'; dyn = true; i = e + 1; continue;
        }
        if (d === '`') {
          let e = i + 1;
          while (e < src.length && src[e] !== '`') { if (src[e] === '\\') e++; e++; }
          cur.subs.push(src.slice(i + 1, e));
          buf += '$()'; dyn = true; i = e + 1; continue;
        }
        if (d === '$') dyn = true;
        buf += d; i++;
      }
      i++; continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      if (src[i + 2] === '(') { // 산술 $(( ))
        const e = src.indexOf('))', i);
        buf += '$(())'; inWord = true; dyn = true;
        i = e < 0 ? src.length : e + 2; continue;
      }
      const e = matchParen(src, i + 1);
      cur.subs.push(src.slice(i + 2, e));
      buf += '$()'; inWord = true; dyn = true; i = e + 1; continue;
    }
    if (c === '`') {
      let e = i + 1;
      while (e < src.length && src[e] !== '`') { if (src[e] === '\\') e++; e++; }
      cur.subs.push(src.slice(i + 1, e));
      buf += '$()'; inWord = true; dyn = true; i = e + 1; continue;
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      const e = matchParen(src, i + 1);
      cur.procSubs.push(src.slice(i + 2, e));
      buf += `${c}()`; inWord = true; i = e + 1; continue;
    }
    if (c === '$') { buf += c; inWord = true; dyn = true; i++; continue; }
    if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { pushWord(); i++; continue; }
    if (c === '\n') {
      endStmt('\n');
      i++;
      for (const p of pending.splice(0)) {
        const lines: string[] = [];
        while (i < src.length) {
          spend();
          let e = src.indexOf('\n', i);
          if (e < 0) e = src.length;
          const line = src.slice(i, e);
          i = Math.min(e + 1, src.length);
          if ((p.strip ? line.replace(/^\t+/, '') : line).trim() === p.delim) break;
          lines.push(line);
        }
        p.stmt.heredocs.push(lines.join('\n'));
      }
      continue;
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<' && !inWord) {
      let j = i + 2;
      const strip = src[j] === '-';
      if (strip) j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      let delim = '';
      if (src[j] === "'" || src[j] === '"') {
        const q = src[j]; const e = src.indexOf(q, j + 1);
        delim = src.slice(j + 1, e < 0 ? src.length : e); j = (e < 0 ? src.length : e) + 1;
      } else {
        while (j < src.length && !/[\s;&|<>()]/.test(src[j])) { delim += src[j] === '\\' ? '' : src[j]; j++; }
      }
      pending.push({ delim, strip, stmt: cur });
      i = j; continue;
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] === '<') { pushWord(); cur.words.push({ text: '<<<', quoted: false, dynamic: false }); i += 3; continue; }
    if (c === ';') { endStmt(';'); i += src[i + 1] === ';' ? 2 : 1; continue; }
    if (c === '&') {
      if (src[i + 1] === '&') { endStmt('&&'); i += 2; continue; }
      if (buf.endsWith('>') || buf.endsWith('<') || src[i + 1] === '>') { buf += c; inWord = true; i++; continue; }
      endStmt('&'); i++; continue;
    }
    if (c === '|') {
      if (src[i + 1] === '|') { endStmt('||'); i += 2; continue; }
      if (buf.endsWith('>')) { buf += c; inWord = true; i++; continue; }
      endStmt('|'); i += src[i + 1] === '&' ? 2 : 1; continue;
    }
    if ((c === '(' || c === ')') && !inWord) { if (c === ')') endStmt(';'); i++; continue; }
    buf += c; inWord = true; i++;
  }
  endStmt('');
  return stmts;
}

interface Ctx { vars: Map<string, string>; cwd: string; home: string; depth: number }

function expandVars(s: string, vars: Map<string, string>): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, a, b) => {
    const v = vars.get(a ?? b);
    return v === undefined ? whole : v;
  });
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh']);
const DB_CLIS = new Set(['psql', 'mysql', 'mariadb', 'sqlite', 'sqlite3', 'pg_restore', 'mongosh', 'mongo', 'cockroach', 'redis-cli', 'sqlcmd', 'clickhouse-client', 'duckdb', 'usql']);
const SCRIPT_EVAL: Record<string, string[]> = {
  python: ['-c'], python2: ['-c'], python3: ['-c'], node: ['-e', '--eval', '-p'], nodejs: ['-e', '--eval'],
  perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'], deno: ['eval'], bun: ['-e'],
};
const REMOTE_RUNNERS = new Set(['ssh', 'docker', 'podman', 'kubectl', 'nsenter', 'chroot', 'su', 'watch', 'parallel', 'flock', 'script', 'unshare', 'systemd-run', 'nix-shell']);
const KNOWN_CMDS = new Set(['rm', 'find', 'git', 'xargs', 'dd', 'mv', 'tee', 'truncate', 'shred', 'wipefs', 'unlink', 'chmod', 'chown', 'chgrp', ...SHELLS, ...DB_CLIS]);
const FUNC_HEADER_RE = /^[A-Za-z_][\w.:-]*\(\)\{?$/;
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done', 'esac', 'function', 'select']);
const FIND_FILTERS = /^-(i?name|i?path|i?regex|type|mtime|mmin|atime|ctime|newer|user|group|size|empty|perm|iname|maxdepth)$/;

/** 정체 불명 명령(`$X`, `$(…)`) 뒤에 오면 위험해 보이는 인자: 재귀/강제 플래그 조합, 루트·홈·시스템 경로, -delete. */
function isDangerousArgForUnknownCmd(a: string, home: string): boolean {
  if (/^-[a-zA-Z]*[rR][a-zA-Z]*[fF]|^-[a-zA-Z]*[fF][a-zA-Z]*[rR]/.test(a)) return true;
  if (a === '--recursive' || a === '--force' || a === '--no-preserve-root' || a === '-delete') return true;
  const x = home && (a === '~' || a.startsWith('~/')) ? home + a.slice(1) : a;
  const t = x.replace(/\/+$/, '').replace(/\/\*$/, '') || '/';
  if (t === '/' || t === '~' || /^\$\{?(HOME|USERPROFILE)\}?$/.test(t) || (home && t === home)) return true;
  return SYSTEM_PREFIX_RE.test(t) && !SAFE_DEVICE_RE.test(t) && !/^\/var\/(tmp|folders)(\/|$)/.test(t);
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

const DELETE_CODE_RE = /shutil\s*\.\s*rmtree|\bos\s*\.\s*(remove|unlink|rmdir|removedirs)\b|\.(unlink|rmdir)\s*\(|\.\s*(rmSync|rmdirSync|unlinkSync)\b|\bfs\s*\.\s*(promises\s*\.\s*)?(rm|rmdir|unlink)\b|\brimraf\b|FileUtils\s*\.\s*(rm_rf|rm_r|rm_f|remove_dir|remove_entry)|\bFile\s*\.\s*delete\b|\bunlink\s*[(\s]|\brmtree\b|remove_tree|File::Path/;
const RM_IN_CODE_RE = /\brm\s+-[a-zA-Z]*[rR]|["']rm["']\s*,\s*["']-[a-zA-Z]*[rR]|--recursive/;
const SQL_PATH_LITERAL_RE = /(["'])(\/[^"'\s]*)\1/g;

type Target = { text: string; dynamic: boolean };

/** 쓰기가 무해한 가짜 장치. */
const SAFE_DEVICE_RE = /^\/(dev\/(null|zero|full|random|urandom|stdin|stdout|stderr|tty|fd\/\d+|pts\/\d+)|proc\/(self|\d+)\/fd\/\d+)$/;
/** 홈 아래에서 덮어쓰면 로그인·인증이 망가지는 경로. */
const HOME_CRITICAL_RE = /^(\.bashrc|\.bash_profile|\.bash_login|\.zshrc|\.zshenv|\.zprofile|\.profile|\.ssh|\.gnupg)(\/|$)/;
const SYSTEM_PREFIX_RE = /^\/(etc|usr|var|bin|sbin|lib|lib32|lib64|boot|dev|proc|sys|root|System|Library|Applications|opt\/homebrew)(\/|$)/;

function normalizeAbs(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

function classifyTargets(targets: Target[], ctx: Ctx, filtered: boolean): { action: 'deny' | 'ask' | 'pass'; reason: string; list: string[] } {
  const list = targets.map((t) => t.text);
  if (targets.length === 0) return { action: 'pass', reason: '', list };
  let worst: 'deny' | 'ask' | 'pass' = 'pass';
  let reason = '';
  const raise = (a: 'deny' | 'ask', r: string) => {
    const eff = filtered && a === 'deny' ? 'ask' : a;
    if (eff === 'deny' || (eff === 'ask' && worst === 'pass')) { worst = eff; reason = r; }
  };
  const home = ctx.home.replace(/\/+$/, '');
  for (const t of targets) {
    let x = expandVars(t.text, ctx.vars).replace(/^["']|["']$/g, '');
    if (home && (x === '~' || x.startsWith('~/'))) x = home + x.slice(1);
    if (/(^|\/)\.\.(\/|$)/.test(x) && /^\/?(tmp|private\/tmp|var\/tmp|var\/folders)(\/|$)/.test(x)) { raise('deny', 'path traversal out of a temp path'); continue; }
    if (x.startsWith('/') && /(^|\/)\.\.(\/|$)/.test(x)) x = normalizeAbs(x);
    const stripped = x.replace(/\/+$/, '') || '/';
    const noGlob = stripped.replace(/\/\*+$/, '') || '/';
    if (x.includes('$')) {
      if (/^\$\{?(HOME|USERPROFILE)\}?(\/\*?)?$/.test(x)) { raise('deny', 'home directory'); continue; }
      raise('ask', 'unresolved target'); continue;
    }
    if (noGlob === '/' || x === '/*') { raise('deny', 'filesystem root'); continue; }
    if (noGlob === home || (home && stripped === home)) { raise('deny', 'home directory'); continue; }
    if (x === '.' || x === '..' || x === './' || x === './.' || x === '.*') { raise('deny', 'current/parent directory'); continue; }
    if (SYSTEM_PREFIX_RE.test(noGlob) && !SAFE_DEVICE_RE.test(noGlob) && !/^\/var\/(tmp|folders)(\/|$)/.test(noGlob)) { raise('deny', 'system directory'); continue; }
    if (home && noGlob.startsWith(`${home}/`) && HOME_CRITICAL_RE.test(noGlob.slice(home.length + 1))) { raise('deny', 'home shell-config/credentials path'); continue; }
    if (noGlob === '/tmp' || noGlob === '/var/tmp') { raise('ask', 'shared temp root'); continue; }
    if (/^\/[^/]+$/.test(noGlob) || /^\/(home|Users)\/[^/]+$/.test(noGlob)) { raise('deny', 'system or home root path'); continue; }
    if (/[*?[\]{}`]/.test(x)) {
      // 임시 경로 아래의 glob/치환은 isClaudeTempPath 가 보수적으로 거부 → 확인 요청
      raise('ask', 'glob or substitution in target'); continue;
    }
    const base = ctx.cwd;
    if (!isClaudeTempPath(x, base)) raise('ask', 'non-temporary path');
  }
  return { action: worst, reason, list };
}

function emitDelete(id: string, label: string, targets: Target[], ctx: Ctx, out: AnalysisResult, filtered = false): void {
  if (targets.length === 0) return;
  const v = classifyTargets(targets, ctx, filtered);
  if (v.action === 'pass') return;
  out.findings.push({
    id, action: v.action, targets: v.list,
    description: v.action === 'deny' ? `${label} on ${v.reason}` : `${label} — ${v.reason}: ${v.list.slice(0, 4).join(' ')}`,
  });
}

/**
 * 파괴적 쓰기/이동 계열. 시스템·홈 경로 대상은 deny. askOther 면 그 외(비임시) 경로는 ask, 아니면 통과
 * (tee·리다이렉트처럼 흔한 쓰기는 위험 경로만 본다). 해석 안 되는 `$VAR` 대상은 askOther 일 때만 ask.
 */
function emitWrite(id: string, label: string, targets: Target[], ctx: Ctx, out: AnalysisResult, askOther: boolean): void {
  if (targets.length === 0) return;
  const usable = askOther ? targets : targets.filter((t) => !expandVars(t.text, ctx.vars).includes('$') && !SAFE_DEVICE_RE.test(t.text));
  if (usable.length === 0) return;
  const v = classifyTargets(usable, ctx, false);
  if (v.action === 'deny') out.findings.push({ id, action: 'deny', targets: v.list, description: `${label} on ${v.reason}` });
  else if (v.action === 'ask' && askOther) out.findings.push({ id, action: 'ask', targets: v.list, description: `${label} — ${v.reason}: ${v.list.slice(0, 4).join(' ')}` });
}

function pushFinding(out: AnalysisResult, f: CommandFinding): void {
  if (out.findings.length < 200 && !out.findings.some((x) => x.id === f.id && x.description === f.description)) out.findings.push(f);
}

function walk(src: string, ctx: Ctx, out: AnalysisResult): void {
  if (!src.trim()) return;
  if (ctx.depth > MAX_DEPTH) { pushFinding(out, { id: 'analysis-limit', action: 'ask', description: 'command nested too deeply to analyze' }); return; }
  spend(10);
  const stmts = tokenize(src);
  for (let idx = 0; idx < stmts.length; idx++) {
    const st = stmts[idx];
    const sub: Ctx = { ...ctx, depth: ctx.depth + 1 };
    for (const s of st.subs) walk(s, sub, out);
    for (const s of st.procSubs) {
      walk(s, sub, out);
      if (/\b(curl|wget)\b/.test(s) && st.words.length && SHELLS.has(baseName(st.words[0].text))) {
        out.findings.push({ id: 'pipe-to-shell', action: 'block', description: 'download piped to shell (process substitution)' });
      }
    }
    analyzeStmt(stmts, idx, ctx, out);
  }
}

function analyzeStmt(stmts: Stmt[], idx: number, ctx: Ctx, out: AnalysisResult): void {
  const st = stmts[idx];
  const words = st.words.slice();
  // 리다이렉트 분리 + 장치 쓰기 탐지
  const args: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.quoted && w.text === '<<<') { if (i + 1 < words.length) { st.hereStrings.push(words[i + 1]); i++; } continue; }
    const m = !w.quoted ? /^(?:\d*|&)(>>?|>\||<)(.*)$/.exec(w.text) : null;
    if (m) {
      let target = m[2];
      if (!target && i + 1 < words.length) { target = words[i + 1].text; i++; }
      if (m[1] !== '<' && /^\/dev\/(sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|mmcblk\d|disk\d)/.test(target)) {
        out.findings.push({ id: 'device-write', action: 'block', description: 'write to block device' });
      } else if (m[1] !== '<' && target && !target.startsWith('&')) {
        emitWrite('redirect-write', 'redirect write', [{ text: target, dynamic: false }], ctx, out, false);
      }
      continue;
    }
    if (!w.quoted && w.text === '<<') { i++; continue; }
    args.push(w);
  }
  analyzeWords(args, stmts, idx, ctx, out);
}

function isAssign(w: Word): RegExpExecArray | null {
  return /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w.text);
}

function analyzeWords(wordsIn: Word[], stmts: Stmt[] | null, idx: number, ctx: Ctx, out: AnalysisResult, extraStdin = false): void {
  if (ctx.depth > MAX_DEPTH) { pushFinding(out, { id: 'analysis-limit', action: 'ask', description: 'command nested too deeply to analyze' }); return; }
  const st = stmts ? stmts[idx] : null;
  const words = wordsIn.slice();
  // 선행 대입
  const assigned: Array<[string, string]> = [];
  while (words.length && isAssign(words[0])) {
    const m = isAssign(words[0])!;
    assigned.push([m[1], expandVars(m[2], ctx.vars)]);
    words.shift();
  }
  if (words.length === 0) { for (const [k, v] of assigned) ctx.vars.set(k, v); return; }
  // 제어 키워드·래퍼 벗기기
  for (let guard = 0; guard < 12 && words.length; guard++) {
    // 명령어 자리 변수가 같은 명령 앞에서 대입된 값이면 치환해서 계속 해석 (`X=rm; $X -rf y`)
    if (words[0].dynamic && /^\$\{?[A-Za-z_]/.test(words[0].text)) {
      const ex = expandVars(words[0].text, ctx.vars);
      if (ex !== words[0].text && !ex.includes('$')) {
        words.splice(0, 1, ...ex.split(/\s+/).filter(Boolean).map((t) => ({ text: t, quoted: false, dynamic: false })));
        if (!words.length) return;
      }
    }
    const w0 = words[0].text;
    const b = baseName(w0);
    if (FUNC_HEADER_RE.test(w0)) { words.shift(); continue; } // `f(){ …` / `f() { …` — 본문을 분석한다
    if (w0 === 'function') { words.shift(); words.shift(); continue; }
    if (KEYWORDS.has(w0)) { words.shift(); continue; }
    if (b === 'sudo' || b === 'doas') {
      words.shift();
      while (words.length && words[0].text.startsWith('-')) {
        const o = words.shift()!.text;
        if (/^-[ughpCDRTU]$/.test(o) && words.length) words.shift();
      }
      continue;
    }
    if (b === 'env') {
      words.shift();
      while (words.length && (words[0].text.startsWith('-') || isAssign(words[0]))) {
        const o = words.shift()!.text;
        if ((o === '-u' || o === '-C' || o === '-S') && words.length) words.shift();
      }
      continue;
    }
    if (b === 'command' || b === 'builtin' || b === 'exec' || b === 'nohup' || b === 'time' || b === 'setsid' || b === 'stdbuf' || b === 'unbuffer' || b === 'busybox') {
      words.shift();
      while (words.length && words[0].text.startsWith('-')) words.shift();
      continue;
    }
    if (b === 'nice' || b === 'ionice') {
      words.shift();
      while (words.length && words[0].text.startsWith('-')) { const o = words.shift()!.text; if ((o === '-n' || o === '-c') && words.length) words.shift(); }
      continue;
    }
    if (b === 'timeout') {
      words.shift();
      while (words.length && words[0].text.startsWith('-')) { const o = words.shift()!.text; if ((o === '-s' || o === '-k') && words.length) words.shift(); }
      if (words.length) words.shift(); // duration
      continue;
    }
    break;
  }
  if (words.length === 0) return;
  const cmd = baseName(words[0].text);
  const rest = words.slice(1);
  const restText = rest.map((w) => w.text);
  const sub: Ctx = { ...ctx, depth: ctx.depth + 1 };

  // 명령어 자리가 해석 안 되는 변수·치환이면 무엇을 실행하는지 알 수 없다 → 위험 인자가 함께 올 때만 ask
  // (`$HOME/bin/tool --flag`, `npm run $SCRIPT` 같은 정상 사용은 건드리지 않는다).
  if (words[0].dynamic && /^\$/.test(words[0].text) && words[0].text.includes('$')) {
    if (rest.some((w) => isDangerousArgForUnknownCmd(expandVars(w.text, ctx.vars), ctx.home))) {
      pushFinding(out, { id: 'dynamic-command', action: 'ask', description: `command name is a variable/substitution (${words[0].text}) with destructive-looking arguments: ${restText.slice(0, 4).join(' ')}` });
    }
    return;
  }

  if (cmd === 'cd') {
    const d = rest.find((w) => !w.text.startsWith('-'));
    if (d && !d.dynamic) {
      const x = expandVars(d.text, ctx.vars);
      ctx.cwd = x.startsWith('/') ? x : ctx.cwd ? `${ctx.cwd}/${x}` : '';
    } else ctx.cwd = '';
    return;
  }

  if (cmd === 'rm') {
    let recursive = false;
    let afterDD = false;
    const targets: Target[] = [];
    for (const w of rest) {
      if (!afterDD && w.text === '--') { afterDD = true; continue; }
      if (!afterDD && w.text.startsWith('--')) { if (w.text === '--recursive') recursive = true; continue; }
      if (!afterDD && w.text.startsWith('-') && w.text.length > 1) { if (/[rR]/.test(w.text)) recursive = true; continue; }
      targets.push({ text: w.text, dynamic: w.dynamic });
    }
    if (extraStdin) targets.push({ text: '<stdin>', dynamic: true });
    if (recursive) emitDelete('rm-recursive', 'recursive rm', targets, ctx, out);
    return;
  }

  if (SHELLS.has(cmd)) {
    let script: string | null = null;
    let scriptWord: Word | null = null;
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i].text;
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(t) && i + 1 < rest.length) { scriptWord = rest[i + 1]; script = scriptWord.text; break; }
    }
    if (script !== null) {
      const ex = expandVars(script, ctx.vars);
      // `sh -c "$(curl …)"`, `bash -c "$CMD"` — 스크립트 본문이 통째로 동적이면 무엇을 실행하는지 알 수 없다
      if (scriptWord!.dynamic && /^\s*\$/.test(ex)) {
        pushFinding(out, { id: 'dynamic-shell-script', action: 'ask', description: `${cmd} -c with a script that is only known at run time (${script.slice(0, 40)})` });
      } else walk(ex, sub, out);
      return;
    }
    if (st) {
      for (const h of st.heredocs) walk(h, sub, out);
      for (const hs of st.hereStrings) {
        if (hs.dynamic) pushFinding(out, { id: 'dynamic-here-string', action: 'ask', description: `here-string with run-time content fed to ${cmd}` });
        else walk(hs.text, sub, out);
      }
      // 파이프로 흘러드는 입력(echo "…" | bash, curl … | sh) — 이 쉘이 stdin 을 스크립트로 읽을 때만
      const readsStdin = rest.every((w) => w.text.startsWith('-')) || rest.some((w) => w.text === '-s');
      if (st.sepBefore === '|' && idx > 0 && stmts) {
        const prev = stmts[idx - 1];
        const pc = prev.words.length ? baseName(prev.words[0].text) : '';
        if (pc === 'curl' || pc === 'wget') {
          out.findings.push({ id: 'pipe-to-shell', action: 'block', description: `${pc} piped to shell` });
        } else if (readsStdin) {
          const pargs = prev.words.slice(1);
          if (pc === 'echo' || pc === 'printf') {
            if (pargs.some((w) => w.dynamic) || prev.subs.length) pushFinding(out, { id: 'pipe-to-shell', action: 'ask', description: `run-time generated text piped to ${cmd}` });
            else walk([pargs.map((w) => w.text).join(' '), ...prev.heredocs].join('\n'), sub, out);
          } else if (pc === 'cat' && prev.heredocs.length && !pargs.some((w) => !w.text.startsWith('-'))) {
            for (const h of prev.heredocs) walk(h, sub, out);
          } else {
            pushFinding(out, { id: 'pipe-to-shell', action: 'ask', description: `output of ${pc || 'a command'} piped to ${cmd} — cannot tell what will run` });
          }
        }
      }
    }
    return;
  }

  if (cmd === 'eval') {
    out.findings.push({ id: 'eval-string', action: 'warn', description: 'eval with string (injection risk)' });
    walk(restText.join(' '), sub, out);
    return;
  }

  if (cmd === 'xargs') {
    let i = 0;
    while (i < rest.length && rest[i].text.startsWith('-')) {
      const o = rest[i].text;
      i += /^-[ILnPsdEaJRS]$/.test(o) ? 2 : 1;
    }
    if (i < rest.length) analyzeWords(rest.slice(i), null, 0, sub, out, true);
    return;
  }

  if (cmd === 'find') {
    const roots: Target[] = [];
    let i = 0;
    while (i < rest.length && !/^(-|\(|!)/.test(rest[i].text)) { roots.push({ text: rest[i].text, dynamic: rest[i].dynamic }); i++; }
    if (roots.length === 0) roots.push({ text: '.', dynamic: false });
    const filtered = rest.some((w) => FIND_FILTERS.test(w.text));
    for (; i < rest.length; i++) {
      const t = rest[i].text;
      if (t === '-delete') emitDelete('find-delete', 'find -delete', roots, ctx, out, filtered);
      if (/^-(exec|execdir|ok|okdir)$/.test(t)) {
        const inner: Word[] = [];
        let j = i + 1;
        for (; j < rest.length && rest[j].text !== ';' && rest[j].text !== '+'; j++) {
          if (rest[j].text === '{}') inner.push(...roots.map((r) => ({ text: r.text, quoted: false, dynamic: r.dynamic })));
          else inner.push(rest[j]);
        }
        if (inner.length && baseName(inner[0].text) === 'rm') {
          // find -exec rm 은 (플래그 없어도) 트리 아래를 지운다 → 재귀 삭제와 동일 취급
          const targets = inner.slice(1).filter((w) => !w.text.startsWith('-')).map((w) => ({ text: w.text, dynamic: w.dynamic }));
          emitDelete('find-exec-rm', 'find -exec rm', targets, ctx, out, filtered);
        } else if (inner.length) {
          analyzeWords(inner, null, 0, sub, out);
        }
        i = j;
      }
    }
    return;
  }

  if (cmd === 'git') {
    let i = 0;
    while (i < rest.length && rest[i].text.startsWith('-')) {
      i += /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/.test(rest[i].text) ? 2 : 1;
    }
    const sc = rest[i]?.text;
    const flags = restText.slice(i + 1);
    if (sc) {
      const cIdx = rest.slice(0, i).findIndex((w) => w.text === '-C');
      out.gitOps.push({ sub: sc, args: flags, cwd: ctx.cwd, ...(cIdx >= 0 && rest[cIdx + 1] ? { dir: rest[cIdx + 1].text } : {}) });
    }
    const short = flags.filter((f) => /^-[a-zA-Z]+$/.test(f)).join('');
    if (sc === 'reset' && flags.includes('--hard')) out.findings.push({ id: 'git-reset-hard', action: 'warn', description: 'git reset --hard' });
    if (sc === 'clean' && (/f/.test(short) || flags.includes('--force')) && !(/n/.test(short) || flags.includes('--dry-run'))) {
      out.findings.push({ id: 'git-clean', action: 'warn', description: 'git clean -f' });
    }
    if (sc === 'push') {
      const plusRef = flags.some((f) => /^\+[^\s+]/.test(f));
      if (flags.includes('--force') || /f/.test(short) || plusRef) {
        out.findings.push({ id: 'git-force-push', action: 'ask', description: `git push ${plusRef ? '+refspec' : '--force'} (rewrites remote history)` });
      } else if (flags.some((f) => f === '--mirror' || f === '--delete' || f === '-d')) {
        out.findings.push({ id: 'git-force-push', action: 'ask', description: `git push ${flags.find((f) => f === '--mirror' || f === '--delete' || f === '-d')} (deletes/overwrites remote refs)` });
      }
    }
    return;
  }

  if (cmd === 'mkfs' || cmd.startsWith('mkfs.') || cmd === 'mke2fs') {
    out.findings.push({ id: 'mkfs', action: 'block', description: 'mkfs (format filesystem)' });
    return;
  }
  if (cmd === 'dd') {
    if (restText.some((t) => /^of=\/dev\//.test(t))) out.findings.push({ id: 'dd-device', action: 'block', description: 'dd write to device' });
    return;
  }
  if (cmd === 'chmod' || cmd === 'chown' || cmd === 'chgrp') {
    const recursiveOwn = rest.some((w) => w.text === '--recursive' || /^-[a-zA-Z]*R[a-zA-Z]*$/.test(w.text));
    const nonFlag = rest.filter((w) => !w.text.startsWith('-'));
    if (recursiveOwn && nonFlag.length >= 2) {
      emitWrite('recursive-perm-change', `recursive ${cmd}`, nonFlag.slice(1).filter((w) => !/^\.{1,2}\/?$/.test(w.text)).map((w) => ({ text: w.text, dynamic: w.dynamic })), ctx, out, false);
    }
    if (cmd === 'chmod' && restText.some((t) => /^[0-7]*777$/.test(t) || t === 'a+rwx' || t === 'ugo+rwx')) {
      out.findings.push({ id: 'chmod-777', action: 'warn', description: 'chmod 777 (overly permissive)' });
    }
    return;
  }
  if (cmd === 'mv') {
    const nf = rest.filter((w) => !w.text.startsWith('-'));
    if (nf.length >= 2) {
      const dest = nf[nf.length - 1];
      emitWrite('mv-system', 'mv source', nf.slice(0, -1).map((w) => ({ text: w.text, dynamic: w.dynamic })), ctx, out, false);
      const dv = classifyTargets([{ text: dest.text, dynamic: dest.dynamic }].filter((t) => !expandVars(t.text, ctx.vars).includes('$')), ctx, false);
      if (dv.action === 'deny') out.findings.push({ id: 'mv-system', action: 'ask', targets: dv.list, description: `mv destination is ${dv.reason}: ${dv.list.join(' ')}` });
    }
    return;
  }
  if (cmd === 'tee') {
    emitWrite('tee-system', 'tee write', rest.filter((w) => !w.text.startsWith('-')).map((w) => ({ text: w.text, dynamic: w.dynamic })), ctx, out, false);
    return;
  }
  if (cmd === 'truncate' || cmd === 'shred' || cmd === 'unlink' || cmd === 'wipefs') {
    const targets: Target[] = [];
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i].text;
      if (t.startsWith('-')) { if (/^(-s|-r|-n|-t|-o|--size|--reference|--iterations|--types|--offset)$/.test(t)) i++; continue; }
      targets.push({ text: t, dynamic: rest[i].dynamic });
    }
    emitWrite(`${cmd}-target`, cmd, targets, ctx, out, true);
    return;
  }

  // 따옴표 없는 맨 SQL 문장(`DROP TABLE users` 직접 입력)도 SQL 로 취급
  if (!words[0].quoted && /^(drop|truncate|delete|alter|update|insert|create)$/i.test(words[0].text)) {
    out.sqlTexts.push(words.map((w) => w.text).join(' '));
    return;
  }

  if (DB_CLIS.has(cmd)) {
    collectSql(rest, st, stmts, idx, out);
    return;
  }

  const evalFlags = SCRIPT_EVAL[cmd.replace(/^(python|ruby|perl)[\d.]+$/, '$1')];
  if (evalFlags) {
    for (let i = 0; i < rest.length - 1; i++) {
      const t = rest[i].text;
      const clustered = /^-[a-zA-Z]{2,}$/.test(t) && evalFlags.some((f) => f.length === 2 && t.endsWith(f[1]));
      if (evalFlags.includes(t) || clustered) { analyzeCode(rest[i + 1].text, ctx, out); break; }
    }
    return;
  }

  if (REMOTE_RUNNERS.has(cmd)) {
    for (const w of rest) if (/\s/.test(w.text)) walk(w.text, sub, out);
    for (let i = 0; i < rest.length; i++) {
      const b = baseName(rest[i].text);
      if (KNOWN_CMDS.has(b)) { analyzeWords(rest.slice(i), null, 0, sub, out); break; }
    }
    return;
  }
  void st;
}

function collectSql(rest: Word[], st: Stmt | null, stmts: Stmt[] | null, idx: number, out: AnalysisResult): void {
  out.sqlTexts.push(rest.map((w) => w.text).join(' '));
  if (st) { for (const h of st.heredocs) out.sqlTexts.push(h); for (const hs of st.hereStrings) out.sqlTexts.push(hs.text); }
  // echo "DROP TABLE x" | psql
  if (st && stmts) {
    let k = idx;
    while (k > 0 && stmts[k].sepBefore === '|') {
      const prev = stmts[k - 1];
      const pc = prev.words.length ? baseName(prev.words[0].text) : '';
      if (pc === 'echo' || pc === 'printf' || pc === 'cat') {
        out.sqlTexts.push([...prev.words.slice(1).map((w) => w.text), ...prev.heredocs].join(' '));
      }
      k--;
    }
  }
}

/** python -c / node -e 등 인라인 코드: 삭제 API, 문자열 속 셸 명령, SQL 을 본다. */
function analyzeCode(code: string, ctx: Ctx, out: AnalysisResult): void {
  out.sqlTexts.push(code);
  const sub: Ctx = { ...ctx, depth: ctx.depth + 1 };
  const before = out.findings.length;
  // 문자열 리터럴 속 셸 명령 (os.system("rm -rf x"), execSync('rm -rf x'))
  const executes = /\b(system|popen|subprocess|exec\w*|spawn\w*|check_output|check_call|Popen|run|shell_exec|passthru|eval)\b|`/.test(code);
  if (executes) for (const m of code.matchAll(/(["'])((?:\\.|(?!\1).)*)\1/gs)) {
    if (/\s/.test(m[2]) && /\b(rm|find|git|mkfs|dd|curl|wget)\b/.test(m[2])) walk(m[2], sub, out);
  }
  if (out.findings.length === before && (DELETE_CODE_RE.test(code) || (executes && RM_IN_CODE_RE.test(code)))) {
    const paths = [...code.matchAll(SQL_PATH_LITERAL_RE)].map((m) => m[2]);
    const allTemp = paths.length > 0 && paths.every((p) => isClaudeTempPath(p, ctx.cwd));
    if (!allTemp) {
      const fatal = paths.find((p) => { const v = classifyTargets([{ text: p, dynamic: false }], ctx, false); return v.action === 'deny' && (v.reason === 'filesystem root' || v.reason === 'home directory'); });
      out.findings.push(fatal
        ? { id: 'script-delete', action: 'deny', description: `file deletion via inline script on ${fatal === '/' ? 'filesystem root' : 'root/home path'} (${fatal})`, targets: paths }
        : { id: 'script-delete', action: 'ask', description: 'file deletion via inline script (shutil.rmtree/os.remove/fs.rm …)', targets: paths });
    }
  }
  if (/import\s+os|subprocess|\bexec\b|\beval\b/.test(code)) {
    out.findings.push({ id: 'script-dangerous-import', action: 'warn', description: 'python -c with dangerous imports' });
  }
}

export function analyzeCommand(cmd: string, opts: AnalyzeOptions = {}): AnalysisResult {
  const out: AnalysisResult = { findings: [], gitOps: [], sqlTexts: [] };
  if (!cmd) return out;
  if (cmd.length > MAX_COMMAND_LENGTH) {
    out.findings.push({ id: 'analysis-limit', action: 'ask', description: `command too long to analyze (${cmd.length} > ${MAX_COMMAND_LENGTH} chars)` });
    return out;
  }
  const home = opts.home ?? process.env.HOME ?? '';
  const vars = new Map<string, string>([['TMPDIR', process.env.TMPDIR?.replace(/\/+$/, '') || '/tmp']]);
  if (home) { vars.set('HOME', home); }
  const ctx: Ctx = { vars, cwd: opts.cwd?.startsWith('/') ? opts.cwd : '', home, depth: 0 };
  budget = WORK_BUDGET;
  try { walk(cmd, ctx, out); } catch (e) {
    // 판별 불가는 통과가 아니라 확인(ask) — 분석이 터지거나 작업량 상한을 넘으면 사람이 본다.
    pushFinding(out, { id: 'analysis-limit', action: 'ask', description: e instanceof LimitError ? 'command too complex to analyze safely' : 'command analysis failed — cannot verify safety' });
  } finally { budget = Infinity; }
  return out;
}

const RANK: Record<FindingAction, number> = { block: 3, deny: 3, ask: 2, warn: 1 };
export function worstFinding(findings: CommandFinding[]): CommandFinding | undefined {
  return findings.slice().sort((a, b) => RANK[b.action] - RANK[a.action])[0];
}
