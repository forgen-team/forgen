import { describe, it, expect } from 'vitest';
import { handleChangelog } from '../src/core/changelog-cli.js';

describe('changelog-cli (v0.5.0)', () => {
  it('runs without error in a git repo', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      await handleChangelog();
    } finally {
      console.log = orig;
    }
    const output = logs.join('\n');
    expect(output).toContain('Changelog');
  });

  it('groups commits by conventional type', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      await handleChangelog();
    } finally {
      console.log = orig;
    }
    const output = logs.join('\n');
    // Should have at least one section header
    expect(output).toMatch(/###\s+(Features|Bug Fixes|Refactoring|Tests|CI\/CD|Documentation|Maintenance|Other)/);
  });

  it('includes markdown copy-paste section', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      await handleChangelog();
    } finally {
      console.log = orig;
    }
    const output = logs.join('\n');
    expect(output).toContain('Markdown');
  });
});
