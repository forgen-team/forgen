/**
 * Judge factory + track resolution (DEV Triple / PUBLIC Dual / API_DEV CLI-Dual).
 */

import { SonnetClient } from './sonnet-client.js';
import { OllamaClient } from './ollama-client.js';
import { ClaudeCliClient } from './claude-cli-client.js';
import { CodexCliClient } from './codex-cli-client.js';
import type { JudgeClient } from './judge-types.js';
import type { Track } from '../types.js';

/** 패널 id 가 전부 구분되는지 강제 — 중복 id 는 κ 입력을 뒤섞는다 (리뷰 #12 SEV-3). */
function assertDistinctIds(panel: JudgeClient[]): JudgeClient[] {
  const ids = panel.map((j) => j.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Judge panel has duplicate ids: ${ids.join(', ')} — κ pairing would collide`);
  }
  return panel;
}

export function buildJudgePanel(track: Track): JudgeClient[] {
  return assertDistinctIds(buildJudgePanelInner(track));
}

function buildJudgePanelInner(track: Track): JudgeClient[] {
  if (track === 'DEV') {
    return [new SonnetClient(), new OllamaClient('qwen-72b'), new OllamaClient('llama-70b')];
  }
  if (track === 'API_DEV') {
    // v0.4.4 subscription-mode — claude CLI + codex CLI (different families = κ-independent)
    return [new ClaudeCliClient(), new CodexCliClient()];
  }
  if (track === 'ENSEMBLE') {
    // v0.4.4+ 3-judge ensemble — API_DEV plus local Ollama (3 independent families)
    return [new ClaudeCliClient(), new CodexCliClient(), new OllamaClient('llama-8b')];
  }
  if (track === 'CLAUDE_DUAL') {
    // v0.5.0 R2 — codex 해지 후 Claude 전용. haiku + sonnet 이중 (둘 다 CLI, API키 불요).
    // ⚠ 계열-내(intra-family) 패널 — 자기선호 편향 가능. κ 는 "동일계열 일치도"로
    //   해석하고, 1차 지표는 저지-독립 behavioral 로 둔다 (metrics/behavioral.ts).
    return [
      new ClaudeCliClient({ model: 'haiku' }),
      new ClaudeCliClient({ model: 'sonnet' }),
    ];
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
