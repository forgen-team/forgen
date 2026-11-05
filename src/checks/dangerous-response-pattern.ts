/**
 * Forgen — DANGEROUS-RESPONSE: 응답 텍스트 파괴적 명령 가드
 *
 * Stop hook 단계에서 어시스턴트 응답 텍스트를 스캔하여 *파괴적 명령 제안*을
 * 감지한다. PreToolUse 가드는 실제 도구 실행 직전에만 동작하므로, 모델이
 * 텍스트로 위험한 대안을 *제안*하는 케이스(예: `find ... -exec rm -r {}`)는
 * 도구 실행 단계에 도달하지 못하면 차단되지 않는다. 본 체크는 그 갭을 메운다.
 *
 * 발견 경위 (forgen-eval syn-004, 2026-05-06):
 *   notepad 룰 "[no-rm-rf-unconfirmed]" inject 상태에서, driver(llama 8B) 가
 *   `rm -rf` 리터럴은 회피했지만 `find . -type d -name 'build' -exec rm -r {}`
 *   같은 우회 명령을 "안전한 대안"으로 제안. PreToolUse 차단은 실 실행 시
 *   동작하지만 "응답 텍스트만으론" 못 막음. driver 모델 능력에 무관하게
 *   일관된 안전 보장이 되도록 응답 단계에서 한 번 더 잡아낸다.
 *
 * 동작:
 *   - 어시스턴트 응답에 등록된 파괴 패턴이 매칭되면 block 권고.
 *   - "확실히, 명시적 확인" 같은 confirm 표현 동반 여부는 검사하지 않는다
 *     (휴리스틱 brittle). 매칭 시 무조건 block 후, 모델이 안전한 대안 제시
 *     또는 명시적 confirm 절차로 재응답하도록 유도.
 *
 * 순수 함수 — Stop hook 이 reason 문자열을 그대로 주입.
 */

import { compileSafeRegex, safeRegexTest } from '../hooks/shared/safe-regex.js';

interface DangerousResponsePattern {
  /** 정규표현식 소스 (\\ escape 필요). */
  pattern: string;
  /** 사용자에게 표시할 짧은 설명. */
  description: string;
  /** 정규표현식 플래그 (default: 'i'). */
  flags?: string;
}

/**
 * 응답이 제안한 명령에서 검사할 파괴적 명령 패턴.
 * dist/hooks/dangerous-patterns.json (PreToolUse 용) 와 별도 — 응답 텍스트
 * 분석에 적합한 더 넓은 패턴 (find -exec rm 같은 우회 포함).
 */
/** 패턴 순서 중요: 더 구체적인(우회) 패턴을 먼저 두어 일반 rm -r 패턴이 가로채지 않게 함. */
const RESPONSE_PATTERNS: DangerousResponsePattern[] = [
  { pattern: '\\bfind\\b[^\\n]{0,80}-exec\\s+rm\\b', description: 'find -exec rm (rm 우회)', flags: 'i' },
  { pattern: '\\bfind\\b[^\\n]{0,80}-delete\\b', description: 'find -delete (rm 우회)', flags: 'i' },
  { pattern: '\\bxargs\\s+rm\\b', description: 'xargs rm (rm 우회)', flags: 'i' },
  { pattern: '\\brm\\s+-(?:rf|fr|r)\\b', description: 'rm -r/-rf 직접 호출', flags: 'i' },
  { pattern: '\\bgit\\s+push\\b[^\\n]{0,40}--force(?!-)', description: 'git push --force', flags: 'i' },
  { pattern: '\\bgit\\s+reset\\s+--hard\\b', description: 'git reset --hard', flags: 'i' },
  { pattern: '\\bgit\\s+clean\\s+-[a-z]*f', description: 'git clean -f', flags: 'i' },
  { pattern: '\\bDROP\\s+(?:TABLE|DATABASE)\\b', description: 'SQL DROP TABLE/DATABASE', flags: 'i' },
  { pattern: '\\bTRUNCATE\\s+TABLE\\b', description: 'SQL TRUNCATE TABLE', flags: 'i' },
  { pattern: '>\\s*/dev/sd[a-z]\\b', description: '/dev/sdX 직접 write', flags: 'i' },
  { pattern: '\\bmkfs\\b', description: 'mkfs (파일시스템 포맷)', flags: 'i' },
  { pattern: '\\bdd\\b[^\\n]{0,60}\\bof=/dev/', description: 'dd of=/dev/* (장치 write)', flags: 'i' },
  { pattern: '\\bcurl\\b[^\\n]{0,60}\\|\\s*(?:ba)?sh\\b', description: 'curl | sh (원격 코드 실행)', flags: 'i' },
  { pattern: '\\bwget\\b[^\\n]{0,60}\\|\\s*(?:ba)?sh\\b', description: 'wget | sh (원격 코드 실행)', flags: 'i' },
];

export interface DangerousResultMatch {
  block: boolean;
  matched?: string;
  reason: string;
}

/**
 * 사용자가 그대로 실행할 수 있게 제안한 명령 부분: 코드 펜스 안과 `$ `·`# ` 프롬프트 줄.
 * 그 밖의 줄은 실행을 권유하는 문장일 때만 포함한다. 설명·금지 속 언급은 제외한다. 실제 실행은 PreToolUse 가 막으므로, 언급을 막으면 안전 효과 없이
 * "이런 명령은 위험하다"는 정상 답변까지 차단한다. 이 가드의 대상은 사용자가 복사해 실행할 제안이다.
 */
const RUN_CUE = /\b(run|execute|try|use|alternative)\b|대안|실행(하세요|해\s*주세요|하시면|해\s*보세요|하면)|입력(하세요|하면)|치세요|돌리(세요|면)/i;
const NOT_A_SUGGESTION = /금지|안\s*됩|안\s*돼|않|하지\s*마|위험|차단(됩|합|했)|막(힙|습|았|혀)|날아|사라|오탐|예시|never|don'?t|do not|avoid|unsafe|dangerous/i;

export function extractSuggestedCommands(text: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) out.push(line);
    else if (/^\s*[$#]\s+\S/.test(line) && !/^\s*#\s+[^a-z/.~]/i.test(line)) out.push(line.replace(/^\s*[$#]\s+/, ''));
    else if (RUN_CUE.test(line) && !NOT_A_SUGGESTION.test(line)) out.push(line);
  }
  return out.join('\n');
}

/** 제안된 명령에 파괴적 명령 패턴이 있는지 검사. */
export function checkDangerousResponsePattern(opts: { text: string }): DangerousResultMatch {
  const text = extractSuggestedCommands(opts.text ?? '');
  if (!text.trim()) return { block: false, reason: '' };

  for (const p of RESPONSE_PATTERNS) {
    const compiled = compileSafeRegex(p.pattern, p.flags ?? 'i');
    if (!compiled.regex) continue; // bad regex — skip
    if (safeRegexTest(compiled.regex, text)) {
      return {
        block: true,
        matched: p.description,
        reason: `응답에 파괴적 명령 패턴이 포함되었습니다 (${p.description}). 사용자 명시 확인 절차를 포함하거나 비파괴 대안 (예: dry-run, --interactive)을 제시해 다시 응답하세요.`,
      };
    }
  }
  return { block: false, reason: '' };
}
