#!/usr/bin/env node
/**
 * Forgen — PostToolUse Hook
 *
 * 도구 실행 후 결과 검증 + 파일 변경 추적.
 * Compound/workflow 핸들러는 ./post-tool-handlers.ts에 분리.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../core/logger.js';

const log = createLogger('post-tool-use');
import { readStdinJSON } from './shared/read-stdin.js';
import { sanitizeId } from './shared/sanitize-id.js';
import { atomicWriteJSON } from './shared/atomic-write.js';
import { saveCheckpoint } from './session-recovery.js';
// v1: recordWriteContent (regex 선호 감지) 제거
import { incrementFailureCounter, checkCompoundNegative, getCompoundSuccessHint } from './post-tool-handlers.js';
import { isHookEnabled } from './hook-config.js';
import { approve, approveWithWarning, failOpenWithTracking } from './shared/hook-response.js';
import { STATE_DIR } from '../core/paths.js';
import { recordHookTiming } from './shared/hook-timing.js';
import { type DriftState, createDriftState, evaluateDrift } from '../core/drift-score.js';

// ── Types ──

interface PostToolInput {
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  tool_response?: string;
  toolOutput?: string;
  session_id?: string;
  cwd?: string;
  model_id?: string;
}

interface ModifiedFilesState {
  sessionId: string;
  files: Record<string, { count: number; lastModified: string; tool: string }>;
  toolCallCount: number;
  /** Track recent write content hashes for revert detection */
  recentWrites?: Record<string, string[]>;
  /** Drift detection state */
  drift?: DriftState;
}

/** Lightweight hash for content comparison (not cryptographic) */
function simpleHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

const IMPLICIT_FEEDBACK_LOG = path.join(STATE_DIR, 'implicit-feedback.jsonl');

/** Record implicit feedback signal to JSONL */
function recordImplicitFeedback(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(IMPLICIT_FEEDBACK_LOG, JSON.stringify(entry) + '\n');
  } catch { /* fail-open: implicit feedback recording must not throw */ }
}

// ── State management ──

function getModifiedFilesPath(sessionId: string): string {
  return path.join(STATE_DIR, `modified-files-${sanitizeId(sessionId)}.json`);
}

function loadModifiedFiles(sessionId: string): ModifiedFilesState {
  try {
    const filePath = getModifiedFilesPath(sessionId);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) { log.debug('modified files state load failed — starting fresh', e); }
  return { sessionId, files: {}, toolCallCount: 0 };
}

function saveModifiedFiles(state: ModifiedFilesState): void {
  atomicWriteJSON(getModifiedFilesPath(state.sessionId), state);
}

// ── Exported utilities ──

export const ERROR_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /ENOENT|no such file/i, description: 'file not found' },
  { pattern: /EACCES|permission denied/i, description: 'permission denied' },
  { pattern: /ENOSPC|no space left/i, description: 'disk space insufficient' },
  { pattern: /syntax error|SyntaxError/i, description: 'syntax error' },
  { pattern: /segmentation fault|SIGSEGV/i, description: 'segmentation fault' },
  { pattern: /out of memory|OOM/i, description: 'out of memory' },
];

export function detectErrorPattern(text: string): { pattern: RegExp; description: string } | null {
  for (const entry of ERROR_PATTERNS) {
    if (entry.pattern.test(text)) return entry;
  }
  return null;
}

// ── Agent output validation (Tier 2-F) ──

export interface AgentValidationResult {
  signal: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

const AGENT_MIN_OUTPUT_LENGTH = 50;

const AGENT_QUALITY_PATTERNS: Array<{ pattern: RegExp; signal: string; severity: 'warning' | 'error'; message: string }> = [
  { pattern: /I (?:couldn'?t|could not|was unable to|cannot) (?:find|locate|access|determine)/i, signal: 'agent_unable', severity: 'warning', message: 'Agent reported inability to complete the task' },
  { pattern: /(?:no (?:files?|results?|matches?) found|returned? (?:no|empty|zero) results?)/i, signal: 'agent_no_results', severity: 'warning', message: 'Agent found no results' },
  { pattern: /(?:timed? ?out|deadline exceeded|execution expired)/i, signal: 'agent_timeout', severity: 'error', message: 'Agent execution may have timed out' },
  { pattern: /(?:context (?:window|limit) (?:exceeded|reached)|too (?:large|long) to (?:read|process))/i, signal: 'agent_context_overflow', severity: 'warning', message: 'Agent hit context limits — output may be incomplete' },
];

export function validateAgentOutput(toolResponse: string): AgentValidationResult | null {
  if (!toolResponse || toolResponse.trim().length < AGENT_MIN_OUTPUT_LENGTH) {
    return {
      signal: 'agent_empty_output',
      severity: 'warning',
      message: `Agent returned minimal output (${toolResponse?.trim().length ?? 0} chars). Verify the result is usable.`,
    };
  }

  for (const p of AGENT_QUALITY_PATTERNS) {
    if (p.pattern.test(toolResponse)) {
      return { signal: p.signal, severity: p.severity, message: p.message };
    }
  }

  return null;
}

export function trackModifiedFile(
  state: ModifiedFilesState,
  filePath: string,
  toolName: string,
): { state: ModifiedFilesState; count: number } {
  const existing = state.files[filePath];
  const count = (existing?.count ?? 0) + 1;
  state.files[filePath] = {
    count,
    lastModified: new Date().toISOString(),
    tool: toolName,
  };
  return { state, count };
}

// ── Main flow ──

async function main(): Promise<void> {
  const _hookStart = Date.now();
  try {
  const data = await readStdinJSON<PostToolInput>();
  if (!data) {
    console.log(approve());
    return;
  }
  if (!isHookEnabled('post-tool-use')) {
    console.log(approve());
    return;
  }

  const toolName = data.tool_name ?? data.toolName ?? '';
  const toolInput = data.tool_input ?? data.toolInput ?? {};
  const toolResponse = data.tool_response ?? data.toolOutput ?? '';
  const sessionId = data.session_id ?? 'default';

  const modState = loadModifiedFiles(sessionId);
  modState.toolCallCount = (modState.toolCallCount ?? 0) + 1;

  const messages: string[] = [];
  let revertDetected = false;

  // 1. Checkpoint (every 5 calls)
  if (modState.toolCallCount % 5 === 0) {
    try {
      saveCheckpoint({
        sessionId, mode: 'active',
        modifiedFiles: Object.keys(modState.files),
        lastToolCall: toolName,
        toolCallCount: modState.toolCallCount,
        timestamp: new Date().toISOString(),
        cwd: data.cwd ?? process.env.FORGEN_CWD ?? process.env.COMPOUND_CWD ?? process.cwd(),
      });
    } catch (e) { log.debug('체크포인트 저장 실패', e); }
  }

  // 2. File change tracking (Write, Edit) + implicit feedback detection
  if (toolName === 'Write' || toolName === 'Edit') {
    const filePath = (toolInput.file_path as string) ?? (toolInput.filePath as string) ?? '';
    if (filePath) {
      try {
        const { count } = trackModifiedFile(modState, filePath, toolName);

        // Implicit feedback: repeated edit detection (5+ edits on same file)
        if (count >= 5) {
          messages.push(`<compound-tool-warning>\n[Forgen] ⚠ ${path.basename(filePath)} has been modified ${count} times.\nConsider redesigning the overall structure and restarting.\n</compound-tool-warning>`);
          recordImplicitFeedback({
            type: 'repeated_edit',
            file: filePath,
            editCount: count,
            at: new Date().toISOString(),
            sessionId,
          });
        }

        // Implicit feedback: revert detection
        // Track content hashes of recent writes to detect when content is reverted
        const newContent = (toolInput.content as string) ?? (toolInput.new_string as string) ?? '';
        if (newContent) {
          const hash = simpleHash(newContent);
          if (!modState.recentWrites) modState.recentWrites = {};
          const prevHashes = modState.recentWrites[filePath] ?? [];

          // Check if this content hash matches a previous write (revert pattern)
          // Skip the most recent hash (which would be the write being "reverted from")
          if (prevHashes.length >= 2 && prevHashes.slice(0, -1).includes(hash)) {
            revertDetected = true;
            recordImplicitFeedback({
              type: 'revert_detected',
              file: filePath,
              at: new Date().toISOString(),
              sessionId,
            });
          }

          // Keep last 10 hashes per file
          prevHashes.push(hash);
          if (prevHashes.length > 10) prevHashes.splice(0, prevHashes.length - 10);
          modState.recentWrites[filePath] = prevHashes;
        }
      } catch (e) { log.debug('파일 변경 추적 실패', e); }
    }
  }

  // 3. Drift score evaluation
  if (toolName === 'Write' || toolName === 'Edit') {
    if (!modState.drift) modState.drift = createDriftState(sessionId);
    const driftResult = evaluateDrift(modState.drift, true, revertDetected);
    if (driftResult.message) {
      messages.push(`<compound-tool-warning>\n${driftResult.message}\n</compound-tool-warning>`);
      recordImplicitFeedback({
        type: driftResult.level === 'critical' || driftResult.level === 'hardcap' ? 'drift_critical' : 'drift_warning',
        score: driftResult.score,
        totalEdits: modState.drift.totalEdits,
        totalReverts: modState.drift.totalReverts,
        at: new Date().toISOString(),
        sessionId,
      });
    }
  }

  // 4. Agent output validation (Tier 2-F)
  if (toolName === 'Agent') {
    const agentResult = validateAgentOutput(toolResponse);
    if (agentResult) {
      messages.push(`<compound-agent-validation>\n[Forgen] ${agentResult.severity === 'error' ? '⛔' : '⚠'} ${agentResult.message}\n</compound-agent-validation>`);
      recordImplicitFeedback({
        type: `agent_${agentResult.signal}`,
        severity: agentResult.severity,
        outputLength: toolResponse.trim().length,
        at: new Date().toISOString(),
        sessionId,
      });
    }
  }

  // 5. Bash error detection
  if (toolName === 'Bash' && toolResponse) {
    const errorMatch = detectErrorPattern(toolResponse);
    if (errorMatch) {
      incrementFailureCounter(sessionId);
      messages.push(`<compound-tool-info>\n[Forgen] Error pattern detected in execution result: "${errorMatch.description}". Review may be needed.\n</compound-tool-info>`);
    }
  }

  // 6. Compound negative signal (non-blocking)
  try { checkCompoundNegative(toolName, toolResponse, sessionId); } catch (e) { log.debug('compound negative check 실패', e); }

  // 6a. ADR-001 Mech-A PostToolUse dispatcher — pattern_match verifier.
  // 도구 출력물 (Write content / Bash response 등) 에서 enforce_via[PostToolUse].pattern_match 매칭.
  // PostToolUse 는 이미 실행된 후라 block 불가 → warning + violation 기록.
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Bash') {
    try {
      const target = ((): string => {
        const c = (toolInput as { content?: unknown }).content;
        if (typeof c === 'string') return c;
        const ns = (toolInput as { new_string?: unknown }).new_string;
        if (typeof ns === 'string') return ns;
        const cmd = (toolInput as { command?: unknown }).command;
        if (typeof cmd === 'string') return cmd;
        return '';
      })() || toolResponse;
      if (target) {
        const [{ loadActiveRules }, { recordViolation }] = await Promise.all([
          import('../store/rule-store.js'),
          import('../engine/lifecycle/signals.js'),
        ]);
        const rules = loadActiveRules();
        for (const rule of rules) {
          for (const spec of rule.enforce_via ?? []) {
            if (spec.hook !== 'PostToolUse' || spec.mech !== 'A') continue;
            const v = spec.verifier;
            if (!v || v.kind !== 'pattern_match') continue;
            const pattern = String(v.params?.pattern ?? '');
            if (!pattern) continue;
            if (!new RegExp(pattern).test(target)) continue;
            recordViolation({
              rule_id: rule.rule_id, session_id: sessionId,
              source: 'post-tool-guard',
              kind: 'block',
              message_preview: target.slice(0, 120),
            });
            messages.push(
              `<compound-rule-violation>\n[Forgen] Rule ${rule.rule_id.slice(0, 8)} pattern matched in ${toolName} output.\n${spec.block_message ?? rule.policy.slice(0, 120)}\n</compound-rule-violation>`
            );
          }
        }
      }
    } catch (e) { log.debug('enforce_via[PostToolUse] dispatch 실패', e); }
  }

  // 6b. Bypass detection (T3 signal for ADR-002 lifecycle).
  // Scan Write/Edit content or Bash command against active rules' negative-intent policies.
  // Fail-open: bypass detection must never block tool execution.
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Bash') {
    try {
      const content = typeof (toolInput as { content?: unknown }).content === 'string'
        ? String((toolInput as { content: string }).content)
        : typeof (toolInput as { new_string?: unknown }).new_string === 'string'
        ? String((toolInput as { new_string: string }).new_string)
        : typeof (toolInput as { command?: unknown }).command === 'string'
        ? String((toolInput as { command: string }).command)
        : '';
      const target = content || toolResponse;
      if (target) {
        const [{ loadActiveRules }, { scanForBypass }, { recordBypass }] = await Promise.all([
          import('../store/rule-store.js'),
          import('../engine/lifecycle/bypass-detector.js'),
          import('../engine/lifecycle/signals.js'),
        ]);
        const rules = loadActiveRules();
        const candidates = scanForBypass({ rules, tool_name: toolName, tool_output: target, session_id: sessionId });
        for (const c of candidates) {
          recordBypass({ rule_id: c.rule_id, session_id: c.session_id, tool: c.tool, pattern_preview: c.pattern_preview });
        }
      }
    } catch (e) { log.debug('bypass detect 실패', e); }
  }

  // 7. Compound success hint (non-blocking)
  try {
    const successHint = getCompoundSuccessHint(toolName, toolResponse, sessionId);
    if (successHint) messages.push(successHint);
  } catch (e) { log.debug('success hint generation 실패', e); }

  saveModifiedFiles(modState);

  if (messages.length > 0) {
    console.log(approveWithWarning(messages.join('\n')));
  } else {
    console.log(approve());
  }
  } finally {
    recordHookTiming('post-tool-use', Date.now() - _hookStart, 'PostToolUse');
  }
}

main().catch((e) => {
  process.stderr.write(`[ch-hook] ${e instanceof Error ? e.message : String(e)}\n`);
  console.log(failOpenWithTracking('post-tool-use'));
});
