/**
 * invoke-agent — P3-4/P3-5 단위 테스트
 *
 * 실 host CLI 호출은 비용/시간 큼 → mock 기반 unit test (loadAgentDefinition,
 * buildAgentPrompt, recursion guard) 만 검증. 실 호출은 별도 e2e 트랙.
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('../../src/host/invoke-agent.js');

let originalDepth: string | undefined;

beforeEach(() => {
  originalDepth = process.env.FORGEN_INVOKE_DEPTH;
});

afterEach(() => {
  if (originalDepth === undefined) delete process.env.FORGEN_INVOKE_DEPTH;
  else process.env.FORGEN_INVOKE_DEPTH = originalDepth;
  vi.restoreAllMocks();
});

describe('invokeAgent — input validation', () => {
  it('잘못된 agent_name (특수문자) → 즉시 throw', async () => {
    vi.resetModules();
    const m = (await import('../../src/host/invoke-agent.js')) as Mod;
    await expect(m.invokeAgent({ agentName: '../etc/passwd', task: 'do' })).rejects.toThrow(/invalid agent_name/);
  });

  it('미존재 agent → throw with available list', async () => {
    vi.resetModules();
    const m = (await import('../../src/host/invoke-agent.js')) as Mod;
    await expect(m.invokeAgent({ agentName: 'no-such-agent-xyz', task: 'do' })).rejects.toThrow(/not found.*Available/);
  });

  it('recursion guard: FORGEN_INVOKE_DEPTH >= 2 → throw', async () => {
    process.env.FORGEN_INVOKE_DEPTH = '2';
    vi.resetModules();
    const m = (await import('../../src/host/invoke-agent.js')) as Mod;
    await expect(m.invokeAgent({ agentName: 'ch-explore', task: 'do' })).rejects.toThrow(/max recursion depth/);
  });
});
