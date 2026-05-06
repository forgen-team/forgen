/**
 * Claude CLI judge — invokes `claude -p ... --model haiku` subprocess.
 *
 * Subscription-mode: uses the user's Claude Max session via `claude` CLI rather than
 * the Anthropic API directly (no ANTHROPIC_API_KEY required). v0.4.4 API_DEV track.
 *
 * Latency: ~10s/call (boot + haiku response). Plan N accordingly.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildJudgePrompt, parseJudgeOutput } from './judge-types.js';
import type { JudgeClient, JudgePromptInput } from './judge-types.js';
import type { JudgeScore } from '../types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_MODEL = 'haiku';
const DEFAULT_TIMEOUT_MS = 60_000;

/** System prompt that fully replaces the default (which would load user CLAUDE.md and rules).
 *  `--system-prompt` 사용 시 CLAUDE.md auto-discovery는 비활성화되어 judge 격리가 성립.
 */
const JUDGE_SYSTEM_PROMPT =
  'You are a blind evaluator. Reply with ONLY a single JSON object that matches the schema in the user message. Do not use tools. Do not access files. Output JSON only, no prose, no markdown fences.';

export class ClaudeCliClient implements JudgeClient {
  readonly id = 'claude-cli' as const;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly cwd: string;

  constructor(opts: { model?: string; timeoutMs?: number; cwd?: string } = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cwd = opts.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-eval-claude-'));
  }

  async judge(input: JudgePromptInput): Promise<JudgeScore> {
    const prompt = buildJudgePrompt(input);
    const { stdout } = await execFileAsync(
      'claude',
      ['-p', prompt, '--model', this.model, '--system-prompt', JUDGE_SYSTEM_PROMPT],
      {
        encoding: 'utf-8',
        timeout: this.timeoutMs,
        cwd: this.cwd,
        env: { ...process.env },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const parsed = parseJudgeOutput(stdout);
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
      const { stdout } = await execFileAsync(
        'claude',
        ['-p', 'Reply with just: ok', '--model', this.model, '--system-prompt', JUDGE_SYSTEM_PROMPT],
        { encoding: 'utf-8', timeout: 30_000, cwd: this.cwd, maxBuffer: 1024 * 1024 },
      );
      return { ok: /ok/i.test(stdout), latencyMs: Date.now() - start, modelInfo: `claude --model ${this.model}` };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}
