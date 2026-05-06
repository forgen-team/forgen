/**
 * Codex CLI judge — invokes `codex exec --json` subprocess.
 *
 * Subscription-mode: uses the user's ChatGPT/Codex session via `codex` CLI rather than
 * the OpenAI API directly (no OPENAI_API_KEY required). v0.4.4 API_DEV track.
 *
 * Different model family from ClaudeCliClient (Anthropic Sonnet vs OpenAI gpt-5-codex)
 * → independence assumption for κ holds reasonably.
 *
 * Latency: ~10s/call. Plan N accordingly.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildJudgePrompt, parseJudgeOutput } from './judge-types.js';
import type { JudgeClient, JudgePromptInput } from './judge-types.js';
import type { JudgeScore } from '../types.js';

const DEFAULT_TIMEOUT_MS = 120_000;

/** spawn-based exec that closes stdin so codex doesn't block on "Reading additional input from stdin..." */
function runCodex(
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`codex timeout after ${opts.timeoutMs}ms (stderr=${stderr.slice(0, 200)})`));
    }, opts.timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf-8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf-8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`codex exited ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Extract agent_message text from codex --json JSONL stream. */
function extractCodexText(rawJsonl: string): string {
  const lines = rawJsonl.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const obj = JSON.parse(t) as { type?: string; item?: { type?: string; text?: string } };
      if (obj.type === 'item.completed' && obj.item?.type === 'agent_message' && typeof obj.item.text === 'string') {
        return obj.item.text;
      }
    } catch {
      // skip non-JSON noise
    }
  }
  // include up to 500 chars of raw to debug parse failures
  throw new Error(
    `Codex output missing agent_message (raw len=${rawJsonl.length}): ${JSON.stringify(rawJsonl.slice(0, 500))}`,
  );
}

export class CodexCliClient implements JudgeClient {
  readonly id = 'codex-cli' as const;
  private readonly timeoutMs: number;
  private readonly cwd: string;

  constructor(opts: { timeoutMs?: number; cwd?: string } = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cwd = opts.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-eval-codex-'));
  }

  async judge(input: JudgePromptInput): Promise<JudgeScore> {
    const prompt = buildJudgePrompt(input);
    const stdout = await runCodex(
      [
        'exec',
        '--json',
        '--ignore-user-config',
        '--ignore-rules',
        '--ephemeral',
        '-s',
        'read-only',
        '-c',
        'approval_policy="never"',
        '--skip-git-repo-check',
        prompt,
      ],
      { cwd: this.cwd, timeoutMs: this.timeoutMs },
    );
    const text = extractCodexText(stdout);
    const parsed = parseJudgeOutput(text);
    return {
      caseId: input.caseId,
      blindedArmId: input.blindedArmId,
      judgeId: this.id,
      axis: input.axis,
      score: parsed.score,
      rationale: parsed.rationale,
    };
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; modelInfo?: string }> {
    const start = Date.now();
    try {
      const stdout = await runCodex(
        ['exec', '--json', '--ignore-user-config', '--ignore-rules', '--ephemeral', '-s', 'read-only', '-c', 'approval_policy="never"', '--skip-git-repo-check', 'Reply with just: ok'],
        { cwd: this.cwd, timeoutMs: 60_000 },
      );
      const text = extractCodexText(stdout);
      return { ok: /ok/i.test(text), latencyMs: Date.now() - start, modelInfo: 'codex exec --json' };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}
