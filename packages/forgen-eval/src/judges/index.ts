/**
 * Judge factory + track resolution (DEV Triple / PUBLIC Dual / API_DEV CLI-Dual).
 */

import { SonnetClient } from './sonnet-client.js';
import { OllamaClient } from './ollama-client.js';
import { ClaudeCliClient } from './claude-cli-client.js';
import { CodexCliClient } from './codex-cli-client.js';
import type { JudgeClient } from './judge-types.js';
import type { Track } from '../types.js';

export function buildJudgePanel(track: Track): JudgeClient[] {
  if (track === 'DEV') {
    return [new SonnetClient(), new OllamaClient('qwen-72b'), new OllamaClient('llama-70b')];
  }
  if (track === 'API_DEV') {
    // v0.4.4 subscription-mode — claude CLI + codex CLI (different families = κ-independent)
    return [new ClaudeCliClient(), new CodexCliClient()];
  }
  // PUBLIC — local-only, no API cost
  return [new OllamaClient('qwen-72b'), new OllamaClient('llama-70b')];
}

export { SonnetClient } from './sonnet-client.js';
export { OllamaClient } from './ollama-client.js';
export { ClaudeCliClient } from './claude-cli-client.js';
export { CodexCliClient } from './codex-cli-client.js';
export type { JudgeClient, JudgePromptInput, JudgeAxis } from './judge-types.js';
export { buildJudgePrompt, parseJudgeOutput } from './judge-types.js';
