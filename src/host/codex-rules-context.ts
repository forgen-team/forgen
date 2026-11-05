/**
 * 개인화 룰 주입 — ADR-014 D1, 2026-11-04 Claude 까지 확장
 *
 * 모든 호스트가 SessionStart additionalContext 하나로 룰을 받는다. 파일 방식(.claude/rules/)은
 * 래퍼 실행에서만 갱신되고 cwd 에 흔적을 남겨서, 직접 실행이면 옛 룰이 계속 주입됐다.
 * 본 모듈은 *같은 소스* (generateClaudeRuleFiles) 를 *같은 캡* (RULE_FILE_CAPS) 으로 렌더해
 * SessionStart additionalContext 로 넣을 블록을 만든다. hooks.json 을 바꾸지 않기 위해 새 훅이
 * 아니라 session-recovery 내부의 codex 분기에서 호출된다.
 *
 * 컴팩션 후 재주입은 별도 경로가 없다: Claude Code 와 Codex 모두 compaction 시 SessionStart 를
 * source="compact" 로 다시 발화하므로 (Codex 공식 hooks 문서), 같은 경로가 한 번 더 돈다.
 * (critic 리뷰 2026-10-01: PreCompact 플래그 경로는 2중 주입이라 제거.)
 */

import { composeRuleFiles  } from '../hooks/shared/injection-caps.js';

export const FORGEN_RULES_TAG = 'forgen-rules';

/** codex-adapter 가 delegate hook 에 FORGEN_RUNTIME=codex 를 주입한다 (0.4.6+). */
export function isCodexRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FORGEN_RUNTIME === 'codex';
}

/**
 * 룰 파일 맵 → 단일 additionalContext 블록. Claude 의 injectClaudeRuleFiles 와 동일 캡:
 * 파일당 perRuleFile, 총량 totalRuleFiles. 캡 초과 파일은 잘리고, 총량 초과 시 이후 파일은 생략.
 */
export function renderRulesBlock(ruleFiles: Record<string, string>, host: 'claude' | 'codex' = 'codex'): string | null {
  const sections = composeRuleFiles(ruleFiles).files.map(({ filename, content }) => `<!-- ${filename} -->\n${content.trim()}`);
  if (sections.length === 0) return null;

  return [
    `<${FORGEN_RULES_TAG} host="${host}">`,
    'These are this user\'s forgen rules. They apply to this session.',
    '',
    sections.join('\n\n---\n\n'),
    `</${FORGEN_RULES_TAG}>`,
  ].join('\n');
}

/**
 * cwd + 렌더된 v1 룰 → Codex 주입 블록. config-injector 는 무거워서 lazy import.
 * 실패 시 null (fail-open — 룰 주입 실패가 세션 시작을 막으면 안 된다).
 */
export const renderCodexRulesBlock = renderRulesBlock;

export async function buildRulesContext(cwd: string, renderedRules: string | null, host: 'claude' | 'codex'): Promise<string | null> {
  try {
    const { generateClaudeRuleFiles } = await import('../core/config-injector.js');
    return renderRulesBlock(generateClaudeRuleFiles(cwd, renderedRules), host);
  } catch {
    return null;
  }
}
