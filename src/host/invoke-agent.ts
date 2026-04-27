/**
 * invoke-agent — feat/codex-support P3-4/P3-5
 *
 * forgen 의 sub-agent (assets/claude/agents/<name>.md) 를 host-aware 로 호출.
 * Claude 의 Task tool 동치 — 별도 child process 에서 sub-agent 의 system prompt 를
 * prefix 로 사용자 task 실행 후 결과 반환.
 *
 * Recursion guard: FORGEN_INVOKE_DEPTH env var 로 depth 추적, max 2 (sub-agent 가
 * 또 sub-agent 호출 시도 → 차단).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execHost, type ExecHostResult } from './exec-host.js';

const MAX_DEPTH = 2;

export interface InvokeAgentOptions {
  agentName: string;
  task: string;
  /** Child process timeout (ms). Default 60s. */
  timeoutMs?: number;
  /** Override host (default: profile.default_host). */
  host?: 'claude' | 'codex';
}

export interface InvokeAgentResult {
  agentName: string;
  host: 'claude' | 'codex';
  summary: string;
  durationMs: number;
  usage: ExecHostResult['usage'];
}

function findAgentsRoot(): string {
  // Find pkg root by walking up from this module's path until assets/claude/agents/ found.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, 'assets', 'claude', 'agents');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('invoke-agent: assets/claude/agents/ not found from module location');
}

function loadAgentDefinition(agentName: string): { systemPrompt: string; description: string } {
  const safeName = agentName.replace(/[^a-zA-Z0-9_-]/g, '');
  if (safeName !== agentName || safeName.length === 0) {
    throw new Error(`invoke-agent: invalid agent_name "${agentName}" — use only [a-zA-Z0-9_-]`);
  }
  const root = findAgentsRoot();
  const filePath = path.join(root, `${safeName}.md`);
  if (!fs.existsSync(filePath)) {
    const available = fs.readdirSync(root)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    throw new Error(
      `invoke-agent: agent "${agentName}" not found. Available: ${available.join(', ')}`,
    );
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const description = fmMatch?.[1].match(/description:\s*(.+)/)?.[1].trim() ?? safeName;
  const body = fmMatch?.[2]?.trim() ?? raw;
  return { systemPrompt: body, description };
}

function buildAgentPrompt(opts: { agentName: string; description: string; systemPrompt: string; task: string }): string {
  return [
    `You are the "${opts.agentName}" sub-agent. ${opts.description}`,
    '',
    '<system-prompt>',
    opts.systemPrompt,
    '</system-prompt>',
    '',
    'TASK:',
    opts.task,
    '',
    'Respond with the deliverable — concise, focused on the task. No preamble.',
  ].join('\n');
}

export async function invokeAgent(opts: InvokeAgentOptions): Promise<InvokeAgentResult> {
  // Recursion guard
  const currentDepth = parseInt(process.env.FORGEN_INVOKE_DEPTH ?? '0', 10);
  if (currentDepth >= MAX_DEPTH) {
    throw new Error(`invoke-agent: max recursion depth ${MAX_DEPTH} exceeded (current=${currentDepth})`);
  }

  const { systemPrompt, description } = loadAgentDefinition(opts.agentName);
  const prompt = buildAgentPrompt({ agentName: opts.agentName, description, systemPrompt, task: opts.task });

  const startedAt = Date.now();
  const result = execHost({
    prompt,
    timeout: opts.timeoutMs ?? 60000,
    host: opts.host,
    env: { FORGEN_INVOKE_DEPTH: String(currentDepth + 1) },
  });
  const durationMs = Date.now() - startedAt;

  return {
    agentName: opts.agentName,
    host: result.host,
    summary: result.message,
    durationMs,
    usage: result.usage,
  };
}
