import * as fs from 'node:fs';
/**
 * Command-token parser — quote-aware shell command preprocessing.
 *
 * 목적: PreToolUse enforce_via 룰의 정규식이 quote된 인자 텍스트와
 * 명령 토큰을 구분 못 해서 false positive block 발생 (TEST-6, RC5).
 *
 * 사례: forgen compound --solution "title" "본문에 rm -rf 텍스트 포함" 명령이
 * "rm\s+-rf" 패턴에 매칭되어 차단됨. 실제 rm 명령이 아닌데도.
 *
 * 해법: quote된 문자열을 마스킹한 뒤 패턴 매칭. 99% 케이스 커버.
 * 완벽한 shell 파싱은 아니지만 정직하게 한정된 범위.
 */

/**
 * Mask quoted string contents in a shell command so that text inside
 * single/double quotes, backticks, or $(...) is not matched by patterns
 * intended for command tokens.
 *
 * Examples:
 *   maskQuotedContent('rm -rf /')                                → 'rm -rf /'
 *   maskQuotedContent('echo "rm -rf foo"')                       → 'echo ""'
 *   maskQuotedContent("forgen save 'rm -rf body'")               → "forgen save ''"
 *   maskQuotedContent('rm -rf $(pwd)')                           → 'rm -rf $()'
 *   maskQuotedContent('echo `rm -rf x`')                         → 'echo ``'
 *
 * Limitations (documented, not silently broken):
 *   - escaped quotes inside quoted strings: best-effort only
 *   - heredoc bodies (<<EOF ... EOF): masked as `<<HEREDOC>>` (v0.4.1+)
 *   - nested $(...) / `...`: outer level masked
 */
export function maskQuotedContent(cmd: string): string {
  if (!cmd) return cmd;
  let out = cmd;
  // v0.4.1 (2026-04-24) — heredoc body 마스킹 추가. 이전엔 `cat > f <<EOF\n rm -rf /tmp \nEOF`
  // 처럼 heredoc 본문이 command string 에 포함돼 false-positive block 발생.
  // 지원 형식: <<EOF / <<'EOF' / <<"EOF" / <<-EOF (indent 무시 변종).
  // <<-MARK 은 indent 허용 (terminator 앞 whitespace). `\n\s*\2` 로 반영.
  out = out.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?\n\s*\2\b/g, '<<HEREDOC>>');
  // Order matters: command substitution before plain quotes (they may contain quotes themselves).
  out = out.replace(/\$\([^)]*\)/g, '$()');
  out = out.replace(/`[^`]*`/g, '``');
  out = out.replace(/'[^']*'/g, "''");
  out = out.replace(/"[^"]*"/g, '""');
  return out;
}

/**
 * Decide if a verifier should match against the raw command, masked command,
 * or the leading command tokens of each statement.
 *
 * 'raw'             — backward compat. Match against the unmodified command string.
 * 'masked'          — Strip quoted contents first. Use this when the rule wants to
 *                     guard a real command invocation (e.g. rm -rf) and not text
 *                     inside string literals passed as arguments to other commands.
 * 'command_tokens'  — Reserved for future use (per-statement leading-token check).
 *                     Currently behaves like 'masked' to avoid silently breaking
 *                     when rule files use it.
 */
export type MatchTarget = 'raw' | 'masked' | 'command_tokens';

export function preprocessForMatch(cmd: string, target: MatchTarget | undefined): string {
  if (!target || target === 'raw') return cmd;
  return maskQuotedContent(cmd);
}

/**
 * 임시 경로 접두 — 삭제해도 사용자 파일이 아닌 곳. ADR-017 §6-2 의 대상은 **Claude 의 자기 작업 폴더**이므로
 * `/tmp/claude-*` (Claude Code scratchpad) 와 `$TMPDIR/claude-*` 로 좁힌다 (critic D1: `/tmp/*` 전체는 너무 넓다).
 */
function tempRoots(): string[] {
  const roots = ['/tmp/claude-', '/private/tmp/claude-', '/var/tmp/claude-', '/var/folders/'];
  const t = process.env.TMPDIR?.replace(/\/+$/, '');
  if (t && t !== '/tmp') roots.push(`${t}/claude-`);
  return roots;
}

/** 경로 조작·확장 메타문자 — 하나라도 있으면 "임시 전용" 판정을 포기한다(보수적). */
const UNSAFE_TARGET_RE = /(^|\/)\.\.(\/|$)|[{}*?[\]`~]|\$\(/;

/**
 * ADR-017 §6-2 (오너 결정): "확인 없는 rm -rf 금지" 하드 룰은 Claude 가 **자기 임시 작업 폴더**를 지우는 경우까지
 * 막았다(7d 실 차단 14건 중 13건). 같은 명령 안의 **rm 이전** 대입(`S=/tmp/claude-x; rm -rf $S`)을 한 단계 치환하고,
 * 상대 경로는 stdin cwd(또는 같은 명령의 직전 `cd`)로 해석해, rm -rf 대상이 **전부** Claude 임시 루트 아래이면 true.
 *
 * critic D1 SEV-1 반영 — 하나라도 다음이면 false: `..`/brace/glob/백틱/`$()` 포함, 미해석 변수, 비임시 루트, 루트
 * 디렉터리 자체, 실존 경로의 realpath 가 임시 루트 밖(symlink 탈출). 빈 대상·rm 없음도 false.
 */
export function isTempOnlyRm(cmd: string, cwd?: string): boolean {
  if (!cmd) return false;
  const roots = tempRoots();
  const assignRe = /(?:^|[;&|\n]\s*|\s)([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/g;
  const cdRe = /(?:^|[;&|\n])\s*cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/g;
  const rmRe = /\brm\s+((?:-[a-zA-Z-]+\s+)+)([^;&|\n]+)/g;
  let found = false;
  for (const m of cmd.matchAll(rmRe)) {
    const flags = m[1];
    if (!/(^|\s)-[a-zA-Z]*r|--recursive/i.test(flags)) continue; // 재귀 삭제만 대상
    const upTo = cmd.slice(0, m.index ?? 0);
    // rm **이전** 의 대입만 반영 (재대입 순서 무시 방지)
    const vars = new Map<string, string>([['TMPDIR', process.env.TMPDIR?.replace(/\/+$/, '') || '/tmp']]);
    for (const a of upTo.matchAll(assignRe)) vars.set(a[1], expand(a[2] ?? a[3] ?? a[4] ?? '', vars));
    let base = cwd?.startsWith('/') ? cwd : '';
    for (const c of upTo.matchAll(cdRe)) {
      const d = expand(c[1] ?? c[2] ?? c[3] ?? '', vars);
      base = d.startsWith('/') ? d : base ? `${base}/${d}` : '';
    }
    const targets = m[2].trim().split(/\s+/).filter((t) => t && t !== '--' && !t.startsWith('-'));
    if (targets.length === 0) return false;
    for (const raw of targets) {
      found = true;
      const t = expand(raw.replace(/^["']|["']$/g, ''), vars);
      if (t.includes('$')) return false; // 미해석 변수
      if (UNSAFE_TARGET_RE.test(t)) return false; // `..`, glob, brace, 백틱, $(), ~
      let abs = t;
      if (!abs.startsWith('/')) {
        if (!base) return false; // 상대 경로인데 cwd 를 모름
        abs = `${base}/${t === '.' ? '' : t}`;
      }
      abs = normalizePosix(abs);
      if (!roots.some((r) => abs.startsWith(r))) return false;
      // 루트 디렉터리 자체(/tmp/claude-1001 등)는 제외 — 하위만
      if (!roots.some((r) => abs.length > r.length && abs.slice(r.length).includes('/'))) return false;
      // symlink 탈출: 가장 깊은 **실존 조상**의 realpath 가 임시 루트 아래여야 한다 (대상 자체가 아직 없어도).
      try {
        let probe = abs;
        while (probe !== '/' && !fs.existsSync(probe)) probe = probe.slice(0, probe.lastIndexOf('/')) || '/';
        if (probe !== '/') {
          const real = fs.realpathSync(probe);
          if (!roots.some((r) => real.startsWith(r) || `${real}/`.startsWith(r))) return false;
        }
      } catch { return false; }
    }
  }
  return found;
}

/** `..`·glob·brace 가 섞인 재귀 삭제 — 빌트인 /tmp 예외를 우회하려는 모양. 호출자가 차단에 쓴다. */
export function isSuspiciousRm(cmd: string): boolean {
  if (!cmd) return false;
  const rmRe = /\brm\s+((?:-[a-zA-Z-]+\s+)+)([^;&|\n]+)/g;
  for (const m of cmd.matchAll(rmRe)) {
    if (!/(^|\s)-[a-zA-Z]*r|--recursive/i.test(m[1])) continue;
    for (const t of m[2].trim().split(/\s+/)) {
      if (/(^|\/)\.\.(\/|$)|[{}*?[\]]|\$\(|`/.test(t) && /^\/?(tmp|private\/tmp|var\/tmp|var\/folders)(\/|$)|\/tmp\//.test(t.replace(/^["']|["']$/g, ''))) return true;
    }
  }
  return false;
}

function normalizePosix(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

function expand(s: string, vars: Map<string, string>): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, a, b) => {
    const v = vars.get(a ?? b);
    return v === undefined ? whole : v;
  });
}
