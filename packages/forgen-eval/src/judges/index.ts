/**
 * Judge factory + track resolution (DEV Triple / PUBLIC Dual).
 */

import { SonnetClient } from './sonnet-client.js';
import { OllamaClient } from './ollama-client.js';
import type { JudgeClient } from './judge-types.js';
import type { Track } from '../types.js';

export function buildJudgePanel(track: Track): JudgeClient[] {
  if (track === 'DEV') {
    return [new SonnetClient(), new OllamaClient('qwen-72b'), new OllamaClient('llama-70b')];
  }
  // PUBLIC — local-only, no API cost
  return [new OllamaClient('qwen-72b'), new OllamaClient('llama-70b')];
}

export { SonnetClient } from './sonnet-client.js';
export { OllamaClient } from './ollama-client.js';
export type { JudgeClient, JudgePromptInput, JudgeAxis } from './judge-types.js';
export { buildJudgePrompt, parseJudgeOutput } from './judge-types.js';
