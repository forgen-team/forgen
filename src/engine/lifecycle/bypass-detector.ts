/**
 * Bypass detector — T3 signal source.
 *
 * Rule.policy 자연어에서 "피해야 할 패턴" 을 추출하고, Write/Edit/Bash 도구
 * 출력에서 해당 패턴을 찾아 BypassEntry 후보로 반환한다.
 *
 * Heuristic priority (most explicit first):
 *   0) Parenthesized examples (e.g., "(rm -rf, DROP, force-push)") → tokens inside
 *   1) "use X not Y" / "use X instead of Y" / "X over Y" → bypass = Y
 *   2) "avoid X" / "don't use X" / "never use X" / "do not use X" → bypass = X
 *   3) Korean: "X 말라" / "X 금지" / "X 하지 않" → bypass = X
 *   4) 그 외: 빈 배열 (탐지 불가).
 *
 * Stop list filter: generic Korean verbs (실행/사용/선언/...) extracted by Korean
 * heuristic are removed — they cause massive FP (RC5/E9: matched the word "실행"
 * everywhere instead of "rm -rf"). 64 false-positive bypasses observed before fix.
 *
 * 반환된 패턴은 escape 된 정규식 문자열 — caller 가 `new RegExp(p)` 로 사용.
 */

import type { Rule } from '../../store/types.js';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Trim punctuation 많이 붙은 자연어 표현을 "검색용 토큰" 으로 정규화.
 * Leading `.` 는 유지 — `.then`, `.mock` 같은 메서드 참조가 의도된 매칭 대상.
 * Trailing `()` 는 제거 — `.then()` 을 `.then` 으로 정규화해 `.then(x=>...)` 에 매치.
 */
function trimPunct(s: string): string {
  let out = s;
  // Strip trailing "()" once (natural-language shorthand for method calls)
  if (out.endsWith('()')) out = out.slice(0, -2);
  // Strip other leading/trailing punctuation, preserving leading `.`
  out = out.replace(/^[,;:!?"'`(]+|[.,;:!?"'`)]+$/g, '');
  return out;
}

/**
 * Generic Korean verbs/words that produce massive false positives if used as
 * bypass patterns (RC5/E9 fix). Extending requires retro evidence.
 */
const KO_GENERIC_STOP_WORDS = new Set([
  '실행', '사용', '선언', '수행', '처리', '작성', '호출', '적용',
  '실행하지', '사용하지', '선언하지', '수행하지', '처리하지',
  // English fallthroughs (already low value as bypass signals)
  'use', 'do', 'execute',
]);

/** Korean markers that signal the parenthesized content is NOT an example list. */
const KO_NON_EXAMPLE_MARKERS = ['제외', '한정', '예외', '단서', 'except'];

/** Extract concrete tokens inside parenthesized example list. */
function extractParenthesizedExamples(p: string): string[] {
  const out: string[] = [];
  // Match (...) groups; multiple groups in policy are uncommon but supported
  const re = /\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p))) {
    const inside = m[1];
    // Skip if it looks like a path (contains "/" before any obvious separator commitment)
    if (/[a-zA-Z]+\/[a-zA-Z]/.test(inside)) continue;
    // Skip if it's an exclusion / scope-restriction note (Korean markers)
    if (KO_NON_EXAMPLE_MARKERS.some((mk) => inside.includes(mk))) continue;
    // Skip if any single segment is suspiciously long (full sentence rather than token)
    const segs = inside.split(/[,]|\s+(?:or|와|및)\s+/i).map((s) => s.trim());
    if (segs.some((s) => s.length > 30)) continue;
    const tokens = segs
      .map((t) => trimPunct(t))
      .filter((t) => t.length >= 2 && !KO_GENERIC_STOP_WORDS.has(t));
    out.push(...tokens);
  }
  return out;
}

export function extractBypassPatterns(rule: Rule): string[] {
  const patterns: string[] = [];
  const p = rule.policy;

  // 0) Parenthesized examples (highest priority — explicit signal)
  for (const ex of extractParenthesizedExamples(p)) {
    patterns.push(escapeRegex(ex));
  }

  // use X not Y / use X instead of Y / use X over Y
  // X, Y may contain dots (e.g., ".then()", "vi.mock"). Strip trailing punctuation.
  const useNot = p.match(/\b(?:use|prefer|choose)\s+(\S+?)\s+(?:not|instead\s+of|over|rather\s+than)\s+(\S+)/i);
  if (useNot) patterns.push(escapeRegex(trimPunct(useNot[2])));

  // avoid X / don't use X / never use X / do not use X
  const avoid = p.match(/\b(?:avoid|don'?t\s+use|never\s+use|do\s+not\s+use)\s+(\S+)/i);
  if (avoid) patterns.push(escapeRegex(trimPunct(avoid[1])));

  // Korean: "X 말라" / "X 금지" / "X 하지 마"
  const ko = p.match(/(\S+)\s*(?:말라|금지|하지\s*마|쓰지\s*마)/);
  if (ko) {
    const candidate = trimPunct(ko[1]);
    if (!KO_GENERIC_STOP_WORDS.has(candidate)) {
      patterns.push(escapeRegex(candidate));
    }
  }

  // Dedupe + filter trivial + filter stop-words (defense in depth)
  return [...new Set(patterns)]
    .filter((pat) => pat.length >= 2)
    .filter((pat) => !KO_GENERIC_STOP_WORDS.has(pat.replace(/\\/g, '')));
}

export interface BypassScanInput {
  rules: Rule[];
  tool_name: string;
  tool_output: string;
  session_id: string;
}

export interface BypassCandidate {
  rule_id: string;
  session_id: string;
  tool: string;
  pattern_preview: string;
  matched: string;
}

/**
 * Pure — rules + tool output 으로 bypass candidates 추출.
 * 같은 rule/pattern 이 여러 번 매칭돼도 한 번만 기록.
 */
export function scanForBypass(input: BypassScanInput): BypassCandidate[] {
  const { rules, tool_name, tool_output, session_id } = input;
  const candidates: BypassCandidate[] = [];
  const reported = new Set<string>(); // rule_id|pattern

  for (const rule of rules) {
    if (rule.status !== 'active') continue;
    const patterns = extractBypassPatterns(rule);
    for (const pat of patterns) {
      const re = new RegExp(pat, 'i');
      const m = tool_output.match(re);
      if (!m) continue;
      const key = `${rule.rule_id}|${pat}`;
      if (reported.has(key)) continue;
      reported.add(key);
      candidates.push({
        rule_id: rule.rule_id,
        session_id,
        tool: tool_name,
        pattern_preview: pat.slice(0, 40),
        matched: m[0].slice(0, 40),
      });
    }
  }
  return candidates;
}
