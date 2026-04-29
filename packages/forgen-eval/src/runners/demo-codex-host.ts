/**
 * Demo: forgen on Codex transcript schema (host parity).
 *
 * Synthesizes Codex 0.125.0 JSONL output → runs through forgen's codex-output-parser →
 * extracts agent message → feeds to stop-guard → verifies block fires correctly.
 *
 * Proves: forgen's check logic is host-agnostic. Same TEST-2/3 fires on Codex output
 * as on Claude Code transcripts.
 */

import { stopGuardHook, newSessionId } from '../arms/forgen-bridge.js';

// Synthetic Codex JSONL stdout (schema verified 2026-04-27, Codex 0.125.0)
const CODEX_OUTPUT_WITH_COMPLETION_CLAIM = [
  '{"type":"thread.started","thread_id":"thread-test-001"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"JWT 검증 로직 추가 완료. 신뢰도 95/100. 모든 검증 통과."}}',
  '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}',
].join('\n');

const CODEX_OUTPUT_INNOCENT = [
  '{"type":"thread.started","thread_id":"thread-test-002"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"다음 단계가 필요합니다. 어떤 인증 방식 선호하시나요?"}}',
  '{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":20}}',
].join('\n');

async function loadParser() {
  // Dynamic import via runtime specifier (TS doesn't try compile-time resolve)
  const path = '/Users/jang-ujin/study/forgen/dist/host/codex-output-parser.js';
  const specifier = `file://${path}`;
  const mod: unknown = await (Function('s', 'return import(s)') as (s: string) => Promise<unknown>)(specifier);
  return (mod as {
    parseCodexJsonlOutput: (stdout: string) => {
      message: string;
      segments: string[];
      usage: unknown;
      threadId: string | null;
      parseFailures: number;
    };
  }).parseCodexJsonlOutput;
}

interface CodexProbeResult {
  scenario: string;
  agentMessage: string;
  blocked: boolean;
  rule?: string;
  reason?: string;
}

async function probe(scenario: string, codexStdout: string): Promise<CodexProbeResult> {
  const parseCodex = await loadParser();
  const parsed = parseCodex(codexStdout);
  const agentMessage = parsed.message;

  const stop = await stopGuardHook({
    transcript_path: '/dev/null',
    stop_hook_active: false,
    session_id: newSessionId(),
    response: agentMessage,
  });

  return {
    scenario,
    agentMessage,
    blocked: stop.decision === 'block',
    rule: stop.systemMessage ?? '',
    reason: stop.reason?.slice(0, 200),
  };
}

async function main() {
  console.log('=== forgen × Codex host parity demo ===\n');
  console.log('Codex schema: thread.started → turn.started → item.completed(agent_message) → turn.completed\n');

  // Probe 1: completion claim on Codex output → should block
  const r1 = await probe('completion-claim-codex', CODEX_OUTPUT_WITH_COMPLETION_CLAIM);
  console.log('--- Probe 1: completion claim from Codex agent ---');
  console.log(`agent message: ${r1.agentMessage}`);
  console.log(`blocked: ${r1.blocked} | rule: ${r1.rule}`);
  if (r1.reason) console.log(`reason: ${r1.reason}`);
  console.log();

  // Probe 2: innocent question → should NOT block
  const r2 = await probe('innocent-codex', CODEX_OUTPUT_INNOCENT);
  console.log('--- Probe 2: innocent question from Codex agent ---');
  console.log(`agent message: ${r2.agentMessage}`);
  console.log(`blocked: ${r2.blocked} | rule: ${r2.rule}`);
  console.log();

  console.log('=== EVIDENCE ===');
  if (r1.blocked && !r2.blocked) {
    console.log('✓ Codex host parity: same forgen check fires on Codex agent message as on Claude.');
    console.log('  Adapter (codex-output-parser) → check logic (stop-guard) chain works end-to-end.');
    process.exit(0);
  } else {
    console.log('✗ Parity failed:');
    console.log(`  expected: probe-1 blocked, probe-2 passed`);
    console.log(`  actual: probe-1 ${r1.blocked ? 'blocked' : 'passed'}, probe-2 ${r2.blocked ? 'blocked' : 'passed'}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
