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
import type { JudgeScore, JudgeId } from '../types.js';
import { retryWithBackoff } from '../utils/retry.js';

const execFileAsync = promisify(execFile);

const DEFAULT_MODEL = process.env.CLAUDE_CLI_MODEL ?? 'haiku';
const DEFAULT_TIMEOUT_MS = Number(process.env.CLAUDE_CLI_TIMEOUT_MS ?? 60_000);

/** System prompt that fully replaces the default (which would load user CLAUDE.md and rules).
 *  `--system-prompt` 사용 시 CLAUDE.md auto-discovery는 비활성화되어 judge 격리가 성립.
 */
const JUDGE_SYSTEM_PROMPT =
  'You are a blind evaluator. Reply with ONLY a single JSON object that matches the schema in the user message. Do not use tools. Do not access files. Output JSON only, no prose, no markdown fences.';

export class ClaudeCliClient implements JudgeClient {
  // id 는 모델에서 유도 — 이중 Claude 패널(haiku+sonnet)에서 두 인스턴스가
  // 구분돼야 κ 가 haiku↔sonnet 을 짝지을 수 있다. sonnet → 'claude-cli-sonnet',
  // 그 외(haiku 기본) → 'claude-cli'. opts.id 로 명시 override 가능.
  readonly id: JudgeId;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly cwd: string;

  constructor(opts: { model?: string; id?: JudgeId; timeoutMs?: number; cwd?: string } = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.id = opts.id ?? (/sonnet/i.test(this.model) ? 'claude-cli-sonnet' : 'claude-cli');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cwd = opts.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-eval-claude-'));
  }

  async judge(input: JudgePromptInput): Promise<JudgeScore> {
    const prompt = buildJudgePrompt(input);
    const stdout = await retryWithBackoff(
      async () => {
        const res = await execFileAsync(
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
        return res.stdout;
      },
      { label: 'claude-judge' },
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
