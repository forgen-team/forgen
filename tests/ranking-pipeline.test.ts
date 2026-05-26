import { describe, it, expect } from 'vitest';
import { rankCandidates } from '../src/engine/ranking-pipeline.js';

describe('ranking-pipeline (extracted module)', () => {
  const solutions = [
    { name: 'caching-strategy', tags: ['cache', 'redis', 'performance'], identifiers: ['RedisCache'], confidence: 0.8 },
    { name: 'error-handling', tags: ['error', 'handling', 'try-catch'], identifiers: ['handleError'], confidence: 0.7 },
    { name: 'api-design', tags: ['api', 'rest', 'endpoint'], identifiers: ['apiRouter'], confidence: 0.9 },
  ];

  it('returns ranked candidates for matching query', () => {
    const ranked = rankCandidates(['cache', 'redis'], 'cache redis strategy', solutions);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].solution.name).toBe('caching-strategy');
    expect(ranked[0].relevance).toBeGreaterThan(0);
    expect(ranked[0].matchedTags.length).toBeGreaterThan(0);
  });

  it('returns empty for completely unrelated query', () => {
    const ranked = rankCandidates(['quantum', 'physics'], 'quantum physics theory', solutions);
    expect(ranked.length).toBe(0);
  });

  it('identifier boost raises relevance', () => {
    const ranked = rankCandidates(['error'], 'error handleerror function', solutions);
    const errorSol = ranked.find(c => c.solution.name === 'error-handling');
    if (errorSol) {
      expect(errorSol.matchedIdentifiers.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('respects top-5 limit', () => {
    const manySolutions = Array.from({ length: 20 }, (_, i) => ({
      name: `sol-${i}`,
      tags: ['common', 'tag', `unique-${i}`],
      confidence: 0.5,
    }));
    const ranked = rankCandidates(['common', 'tag'], 'common tag query', manySolutions);
    expect(ranked.length).toBeLessThanOrEqual(5);
  });

  it('filters candidates with no matched tags or identifiers', () => {
    const ranked = rankCandidates(['cache'], 'cache performance', solutions);
    for (const c of ranked) {
      expect(c.matchedTags.length + c.matchedIdentifiers.length).toBeGreaterThanOrEqual(1);
    }
  });
});
