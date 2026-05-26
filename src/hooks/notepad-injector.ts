#!/usr/bin/env node
/**
 * Forgen — Notepad Injector Hook
 *
 * Claude Code UserPromptSubmit 훅으로 등록.
 * notepad.md에 저장된 영구 컨텍스트를 사용자 프롬프트 앞에 자동 주입합니다.
 *
 * compaction(컨텍스트 압축) 후에도 notepad의 내용은 매 프롬프트마다
 * <forgen-notepad> 태그로 재주입되어 컨텍스트에서 사라지지 않습니다.
 *
 * stdin:  JSON { prompt: string, ... }
 * stdout: JSON { result: "approve", message?: string }
 *
 * notepad 경로 결정 우선순위:
 *   1. COMPOUND_CWD 환경변수
 *   2. process.cwd()
 */

import { readStdinJSON } from './shared/read-stdin.js';
import { readNotepad } from '../core/notepad.js';
import { isHookEnabled } from './hook-config.js';
import { truncateContent } from './shared/injection-caps.js';
import { calculateBudget } from './shared/context-budget.js';
import { approve, approveWithContext, failOpenWithTracking } from './shared/hook-response.js';
import { escapeAllXmlTags } from './prompt-injection-filter.js';
import { checkForgenInitialized, hasPreflightWarned, markPreflightWarned } from './shared/preflight-check.js';

interface HookInput {
  prompt: string;
  session_id?: string;
  cwd?: string;
}

// ── 메인 ──

async function main(): Promise<void> {
  const input = await readStdinJSON<HookInput>();
  if (!isHookEnabled('notepad-injector')) {
    console.log(approve());
    return;
  }
  if (!input?.prompt) {
    console.log(approve());
    return;
  }

  const sessionId = input.session_id ?? 'unknown';
  const preflight = checkForgenInitialized();
  if (!preflight.initialized && !hasPreflightWarned(sessionId)) {
    markPreflightWarned(sessionId);
    process.stderr.write(`${preflight.message}\n`);
  }

  const effectiveCwd = input.cwd ?? process.env.FORGEN_CWD ?? process.env.COMPOUND_CWD ?? process.cwd();
  const notepadContent = readNotepad(effectiveCwd);

  if (!notepadContent.trim()) {
    // notepad가 비어있으면 아무것도 주입하지 않음
    console.log(approve());
    return;
  }

  // P1-S2 fix (2026-04-20): 이전에는 `</forgen-notepad>` 리터럴 하나만 치환했지만,
  // notepad 파일에 `<system>`, `<assistant>` 같은 임의 XML 태그가 있으면 그대로
  // LLM에 전달되어 지시 주입 위험. escapeAllXmlTags로 모든 태그를 escape한다.
  const truncated = truncateContent(notepadContent.trim(), calculateBudget(effectiveCwd).notepadMax);
  const safeContent = escapeAllXmlTags(truncated);
  const injection = `<forgen-notepad>\n${safeContent}\n</forgen-notepad>`;

  console.log(approveWithContext(injection, 'UserPromptSubmit'));
}

main().catch((e) => {
  process.stderr.write(`[ch-hook] ${e instanceof Error ? e.message : String(e)}\n`);
  console.log(failOpenWithTracking('notepad-injector', e));
});
