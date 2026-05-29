import { describe, it, expect } from 'vitest';
import { loadTunedMatcherWeights } from '../src/engine/meta-learning/matcher-weight-loader.js';

describe('matcher-weight-loader (extracted module)', () => {
  it('returns undefined when no weights file exists', () => {
    const result = loadTunedMatcherWeights();
    expect(result).toBeUndefined();
  });

  it('returns the same result on repeated calls (cache)', () => {
    const r1 = loadTunedMatcherWeights();
    const r2 = loadTunedMatcherWeights();
    expect(r1).toEqual(r2);
  });

  it('does not throw on any call', () => {
    expect(() => loadTunedMatcherWeights()).not.toThrow();
  });
});
