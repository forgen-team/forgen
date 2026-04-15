#!/usr/bin/env node
/**
 * Forgen — Context Guard Hook
 *
 * Claude Code Stop 훅으로 등록.
 * context window limit, edit error 등 실행 중 에러를 감지하여
 * 사용자에게 경고하고 상태를 보존합니다.
 *
 * 또한 UserPromptSubmit에서 현재 대화 길이를 추적하여
 * context 한계에 접근 시 preemptive 경고를 제공합니다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../core/logger.js';
import { readStdinJSON } from './shared/read-stdin.js';
import { atomicWriteJSON } from './shared/atomic-write.js';
import { loadHookConfig, isHookEnabled } from './hook-config.js';
import { approve, approveWithContext, approveWithWarning, failOpenWithTracking } from './shared/hook-response.js';
import { HANDOFFS_DIR, STATE_DIR } from '../core/paths.js';
import { recordHookTiming } from './shared/hook-timing.js';

const log = createLogger('context-guard');
const CONTEXT_STATE_PATH = path.join(STATE_DIR, 'context-guard.json');

interface ContextState {
  promptCount: number;
  totalChars: number;
  lastWarningAt: number;
  lastAutoCompactAt: number;
  sessionId: string;
}

// 경고 임계값: 프롬프트 50회 또는 총 문자 수 200K 이상
const PROMPT_WARNING_THRESHOLD = 50;
const CHARS_WARNING_THRESHOLD = 200_000;
const WARNING_COOLDOWN_MS = 10 * 60 * 1000; // 10분 쿨다운

// Auto-compact 임계값: 추적된 문자 120K ≈ 실제 context ~20%
const AUTO_COMPACT_CHARS_THRESHOLD = 120_000;
const AUTO_COMPACT_COOLDOWN_MS = 5 * 60 * 1000; // 5분 쿨다운

/** 경고 표시 여부 판정 (순수 함수) */
export function shouldWarn(
  contextPercent: { promptCount: number; totalChars: number; lastWarningAt: number },
  thresholds: { promptThreshold?: number; charsThreshold?: number; cooldownMs?: number } = {},
): boolean {
  const promptThreshold = thresholds.promptThreshold ?? PROMPT_WARNING_THRESHOLD;
  const charsThreshold = thresholds.charsThreshold ?? CHARS_WARNING_THRESHOLD;
  const cooldownMs = thresholds.cooldownMs ?? WARNING_COOLDOWN_MS;
  const now = Date.now();
  return (
    (contextPercent.promptCount >= promptThreshold || contextPercent.totalChars >= charsThreshold) &&
    (now - contextPercent.lastWarningAt > cooldownMs)
  );
}

/** auto-compact 트리거 여부 판정 (순수 함수) */
export function shouldAutoCompact(
  state: { totalChars: number; lastAutoCompactAt: number },
  thresholds: { charsThreshold?: number; cooldownMs?: number } = {},
): boolean {
  const charsThreshold = thresholds.charsThreshold ?? AUTO_COMPACT_CHARS_THRESHOLD;
  const cooldownMs = thresholds.cooldownMs ?? AUTO_COMPACT_COOLDOWN_MS;
  const now = Date.now();
  return state.totalChars >= charsThreshold && (now - state.lastAutoCompactAt > cooldownMs);
}

/** auto-compact 지시 메시지 생성 (순수 함수) */
export function buildAutoCompactMessage(totalChars: number): string {
  return `<forgen-auto-compact>
[Forgen] Context 사용량이 ${Math.round(totalChars / 1000)}K 문자에 도달했습니다 (추정 ~20%+).
지금 즉시 /compact를 실행하여 컨텍스트를 압축하세요. 이 지시는 자동으로 생성되었습니다.
현재 작업을 마무리하지 말고, 다음 응답에서 바로 compact를 실행하세요.
</forgen-auto-compact>`;
}

/** 경고 메시지 생성 (순수 함수) */
export function buildContextWarningMessage(promptCount: number, totalChars: number): string {
  return `<compound-context-warning>\n[Forgen] Context limit approaching: ${promptCount} prompts, ${Math.round(totalChars / 1000)}K characters.\nIf you have important progress, save it now:\n- Use cancelforgen to reset mode state and start a new session\n- Or continue current work (auto compaction may occur)\n</compound-context-warning>`;
}

function loadContextState(sessionId: string): ContextState {
  try {
    if (fs.existsSync(CONTEXT_STATE_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONTEXT_STATE_PATH, 'utf-8'));
      if (data.sessionId === sessionId) return data;
    }
  } catch (e) { log.debug('context state 파일 읽기/파싱 실패', e); }
  return { promptCount: 0, totalChars: 0, lastWarningAt: 0, lastAutoCompactAt: 0, sessionId };
}

function saveContextState(state: ContextState): void {
  atomicWriteJSON(CONTEXT_STATE_PATH, state);
}

export async function main(): Promise<void> {
  const _hookStart = Date.now();
  let _hookEvent = 'UserPromptSubmit';
  try {
  const input = await readStdinJSON<{ prompt?: string; session_id?: string; stop_hook_type?: string; error?: string }>();
  if (!isHookEnabled('context-guard')) {
    console.log(approve());
    return;
  }
  if (!input) {
    console.log(approve());
    return;
  }

  const sessionId = input.session_id ?? 'default';

  // Stop 훅: stop_hook_type이 있으면 처리
  if (input.stop_hook_type) {
    _hookEvent = 'Stop';

    // forge-loop 활성 시 미완료 스토리 감지 → 지속 메시지 주입 (polite-stop 방지)
    const forgeLoopBlock = checkForgeLoopActive();
    if (forgeLoopBlock) {
      console.log(forgeLoopBlock);
      return;
    }

    // 에러가 포함된 경우: context limit 감지
    if (input.error) {
      const errorMsg = input.error;
      if (/context.*limit|token.*limit|conversation.*too.*long/i.test(errorMsg)) {
        saveHandoff(sessionId, 'context-limit', errorMsg);
        try {
          const resumePath = path.join(STATE_DIR, 'pending-resume.json');
          fs.writeFileSync(resumePath, JSON.stringify({
            reason: 'token-limit',
            sessionId,
            savedAt: new Date().toISOString(),
            cwd: process.env.FORGEN_CWD ?? process.env.COMPOUND_CWD ?? process.cwd(),
          }, null, 2));
        } catch { /* fail-open */ }
        console.log(approveWithWarning(`[Forgen] Context limit reached. Current state has been saved to ~/.forgen/handoffs/.\nThe previous work will be automatically recovered in the next session.`));
        return;
      }
    }

    // 정상 종료 시: 의미 있는 세션이었으면 compound 안내/자동 트리거
    if (input.stop_hook_type === 'user' || input.stop_hook_type === 'end_turn') {
      const state = loadContextState(sessionId);
      if (state.promptCount >= 20) {
        // 20+ prompts: auto-trigger compound by writing marker
        try {
          fs.mkdirSync(STATE_DIR, { recursive: true });
          const marker = { reason: 'session-end', promptCount: state.promptCount, detectedAt: new Date().toISOString() };
          fs.writeFileSync(path.join(STATE_DIR, 'pending-compound.json'), JSON.stringify(marker));
        } catch { /* fail-open: marker write failure is non-critical */ }
        const summary = buildSessionSummary(sessionId, state.promptCount);
        console.log(approveWithWarning(
          `[Forgen] Session with ${state.promptCount} prompts ended.\n${summary}\nCompound loop will auto-trigger on next session start.`
        ));
        return;
      }
      if (state.promptCount >= 10) {
        // 10-19 prompts: suggest /compound manually
        const summary = buildSessionSummary(sessionId, state.promptCount);
        console.log(approveWithWarning(
          `[Forgen] 이 세션에서 ${state.promptCount}개의 프롬프트를 처리했습니다.\n${summary}/compound 를 실행하면 이 세션의 학습 내용을 축적할 수 있습니다.`
        ));
        return;
      }
    }

    console.log(approve());
    return;
  }

  // error만 있는 경우 (stop_hook_type 없이)
  if (input.error) {
    console.log(approve());
    return;
  }

  // UserPromptSubmit 훅: 대화 길이 추적
  if (input.prompt) {
    const config = loadHookConfig('context-guard');
    // maxTokens가 설정되어 있으면 chars threshold로 사용 (토큰 ≈ 4자 기준 환산)
    const charsThreshold =
      typeof config?.maxTokens === 'number' ? config.maxTokens * 4 : undefined;

    const state = loadContextState(sessionId);
    state.promptCount++;
    state.totalChars += input.prompt.length;

    // auto-compact: 추적 문자 120K 이상이면 compact 지시 주입
    const autoCompactThreshold =
      typeof config?.autoCompactChars === 'number' ? config.autoCompactChars : undefined;
    if (shouldAutoCompact(state, autoCompactThreshold !== undefined ? { charsThreshold: autoCompactThreshold } : {})) {
      state.lastAutoCompactAt = Date.now();
      saveContextState(state);
      console.log(approveWithContext(buildAutoCompactMessage(state.totalChars), 'UserPromptSubmit'));
      return;
    }

    if (shouldWarn(state, charsThreshold !== undefined ? { charsThreshold } : {})) {
      state.lastWarningAt = Date.now();
      saveContextState(state);
      console.log(approveWithContext(buildContextWarningMessage(state.promptCount, state.totalChars), 'UserPromptSubmit'));
      return;
    }

    saveContextState(state);
  }

  console.log(approve());
  } finally {
    recordHookTiming('context-guard', Date.now() - _hookStart, _hookEvent);
  }
}

/**
 * 세션 종료 시 "forgen이 도움이 된 정도"를 요약.
 * solution-cache에서 이번 세션에 주입된 compound 솔루션 수를 집계하여
 * 카운터팩추얼 "forgen 없었으면 ~N분 더 걸렸을 것" 메시지 생성.
 */
function buildSessionSummary(sessionId: string, promptCount: number): string {
  try {
    const cachePath = path.join(STATE_DIR, `solution-cache-${sessionId}.json`);
    if (!fs.existsSync(cachePath)) return '';
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as {
      injected?: Array<{ name: string; injectedAt: string }>;
    };
    const injected = Array.isArray(cache.injected) ? cache.injected : [];
    if (injected.length === 0) return '';

    // 카운터팩추얼: 주입된 compound 1건당 평균 8분 절약 가정 (하한 추정)
    const savedMins = injected.length * 8;
    const savedStr = savedMins >= 60
      ? `${Math.floor(savedMins / 60)}시간 ${savedMins % 60}분`
      : `${savedMins}분`;

    // 상위 3개 솔루션
    const topNames = injected.slice(0, 3).map(i => `"${i.name}"`).join(', ');
    const moreCount = injected.length - 3;
    const topStr = moreCount > 0 ? `${topNames} 외 ${moreCount}개` : topNames;

    return [
      `\n📊 이번 세션 forgen 효과:`,
      `  주입된 compound: ${injected.length}건 (${topStr})`,
      `  추정 절약 시간: ${savedStr} (forgen 없었으면 시행착오 필요)`,
      `  프롬프트 대비 효율: ${(injected.length / promptCount * 100).toFixed(0)}% 의 대화가 축적된 지식의 도움을 받음\n`,
    ].join('\n');
  } catch {
    return '';
  }
}

// forge-loop 상태 파일 경로
const FORGE_LOOP_STATE_PATH = path.join(STATE_DIR, 'forge-loop.json');

// forge-loop 차단 안전 상한 (무한 루프 방지)
const FORGE_LOOP_MAX_BLOCKS = 30;
const FORGE_LOOP_STALE_MS = 2 * 60 * 60 * 1000; // 2시간

interface ForgeLoopStory {
  id: string;
  title: string;
  passes: boolean;
  attempts?: number;
}

interface ForgeLoopState {
  active: boolean;
  startedAt: string;
  lastBlockAt?: string;
  blockCount?: number;
  stories: ForgeLoopStory[];
  awaitingConfirmation?: boolean;
}

/**
 * forge-loop 활성 시 미완료 스토리가 있으면 Stop을 차단하고 지속 메시지 주입.
 * OMC의 persistent-mode.cjs 패턴 참고.
 */
export function checkForgeLoopActive(): string | null {
  try {
    if (!fs.existsSync(FORGE_LOOP_STATE_PATH)) return null;

    const state: ForgeLoopState = JSON.parse(fs.readFileSync(FORGE_LOOP_STATE_PATH, 'utf-8'));
    if (!state.active) return null;

    // Stale 감지: 2시간+ 미활동 → 자동 비활성화
    const startedAt = new Date(state.startedAt).getTime();
    if (Number.isFinite(startedAt) && Date.now() - startedAt > FORGE_LOOP_STALE_MS) {
      state.active = false;
      atomicWriteJSON(FORGE_LOOP_STATE_PATH, state);
      return null;
    }

    // 확인 대기 중이면 차단하지 않음 (사용자 개입 허용)
    if (state.awaitingConfirmation) return null;

    // 안전 상한: 30회 이상 차단 시 무한 루프로 간주하여 해제
    const blockCount = state.blockCount ?? 0;
    if (blockCount >= FORGE_LOOP_MAX_BLOCKS) {
      state.active = false;
      atomicWriteJSON(FORGE_LOOP_STATE_PATH, state);
      return null;
    }

    // 미완료 스토리 확인
    const stories = Array.isArray(state.stories) ? state.stories : [];
    const pending = stories.filter((s) => !s.passes);
    if (pending.length === 0) {
      // 모든 스토리 완료 → forge-loop 종료
      state.active = false;
      atomicWriteJSON(FORGE_LOOP_STATE_PATH, state);
      return null;
    }

    // 차단 카운트 증가 + 지속 메시지 주입
    state.blockCount = blockCount + 1;
    state.lastBlockAt = new Date().toISOString();
    atomicWriteJSON(FORGE_LOOP_STATE_PATH, state);

    const nextStory = pending[0];
    const message = [
      `<forgen-forge-loop iteration="${state.blockCount}/${FORGE_LOOP_MAX_BLOCKS}">`,
      `[FORGE-LOOP] ${pending.length}개 스토리가 미완료입니다.`,
      `현재 스토리: ${nextStory.id} — ${nextStory.title}`,
      ``,
      `계속 진행하세요. 보고는 다음 시점에만 합니다:`,
      `  1. 모든 스토리 완료 (최종 리포트)`,
      `  2. 3회 실패 (에스컬레이션)`,
      `  3. Context limit 접근 (handoff)`,
      ``,
      `중간 "완료했습니다" 보고는 polite-stop anti-pattern입니다.`,
      `취소하려면: "/forge-loop cancel" 또는 "cancelforgen" 입력`,
      `</forgen-forge-loop>`,
    ].join('\n');

    // block 결정으로 Claude가 계속 작업하도록 강제
    return JSON.stringify({
      continue: true,
      decision: 'block',
      reason: message,
    });
  } catch (e) {
    // fail-open: forge-loop 상태 읽기 실패는 차단하지 않음
    log.debug('forge-loop 상태 확인 실패', e);
    return null;
  }
}

function saveHandoff(sessionId: string, reason: string, detail: string): void {
  fs.mkdirSync(HANDOFFS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const handoffPath = path.join(HANDOFFS_DIR, `${timestamp}-${reason}.md`);

  // 활성 모드 상태 수집
  const stateDir = STATE_DIR;
  const activeStates: string[] = [];
  if (fs.existsSync(stateDir)) {
    for (const f of fs.readdirSync(stateDir)) {
      if (f.endsWith('-state.json') && !f.startsWith('skill-cache-') && !f.startsWith('context-guard')) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf-8'));
          if (data.active) {
            activeStates.push(`- ${f.replace('-state.json', '')}: ${data.prompt ?? 'no prompt'}`);
          }
        } catch (e) { log.debug(`상태 파일 파싱 실패: ${f}`, e); }
      }
    }
  }

  const content = [
    `# Handoff: ${reason}`,
    `- Session: ${sessionId}`,
    `- Time: ${new Date().toISOString()}`,
    `- Reason: ${detail}`,
    '',
    '## Active Modes',
    activeStates.length > 0 ? activeStates.join('\n') : '- none',
    '',
    '## Recovery Instructions',
    'Automatically recovered in the next session (session-recovery hook).',
    'Manual recovery: Check the last state of the previous work and continue from there.',
  ].join('\n');

  fs.writeFileSync(handoffPath, content);
}

// ESM main guard: import 시 main() 실행 방지
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[ch-hook] ${e instanceof Error ? e.message : String(e)}\n`);
    console.log(failOpenWithTracking('context-guard'));
  });
}
