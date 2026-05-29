import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  maxConcurrentAgents,
  shouldWarnConcurrency,
  recordAgentEvent,
} from '../src/hooks/subagent-tracker.js';

const tmpFiles: string[] = [];
function tmpStatePath(): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-tracker-')), 'active-agents.json');
  tmpFiles.push(path.dirname(p));
  return p;
}

afterEach(() => {
  delete process.env.FORGEN_MAX_CONCURRENT_AGENTS;
});

describe('subagent-tracker: maxConcurrentAgents (ADR-009 §4)', () => {
  it('defaults to 16', () => {
    expect(maxConcurrentAgents()).toBe(16);
  });
  it('honors FORGEN_MAX_CONCURRENT_AGENTS', () => {
    process.env.FORGEN_MAX_CONCURRENT_AGENTS = '32';
    expect(maxConcurrentAgents()).toBe(32);
  });
  it('ignores non-positive / NaN env', () => {
    process.env.FORGEN_MAX_CONCURRENT_AGENTS = '0';
    expect(maxConcurrentAgents()).toBe(16);
    process.env.FORGEN_MAX_CONCURRENT_AGENTS = 'abc';
    expect(maxConcurrentAgents()).toBe(16);
  });
});

describe('subagent-tracker: shouldWarnConcurrency (ADR-009 §B)', () => {
  it('workflow-subagent is exempt regardless of count', () => {
    expect(shouldWarnConcurrency('workflow-subagent', 999, 16)).toBe(false);
  });
  it('non-workflow agent warns only above threshold', () => {
    expect(shouldWarnConcurrency('Explore', 16, 16)).toBe(false); // boundary: not above
    expect(shouldWarnConcurrency('Explore', 17, 16)).toBe(true);
  });
  it('empty agentType warns above threshold', () => {
    expect(shouldWarnConcurrency('', 20, 16)).toBe(true);
  });
});

describe('subagent-tracker: recordAgentEvent file-lock race fix (ADR-009 §A)', () => {
  it('preserves ALL entries under concurrent starts (no lost-update)', async () => {
    const statePath = tmpStatePath();
    const N = 12;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        recordAgentEvent({ sessionId: 'wf', action: 'start', agentId: `a${i}`, agentType: 'workflow-subagent' }, statePath),
      ),
    );
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const ids = state.agents.map((a: { agentId: string }) => a.agentId).sort();
    expect(state.agents.length).toBe(N);
    expect(ids).toEqual(Array.from({ length: N }, (_, i) => `a${i}`).sort());
  });

  it('start records an agent and reports activeCount', async () => {
    const statePath = tmpStatePath();
    const r1 = await recordAgentEvent({ sessionId: 's', action: 'start', agentId: 'x1' }, statePath);
    expect(r1.activeCount).toBe(1);
    const r2 = await recordAgentEvent({ sessionId: 's', action: 'start', agentId: 'x2' }, statePath);
    expect(r2.activeCount).toBe(2);
  });

  it('stop marks the matching agent stopped', async () => {
    const statePath = tmpStatePath();
    await recordAgentEvent({ sessionId: 's', action: 'start', agentId: 'x1' }, statePath);
    await recordAgentEvent({ sessionId: 's', action: 'stop', agentId: 'x1' }, statePath);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(state.agents[0].stoppedAt).toBeTruthy();
  });
});
