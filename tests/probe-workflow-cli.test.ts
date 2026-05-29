import { describe, it, expect } from 'vitest';
import {
  maxConcurrency,
  analyzeProbe,
  type AgentObservation,
  type ProbeObservations,
} from '../src/core/probe-workflow-cli.js';

function agent(startedAtMs: number, stoppedAtMs?: number, agentType?: string): AgentObservation {
  return { agentId: `a-${startedAtMs}-${stoppedAtMs ?? 'on'}`, agentType, startedAtMs, stoppedAtMs };
}

function obs(agents: AgentObservation[], postToolUseFired = false): ProbeObservations {
  return { agents, postToolUseFired, hookEvents: [] };
}

describe('probe-workflow: maxConcurrency (ADR-009 §1)', () => {
  it('empty → 0', () => {
    expect(maxConcurrency([])).toBe(0);
  });

  it('non-overlapping intervals → 1', () => {
    expect(maxConcurrency([agent(0, 10), agent(20, 30), agent(40, 50)])).toBe(1);
  });

  it('fully overlapping closed intervals → n', () => {
    expect(maxConcurrency([agent(0, 100), agent(10, 90), agent(20, 80)])).toBe(3);
  });

  it('ongoing agents (no stoppedAt) count as concurrent', () => {
    expect(maxConcurrency([agent(0), agent(5), agent(10)])).toBe(3);
  });

  it('boundary: start at same instant a prior stops still overlaps (start before stop)', () => {
    // a1 [0,10), a2 [10,20): at t=10 start(+1) processed before stop(-1) → peak 2
    expect(maxConcurrency([agent(0, 10), agent(10, 20)])).toBe(2);
  });

  it('partial overlap → 2', () => {
    expect(maxConcurrency([agent(0, 15), agent(10, 25), agent(30, 40)])).toBe(2);
  });
});

describe('probe-workflow: analyzeProbe (ADR-009 §1)', () => {
  it('zero agents → workflow-hooks-absent, no subagent firing', () => {
    const v = analyzeProbe(obs([]));
    expect(v.outcome).toBe('workflow-hooks-absent');
    expect(v.subagentStartStopFired).toBe(false);
    expect(v.agentCount).toBe(0);
    expect(v.maxConcurrency).toBe(0);
    expect(v.recommendation).toMatch(/§3|템플릿/);
  });

  it('agents with high concurrency → workflow-hooks-fire, strong signal', () => {
    const agents = Array.from({ length: 16 }, (_, i) => agent(0, 100, 'workflow-agent'));
    const v = analyzeProbe(obs(agents, true));
    expect(v.outcome).toBe('workflow-hooks-fire');
    expect(v.subagentStartStopFired).toBe(true);
    expect(v.agentCount).toBe(16);
    expect(v.maxConcurrency).toBe(16);
    expect(v.recommendation).toMatch(/동시성 신호 강함/);
    expect(v.recommendation).toMatch(/§2/);
  });

  it('few agents, low concurrency → workflow-hooks-fire but flags ambiguity', () => {
    const v = analyzeProbe(obs([agent(0, 10), agent(20, 30)]));
    expect(v.outcome).toBe('workflow-hooks-fire');
    expect(v.maxConcurrency).toBe(1);
    expect(v.recommendation).toMatch(/동시성 낮음/);
  });

  it('postToolUse reflected in verdict and recommendation', () => {
    const fired = analyzeProbe(obs([agent(0, 10)], true));
    expect(fired.postToolUseFired).toBe(true);
    expect(fired.recommendation).toMatch(/per-agent tool 추적 가능/);

    const notFired = analyzeProbe(obs([agent(0, 10)], false));
    expect(notFired.postToolUseFired).toBe(false);
    expect(notFired.recommendation).toMatch(/거짓양성 리스크/);
  });

  it('agentTypes are deduped and undefined filtered out', () => {
    const v = analyzeProbe(
      obs([agent(0, 10, 'explore'), agent(1, 11, 'explore'), agent(2, 12, undefined), agent(3, 13, 'verify')]),
    );
    expect(v.agentTypes.sort()).toEqual(['explore', 'verify']);
  });

  it('concurrency boundary 11 is the workflow hint threshold', () => {
    const ten = Array.from({ length: 10 }, () => agent(0, 100));
    expect(analyzeProbe(obs(ten)).recommendation).toMatch(/동시성 낮음/);

    const eleven = Array.from({ length: 11 }, () => agent(0, 100));
    expect(analyzeProbe(obs(eleven)).recommendation).toMatch(/동시성 신호 강함/);
  });
});
