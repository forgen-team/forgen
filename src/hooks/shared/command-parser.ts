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
