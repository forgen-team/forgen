import { describe, it, expect } from 'vitest';
import { handleExplain } from '../src/core/explain-cli.js';

describe('explain-cli (v0.5.0)', () => {
  it('runs without error when no violations exist', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      await handleExplain([]);
    } finally {
      console.log = orig;
    }
    const output = logs.join('\n');
    expect(output).toMatch(/No blocks|BLOCK/);
  });

  it('accepts a count argument', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      await handleExplain(['3']);
    } finally {
      console.log = orig;
    }
    expect(logs.length).toBeGreaterThan(0);
  });
});
