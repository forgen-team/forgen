import { describe, it, expect } from 'vitest';
import { computeFitness } from '../src/engine/solution-fitness.js';
import type { OutcomeEvent } from '../src/engine/solution-outcomes.js';

function ev(solution: string, outcome: OutcomeEvent['outcome'], tsOffset = 0): OutcomeEvent {
  return {
    ts: Date.now() + tsOffset,
    session_id: 'sess',
    solution,
    match_score: 0.5,
    injected_chars: 100,
    outcome,
    outcome_lag_ms: 1000,
    attribution: outcome === 'correct' ? 'explicit' : outcome === 'error' ? 'window' : 'default',
  };
}

describe('computeFitness', () => {
  it('returns [] when no events', () => {
    expect(computeFitness({ events: [] })).toEqual([]);
  });

  it('pure accept yields high fitness and champion state when injected crosses threshold', () => {
    const events: OutcomeEvent[] = [];
    for (let i = 0; i < 12; i++) events.push(ev('sol', 'accept'));
    const result = computeFitness({ events });
    expect(result.length).toBe(1);
    expect(result[0].accepted).toBe(12);
    expect(result[0].fitness).toBeGreaterThan(2);
    expect(result[0].state).toBe('champion');
  });

  it('pure correct drops fitness', () => {
    const events: OutcomeEvent[] = [];
    for (let i = 0; i < 5; i++) events.push(ev('bad', 'accept'));
    for (let i = 0; i < 10; i++) events.push(ev('bad', 'correct'));
    const result = computeFitness({ events });
    // ratio = (5+1)/(15+1) = 0.375, conf = log(16) ≈ 2.77 → ≈ 1.04
    expect(result[0].fitness).toBeLessThan(1.2);
    expect(result[0].fitness).toBeGreaterThan(0.9);
  });

  it('underperform requires evalFraction below median', () => {
    const events: OutcomeEvent[] = [];
    for (let i = 0; i < 20; i++) events.push(ev('good', 'accept'));
    for (let i = 0; i < 20; i++) events.push(ev('ok', 'accept'));
    for (let i = 0; i < 3; i++) events.push(ev('bad', 'accept'));
    for (let i = 0; i < 10; i++) events.push(ev('bad', 'correct'));
    const result = computeFitness({ events });
    const bad = result.find((r) => r.solution === 'bad');
    expect(bad?.state).toBe('underperform');
    const good = result.find((r) => r.solution === 'good');
    expect(good?.state).toBe('champion');
  });

  it('draft state for solutions under minEvalInjections', () => {
    const events: OutcomeEvent[] = [ev('new', 'accept'), ev('new', 'accept')];
    const result = computeFitness({ events });
    expect(result[0].state).toBe('draft');
  });

  it('unknown outcomes count as injected but not in decided ratio', () => {
    const events: OutcomeEvent[] = [];
    for (let i = 0; i < 5; i++) events.push(ev('sess-cut', 'unknown'));
    const result = computeFitness({ events });
    // ratio = 1/1 = 1.0, conf = log(6) ≈ 1.79, so fitness ≈ 1.79
    expect(result[0].injected).toBe(5);
    expect(result[0].accepted).toBe(0);
    expect(result[0].unknown).toBe(5);
    expect(result[0].fitness).toBeCloseTo(Math.log(6), 2);
  });

  it('error outcome acts like correct but weaker (same formula, different signal)', () => {
    const eventsA: OutcomeEvent[] = [];
    const eventsB: OutcomeEvent[] = [];
    for (let i = 0; i < 5; i++) eventsA.push(ev('a', 'accept'));
    for (let i = 0; i < 3; i++) eventsA.push(ev('a', 'error'));
    for (let i = 0; i < 5; i++) eventsB.push(ev('b', 'accept'));
    for (let i = 0; i < 3; i++) eventsB.push(ev('b', 'correct'));
    const fitA = computeFitness({ events: eventsA })[0].fitness;
    const fitB = computeFitness({ events: eventsB })[0].fitness;
    // Formula is symmetric: error and correct penalize equally.
    expect(fitA).toBeCloseTo(fitB, 5);
  });

  it('sorts result: champion > active > underperform > draft', () => {
    const events: OutcomeEvent[] = [];
    for (let i = 0; i < 15; i++) events.push(ev('ch', 'accept'));
    for (let i = 0; i < 15; i++) events.push(ev('act', 'accept'));
    for (let i = 0; i < 2; i++) events.push(ev('act', 'correct'));
    for (let i = 0; i < 1; i++) events.push(ev('new', 'accept'));
    const result = computeFitness({ events });
    const states = result.map((r) => r.state);
    expect(states[0]).toBe('champion');
    expect(states[states.length - 1]).toBe('draft');
  });

  it('tracks last_injected_ago_ms from the latest event', () => {
    const events: OutcomeEvent[] = [
      { ...ev('s', 'accept', -100000), ts: Date.now() - 100000 },
      { ...ev('s', 'accept', -1000), ts: Date.now() - 1000 },
    ];
    const result = computeFitness({ events });
    expect(result[0].last_injected_ago_ms).toBeGreaterThan(500);
    expect(result[0].last_injected_ago_ms).toBeLessThan(5000);
  });
});
