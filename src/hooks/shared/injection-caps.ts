/**
 * Forgen — Injection Caps
 *
 * 컨텍스트 주입 하드캡 상수. 다른 플러그인과 공존 시 컨텍스트 윈도우를
 * 과도하게 점유하지 않도록 각 훅의 최대 주입량을 제한합니다.
 *
 * 이 값들은 어댑티브 버짓 시스템의 "절대 상한"이며,
 * 실제 주입량은 context-budget.ts에서 동적으로 조절됩니다.
 */

export const INJECTION_CAPS = {
  /** notepad-injector: 노트패드 최대 주입 글자 수 (현재: 무제한 → 2000) */
  notepadMax: 2000,

  /** skill-injector: 스킬 파일 하나당 최대 글자 수 (현재: 무제한 → 3000) */
  skillContentMax: 3000,

  /** solution-injector: 솔루션 하나당 최대 글자 수 (기존 값 유지) */
  solutionMax: 1500,

  /** solution-injector: 세션 전체 주입 상한 (기존 값 유지) */
  solutionSessionMax: 8000,
} as const;

/**
 * .claude/rules/ 자동생성 파일의 사이즈 하드캡.
 * rules 파일은 Claude Code가 세션 시작 시 전부 로드하므로
 * 무제한 성장을 방지해야 합니다.
 *
 * 근거: Claude Code 공식 권장 — "CLAUDE.md 파일당 200줄 이하",
 * "길수록 지시 준수율 저하". 3000자 ≈ 60~80줄.
 */
export const RULE_FILE_CAPS = {
  /** .claude/rules/ 파일 1개당 최대 글자 수 */
  perRuleFile: 3000,

  /**
   * 사용자 룰 파일(v1-rules.md) 상한. 룰 렌더러가 이 안에서 우선순위로 고르고 빠진 룰을 표시하므로,
   * 파일 합성에서 중간이 잘리지 않는다. 3000 자에서는 활성 룰 20개가 이미 잘렸다(2026-11-04 실측).
   */
  perUserRuleFile: 8000,

  /** 룰 블록 총량 (글자). SESSION_CONTEXT_MAX 안쪽에 복구 메시지 자리를 남긴다. */
  totalRuleFiles: 8500,

  /** compound.md에 포함할 rule summary 최대 수 */
  maxRuleSummaries: 10,
} as const;

/** truncation 시 끝에 추가되는 표시 */
export const TRUNCATION_SUFFIX = '\n... (truncated)';

/** 주어진 content를 maxChars로 잘라서 반환. 초과 시 truncation suffix 추가. */
export function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const cutAt = Math.max(0, maxChars - TRUNCATION_SUFFIX.length);
  let sliced = content.slice(0, cutAt);

  // UTF-16 서로게이트 쌍 분리 방지: 마지막 문자가 high surrogate이면 제거
  if (sliced.length > 0) {
    const lastCode = sliced.charCodeAt(sliced.length - 1);
    if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
      sliced = sliced.slice(0, -1);
    }
  }

  return sliced + TRUNCATION_SUFFIX;
}


/**
 * SessionStart additionalContext 상한. Claude Code 2.1.318 실측(2026-11-04): 9,500자는 모델에 도달하고
 * 10,500자부터는 내용 전체가 사라진다(잘리는 게 아니라 통째로). 이 값을 넘기면 룰이 전부 끊기므로 불변식이다.
 */
export const SESSION_CONTEXT_MAX = 9500;

/**
 * 룰 블록 + 복구 메시지 → 최종 컨텍스트. 룰을 항상 먼저 지키고, 넘치는 메시지는 빼고 표시한다.
 * 어떤 입력이어도 SESSION_CONTEXT_MAX 를 넘지 않는다.
 */
export function fitSessionContext(rulesBlock: string | null, messages: string[]): string {
  const NOTE_RESERVE = 80;
  const parts: string[] = [];
  let used = 0;
  if (rulesBlock) {
    const block = rulesBlock.length > SESSION_CONTEXT_MAX - NOTE_RESERVE
      ? `${rulesBlock.slice(0, rulesBlock.lastIndexOf('\n', SESSION_CONTEXT_MAX - NOTE_RESERVE - 40))}\n... (capped)`
      : rulesBlock;
    parts.push(block);
    used = block.length;
  }
  let dropped = 0;
  for (const message of messages) {
    if (used + message.length + 2 > SESSION_CONTEXT_MAX - NOTE_RESERVE) { dropped++; continue; }
    parts.push(message);
    used += message.length + 2;
  }
  if (dropped > 0) parts.push(`(forgen: 컨텍스트 상한으로 복구 메시지 ${dropped}개 생략)`);
  return parts.join('\n\n');
}

/** 파일 이름별 상한. */
export function ruleFileCap(filename: string): number {
  return filename === 'v1-rules.md' ? RULE_FILE_CAPS.perUserRuleFile : RULE_FILE_CAPS.perRuleFile;
}

export interface ComposedRuleFile { filename: string; content: string; truncated: boolean }

/**
 * 룰 파일 맵 → 실제 주입본. Claude 파일 쓰기와 Codex 컨텍스트 블록이 같이 쓴다.
 * 사용자 룰을 먼저 배치해 총량 상한에 밀리지 않게 하고, 자를 때는 줄 경계에서 자른다.
 */
export function composeRuleFiles(ruleFiles: Record<string, string>): { files: ComposedRuleFile[]; omitted: string[] } {
  const entries = Object.entries(ruleFiles)
    .filter(([, c]) => typeof c === 'string' && c.trim().length > 0)
    .sort(([a], [b]) => Number(b === 'v1-rules.md') - Number(a === 'v1-rules.md'));
  const files: ComposedRuleFile[] = [];
  const omitted: string[] = [];
  let total = 0;
  for (const [filename, content] of entries) {
    const cap = ruleFileCap(filename);
    let finalContent = content;
    let truncated = false;
    if (content.length > cap) {
      const cut = content.lastIndexOf('\n', cap);
      finalContent = `${content.slice(0, cut > 0 ? cut : cap)}\n... (capped at rule file limit)\n`;
      truncated = true;
    }
    if (total + finalContent.length > RULE_FILE_CAPS.totalRuleFiles) {
      omitted.push(filename);
      continue;
    }
    total += finalContent.length;
    files.push({ filename, content: finalContent, truncated });
  }
  return { files, omitted };
}
