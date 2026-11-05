/**
 * Commit guard (D12-B) — `git add` / `git commit` 가 비밀 파일·키를 저장소에 넣으려 할 때 PreToolUse 에서 막는다.
 *
 * 명령 문자열만 보는 게 아니라 **실제 git 상태**를 확인한다:
 *  - add:    pathspec(또는 -A/./-u)이 가리키는 untracked/modified 파일 중 .gitignore 로 제외되지 않은 것
 *            (-f 이면 제외된 파일도). 이름 규칙 + 내용(고신뢰 키 패턴) 검사.
 *  - commit: `git diff --cached`(staged), -a 이면 tracked 변경까지. 추가된 줄에서 고신뢰 키 패턴 검사.
 * 비밀 "값"은 결과에 담지 않는다 — 파일 경로와 패턴 이름만 돌려준다.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitOp } from './command-analyzer.js';
import { SECRET_PATTERNS } from '../secret-filter.js';

export interface CommitSecretHit { file: string; reasons: string[] }
export interface CommitCheckResult { hits: CommitSecretHit[]; /** 시간 예산(2초)을 넘겨 끝까지 검사하지 못했다 — 호출자는 fail-open 하지 말고 확인(ask)해야 한다. */ timedOut: boolean }

/** git 호출 + 파일 읽기 합산 시간 예산. PreToolUse hook timeout(3초) 안에 끝내기 위해 2초. */
export const COMMIT_GUARD_BUDGET_MS = 2000;
class BudgetExceeded extends Error {}
let deadline = Infinity;
function checkBudget(): void { if (Date.now() > deadline) throw new BudgetExceeded('commit-guard time budget exceeded'); }

const STRICT_NAMES = new Set(['Private Key', 'AWS Access Key', 'GitHub Token', 'Google API Key', 'Slack Token', 'Connection String']);
const STRICT_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  ...SECRET_PATTERNS.filter((p) => STRICT_NAMES.has(p.name)),
  { name: 'API Key (sk-)', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
];

const ENV_SAFE_SUFFIX = /\.(example|sample|template|dist|defaults?|tpl|schema)$/i;

/** 이름만으로 비밀 파일인 것 (.env 계열, 자격증명, SSH 개인키, 키스토어, 서비스 계정). */
export function secretFileReason(file: string): string | null {
  const base = path.basename(file);
  if (/^\.env(\..+)?$/i.test(base) && !ENV_SAFE_SUFFIX.test(base)) return '.env file';
  if (/^credentials(\.json)?$/i.test(base) || base === '.git-credentials' || base === '.netrc') return 'credentials file';
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return 'SSH private key';
  if (/\.(p12|pfx|jks|keystore|ppk)$/i.test(base)) return 'key store';
  if (/^(service[-_]?account|serviceAccount).*\.json$/i.test(base) || /^secrets?\.(json|ya?ml)$/i.test(base)) return 'secrets file';
  return null;
}

function git(dir: string, args: string[], max = 4_000_000): string {
  checkBudget();
  const remaining = Math.max(50, Math.min(5000, deadline - Date.now()));
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: remaining, maxBuffer: max, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    // 시간 초과로 죽은 git 을 "출력 없음 = 안전" 으로 읽으면 fail-open — 예산 초과로 올려 보낸다.
    if ((e as { code?: string }).code === 'ETIMEDOUT' || (e as { signal?: string }).signal === 'SIGTERM') throw new BudgetExceeded('git timed out');
    return '';
  }
}

/** 문서·테스트에 흔한 예제 값 — 진짜 비밀이 아니므로 차단하지 않는다. */
const PLACEHOLDER_RE = /EXAMPLE|example\.(com|org|net)|\blocalhost\b|127\.0\.0\.1|user(name)?:pass(word)?@|\bxxx+|\*{4,}|<[A-Za-z_ -]+>|\b(YOUR|MY|REPLACE|CHANGE)[_-]/i;

function scanText(text: string): string[] {
  const names: string[] = [];
  for (const sp of STRICT_PATTERNS) {
    checkBudget();
    const re = new RegExp(sp.pattern.source, sp.pattern.flags.includes('g') ? sp.pattern.flags : `${sp.pattern.flags}g`);
    let real = false;
    for (const m of text.matchAll(re)) {
      // 연결 문자열은 매치가 `scheme://user:pw@` 까지라 호스트(localhost 등)를 보려면 뒤 문맥이 필요하다.
      const ctx = sp.name === 'Connection String' ? text.slice(m.index!, m.index! + m[0].length + 80) : m[0];
      if (!PLACEHOLDER_RE.test(ctx)) { real = true; break; }
    }
    if (real) names.push(sp.name);
  }
  return names;
}

function addedLines(diff: string): string {
  return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
}

export function checkGitSecrets(ops: GitOp[], hookCwd?: string): CommitSecretHit[] {
  return checkGitSecretsBudgeted(ops, hookCwd).hits;
}

export function checkGitSecretsBudgeted(ops: GitOp[], hookCwd?: string, budgetMs = COMMIT_GUARD_BUDGET_MS): CommitCheckResult {
  deadline = Date.now() + budgetMs;
  const hits = new Map<string, Set<string>>();
  let timedOut = false;
  try {
    collectHits(ops, hookCwd, hits);
  } catch (e) {
    if (e instanceof BudgetExceeded) timedOut = true; else throw e;
  } finally { deadline = Infinity; }
  return { hits: [...hits.entries()].map(([file, r]) => ({ file, reasons: [...r] })), timedOut };
}

function collectHits(ops: GitOp[], hookCwd: string | undefined, hits: Map<string, Set<string>>): void {
  const add = (f: string, r: string) => { if (!hits.has(f)) hits.set(f, new Set()); hits.get(f)!.add(r); };
  for (const op of ops) {
    if (op.sub !== 'add' && op.sub !== 'commit') continue;
    const base = op.cwd || hookCwd || '';
    const dir = op.dir ? (op.dir.startsWith('/') ? op.dir : path.join(base, op.dir)) : base;
    if (!dir || !fs.existsSync(dir)) continue;
    if (!git(dir, ['rev-parse', '--git-dir']).trim()) continue; // git 저장소 아님

    if (op.sub === 'add') {
      const force = op.args.some((a) => a === '-f' || a === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a));
      const all = op.args.some((a) => a === '-A' || a === '--all' || a === '-u' || a === '--update');
      const specs = op.args.filter((a) => !a.startsWith('-'));
      if (!all && specs.length === 0) continue;
      const pathArgs = specs.length ? ['--', ...specs] : [];
      const candidates = new Set<string>();
      const lsOthers = git(dir, ['ls-files', '-z', '--others', '--exclude-standard', ...pathArgs]).split('\0');
      const lsMod = git(dir, ['ls-files', '-z', '--modified', ...pathArgs]).split('\0');
      for (const f of [...lsOthers, ...lsMod]) if (f) candidates.add(f);
      if (force && specs.length) {
        for (const f of git(dir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', ...pathArgs]).split('\0')) if (f) candidates.add(f);
      }
      let n = 0;
      for (const f of candidates) {
        if (n++ >= 200) break;
        checkBudget();
        const reason = secretFileReason(f);
        if (reason) add(f, reason);
        try {
          const abs = path.join(dir, f);
          const st = fs.statSync(abs);
          if (st.isFile() && st.size <= 512 * 1024 && !reason) {
            for (const nm of scanText(fs.readFileSync(abs, 'utf-8'))) add(f, nm);
          }
        } catch (e) { if (e instanceof BudgetExceeded) throw e; /* unreadable → skip */ }
      }
    } else {
      const withAll = op.args.some((a) => a === '-a' || a === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a) && !a.startsWith('--'));
      const diffArgs = (cached: boolean) => ['diff', ...(cached ? ['--cached'] : []), '-U0', '--no-color', '--no-ext-diff'];
      const files = [
        ...git(dir, ['diff', '--cached', '--name-only', '-z']).split('\0'),
        ...(withAll ? git(dir, ['diff', '--name-only', '-z']).split('\0') : []),
      ].filter(Boolean);
      for (const f of files) { const r = secretFileReason(f); if (r) add(f, r); }
      const parts = [git(dir, diffArgs(true)), ...(withAll ? [git(dir, diffArgs(false))] : [])];
      // 파일별로 쪼개 어느 파일인지 알린다
      for (const part of parts) {
        for (const chunk of part.split(/^diff --git /m).slice(1)) {
          const m = /^a\/(.+?) b\//.exec(chunk);
          const f = m ? m[1] : '(staged diff)';
          for (const nm of scanText(addedLines(chunk))) add(f, nm);
        }
      }
    }
  }
}
