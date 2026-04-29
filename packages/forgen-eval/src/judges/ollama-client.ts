/**
 * Ollama-based judge — Qwen 2.5 72B / Llama 3.3 70B (PUBLIC + DEV).
 * Local. Requires Ollama running on localhost:11434 (default).
 */

import { buildJudgePrompt, parseJudgeOutput } from './judge-types.js';
import type { JudgeClient, JudgePromptInput } from './judge-types.js';
import type { JudgeScore } from '../types.js';

export class OllamaClient implements JudgeClient {
  readonly id: 'qwen-72b' | 'llama-70b';
  private readonly host: string;
  private readonly model: string;

  constructor(id: 'qwen-72b' | 'llama-70b', opts: { host?: string; model?: string } = {}) {
    this.id = id;
    this.host = opts.host ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
    // Default models — quantized variants accepted via OLLAMA_<ID>_MODEL env.
    this.model =
      opts.model ??
      process.env[`OLLAMA_${id.toUpperCase().replace('-', '_')}_MODEL`] ??
      (id === 'qwen-72b' ? 'qwen2.5:72b-instruct-q4_K_M' : 'llama3.3:70b-instruct-q4_K_M');
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
