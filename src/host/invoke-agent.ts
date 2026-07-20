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
import type { HostId } from '../core/trust-layer-intent.js';

const MAX_DEPTH = 2;
const MAX_CONCURRENT = 3;
let activeInvocations = 0;

export interface InvokeAgentOptions {
  agentName: string;
  task: string;
  /** Child process timeout (ms). Default 60s. */
  timeoutMs?: number;
  /** Override host (default: profile.default_host). */
  host?: HostId;
}

export interface InvokeAgentResult {
  agentName: string;
  host: HostId;
  summary: string;
  durationMs: number;
  usage: ExecHostResult['usage'];
}

function findAgentsRoot(): string {
  // Phase 3 critic fix: 단순 디렉토리 매치 시 모노레포의 동명 디렉토리 위험.
  // package.json 의 name === '@wooojin/forgen' 검증으로 *정확한 forgen pkg root* 확정.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const pkgJson = path.join(dir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
        if (pkg.name === '@wooojin/forgen') {
          const candidate = path.join(dir, 'assets', 'claude', 'agents');
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch { /* fallthrough — 다음 walk-up */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('invoke-agent: forgen pkg root + assets/claude/agents/ not found');
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
  // Phase 3 critic fix: BOM + CRLF 정규화 (Windows / Notion 파일 호환)
  const normalized = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const description = fmMatch?.[1].match(/description:\s*(.+)/)?.[1].trim() ?? safeName;
  const body = fmMatch?.[2]?.trim() ?? normalized;
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
  // Phase 3 critic fix: depth 외에 fan-out 도 제한.
  // depth 2 에서 N 개 sibling invoke 가 동시 시작되면 N² child spawn 가능 →
  // 비용/timeout cascading. process-level concurrency limit MAX_CONCURRENT 로 제한.
  const currentDepth = parseInt(process.env.FORGEN_INVOKE_DEPTH ?? '0', 10);
  if (currentDepth >= MAX_DEPTH) {
    throw new Error(`invoke-agent: max recursion depth ${MAX_DEPTH} exceeded (current=${currentDepth})`);
  }
  if (activeInvocations >= MAX_CONCURRENT) {
    throw new Error(
      `invoke-agent: max concurrent invocations ${MAX_CONCURRENT} reached (active=${activeInvocations}). ` +
      'Sibling sub-agents must run sequentially.',
    );
  }

  const { systemPrompt, description } = loadAgentDefinition(opts.agentName);
  const prompt = buildAgentPrompt({ agentName: opts.agentName, description, systemPrompt, task: opts.task });

  const startedAt = Date.now();
  activeInvocations += 1;
  try {
    // Phase 3 critic fix: default timeout 60s → 90s (codex sandbox startup +
    // 인증 + LLM 응답까지 60s 부족할 수 있음. tail latency 안전마진).
    const result = execHost({
      prompt,
      timeout: opts.timeoutMs ?? 90000,
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
  } finally {
    activeInvocations -= 1;
  }
}
