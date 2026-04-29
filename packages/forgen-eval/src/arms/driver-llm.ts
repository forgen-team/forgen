/**
 * Driver LLM — plays the "Claude" role in simulated multi-turn dialogue.
 * Uses local Ollama. Could be swapped for Claude API or Codex CLI in v0.6+.
 */

export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface DriverConfig {
  host?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class OllamaDriverLLM {
  private readonly host: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(cfg: DriverConfig = {}) {
    this.host = cfg.host ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
    this.model = cfg.model ?? process.env.OLLAMA_DRIVER_MODEL ?? 'qwen2.5:14b';
    this.temperature = cfg.temperature ?? 0.3;
    this.maxTokens = cfg.maxTokens ?? 512;
  }

  async chat(history: ChatTurn[]): Promise<string> {
    const res = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: history,
        stream: false,
        options: { temperature: this.temperature, num_predict: this.maxTokens },
      }),
    });
    if (!res.ok) throw new Error(`Ollama chat ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? '';
  }
}
