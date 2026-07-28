import { describe, it, expect } from 'vitest';
import { selectSweepCandidates, DEFAULT_SWEEP_OPTS, type TranscriptMeta } from '../src/core/compound-sweep-cli.js';

const NOW = 1_700_000_000_000;
const H = 3600_000;
function meta(id: string, ageH: number, prompts: number): TranscriptMeta {
  return { sessionId: id, transcriptPath: `/t/${id}.jsonl`, cwd: '/w', mtimeMs: NOW - ageH * H, promptCount: prompts };
}
const opts = { nowMs: NOW, ...DEFAULT_SWEEP_OPTS };

describe('selectSweepCandidates (ADR-011 compound backstop)', () => {
  it('창(24h) 밖 transcript 제외', () => {
    const r = selectSweepCandidates([meta('old', 30, 50)], {}, opts);
    expect(r).toHaveLength(0);
  });

  it('promptCount < 최소(10) 제외', () => {
    const r = selectSweepCandidates([meta('thin', 1, 5)], {}, opts);
    expect(r).toHaveLength(0);
  });

  it('최근(2h 내) sweep 된 세션 제외, stale 은 포함', () => {
    const items = [meta('fresh', 1, 20), meta('stale', 1, 20)];
    const state = { fresh: { sweptAt: NOW - 1 * H }, stale: { sweptAt: NOW - 5 * H } };
    const r = selectSweepCandidates(items, state, opts);
    expect(r.map((c) => c.sessionId)).toEqual(['stale']);
  });

  it('한 번도 안 쓸린 세션 포함', () => {
    const r = selectSweepCandidates([meta('new', 1, 20)], {}, opts);
    expect(r.map((c) => c.sessionId)).toEqual(['new']);
  });

  it('oldest-swept 우선 정렬', () => {
    const items = [meta('a', 1, 20), meta('b', 1, 20), meta('c', 1, 20)];
    const state = { a: { sweptAt: NOW - 3 * H }, b: { sweptAt: NOW - 10 * H } }; // c: 미swept(=0, 최우선)
    const r = selectSweepCandidates(items, state, opts);
    expect(r.map((c) => c.sessionId)).toEqual(['c', 'b', 'a']);
  });

  it('maxPerRun 상한', () => {
    const items = Array.from({ length: 12 }, (_, i) => meta(`s${i}`, 1, 20));
    const r = selectSweepCandidates(items, {}, { ...opts, maxPerRun: 5 });
    expect(r).toHaveLength(5);
  });

  it('maxPerRun 0 이면 빈 결과', () => {
    expect(selectSweepCandidates([meta('x', 1, 20)], {}, { ...opts, maxPerRun: 0 })).toHaveLength(0);
  });
});
