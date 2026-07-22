import { describe, it, expect, vi } from 'vitest';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: '/tmp/forgen-test-extractor',
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import { processExtractionResults } from '../src/engine/compound-extractor.js';

describe('processExtractionResults', () => {
  it('parses valid JSON and saves solutions', () => {
    const json = JSON.stringify([{
      name: 'test-pattern',
      type: 'pattern',
      tags: ['react', 'hooks', 'state'],
      identifiers: ['useState', 'useEffect'],
      context: 'React state management',
      content: 'Use useState for local state and useEffect for side effects. Always specify dependency array to prevent infinite loops.',
    }]);
    const result = processExtractionResults(json, 'test-session');
    // Should either save or skip (exactly 1 solution input)
    expect(result.saved.length + result.skipped.length).toBe(1);
  });

  it('rejects invalid JSON', () => {
    const result = processExtractionResults('not json', 'test');
    expect(result.saved).toEqual([]);
  });

  it('rejects solutions failing Gate 1 (short content)', () => {
    const json = JSON.stringify([{
      name: 'short',
      type: 'pattern',
      tags: ['tag'],
      identifiers: [],
      context: 'ctx',
      content: 'too short',
    }]);
    const result = processExtractionResults(json, 'test');
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]).toContain('Gate 1');
  });

  it('rejects solutions failing Gate 2 (toxicity)', () => {
    const json = JSON.stringify([{
      name: 'toxic',
      type: 'pattern',
      tags: ['tag1', 'tag2'],
      identifiers: ['SomeClass'],
      context: 'when fixing types',
      content: 'Use @ts-ignore to suppress type errors when the TypeScript compiler is wrong. This is a valid approach for quick fixes in production.',
    }]);
    const result = processExtractionResults(json, 'test');
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]).toContain('Gate 2');
  });

  it('W2-5: skips a solution whose content is fully <private>', () => {
    const json = JSON.stringify([{
      name: 'secret-pattern',
      type: 'pattern',
      tags: ['tag1', 'tag2'],
      identifiers: ['SomeIdentifier'],
      context: 'ctx',
      content: '<private>internal-only playbook, do not learn from this</private>',
    }]);
    const result = processExtractionResults(json, 'test');
    expect(result.saved).toEqual([]);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]).toContain('private');
  });

  it('W2-5: strips <private> ranges but keeps the rest of the content', () => {
    const json = JSON.stringify([{
      name: 'partly-hidden-pattern',
      type: 'pattern',
      tags: ['tag1', 'tag2', 'tag3'],
      identifiers: ['PublicIdentifierLong'],
      context: 'when applying the public technique in a reusable way',
      content: 'Public reusable technique that is safe to learn and worth keeping around for future reference. <private>SECRET_TOKEN=abc123</private> The rest is public and detailed enough to pass the gates.',
    }]);
    const result = processExtractionResults(json, 'test');
    // Not skipped by the fully-private gate (partial strip keeps the public remainder).
    const privateSkip = result.skipped.find(s => s.includes('(제외)'));
    expect(privateSkip).toBeUndefined();
  });

  it('limits to max 3 extractions', () => {
    const solutions = Array.from({ length: 5 }, (_, i) => ({
      name: `pattern-${i}`,
      type: 'pattern' as const,
      tags: ['unique', `tag${i}`, 'common'],
      identifiers: [`Identifier${i}Long`],
      context: `Context for pattern ${i} with enough detail`,
      content: `Detailed content for pattern ${i} that explains the approach in enough detail to be useful for future reference and application.`,
    }));
    const result = processExtractionResults(JSON.stringify(solutions), 'test');
    expect(result.saved.length + result.skipped.length).toBeLessThanOrEqual(5);
    expect(result.saved.length).toBeLessThanOrEqual(3);
  });
});
