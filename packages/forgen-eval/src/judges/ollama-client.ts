/**
 * Ollama-based judge — Qwen 2.5 72B / Llama 3.3 70B (PUBLIC + DEV).
 * Local. Requires Ollama running on localhost:11434 (default).
 */

import { buildJudgePrompt, parseJudgeOutput } from './judge-types.js';
import type { JudgeClient, JudgePromptInput } from './judge-types.js';
import type { JudgeScore } from '../types.js';

type OllamaJudgeId = 'qwen-72b' | 'llama-70b' | 'qwen-14b' | 'llama-8b';

const DEFAULT_MODEL: Record<OllamaJudgeId, string> = {
  'qwen-72b': 'qwen2.5:72b-instruct-q4_K_M',
  'llama-70b': 'llama3.3:70b-instruct-q4_K_M',
  'qwen-14b': 'qwen2.5:14b',
  'llama-8b': 'llama3.1:8b',
};

export class OllamaClient implements JudgeClient {
  readonly id: OllamaJudgeId;
  private readonly host: string;
  private readonly model: string;

  constructor(id: OllamaJudgeId, opts: { host?: string; model?: string } = {}) {
    this.id = id;
    this.host = opts.host ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
    this.model =
      opts.model ??
      process.env[`OLLAMA_${id.toUpperCase().replace('-', '_')}_MODEL`] ??
      DEFAULT_MODEL[id];
  }

  async judge(input: JudgePromptInput): Promise<JudgeScore> {
    const prompt = buildJudgePrompt(input);
    const res = await fetch(`${this.host}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.1, num_predict: 256 },
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama ${this.model} ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { response: string };
    const parsed = parseJudgeOutput(data.response);
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
      const res = await fetch(`${this.host}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: this.model }),
      });
      return { ok: res.ok, latencyMs: Date.now() - start, modelInfo: this.model };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}
