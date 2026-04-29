/**
 * Sonnet 4.6 judge — DEV track only (Claude Max).
 * Uses Anthropic SDK if available; throws if API key missing.
 */

import { buildJudgePrompt, parseJudgeOutput } from './judge-types.js';
import type { JudgeClient, JudgePromptInput } from './judge-types.js';
import type { JudgeScore } from '../types.js';

export class SonnetClient implements JudgeClient {
  readonly id = 'sonnet' as const;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.model = opts.model ?? 'claude-sonnet-4-6';
    if (!this.apiKey) {
      throw new Error('SonnetClient: ANTHROPIC_API_KEY is required (DEV track only)');
    }
  }

  async judge(input: JudgePromptInput): Promise<JudgeScore> {
    const prompt = buildJudgePrompt(input);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`Sonnet API ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { content: { text: string }[] };
    const raw = data.content[0]?.text ?? '';
    const parsed = parseJudgeOutput(raw);
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
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      return { ok: res.ok, latencyMs: Date.now() - start, modelInfo: this.model };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}
