/**
 * Doctor — [Harness Maturity] section (Feature 1-D)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: '/tmp/forgen-test-doctor',
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

// Mock execFileSync to avoid external tool calls
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (cmd: string, _args?: string[], _opts?: object) => {
      // Simulate 'which' always finding tools
      if (cmd === 'which' || cmd === 'where') return '';
      // For git remote, simulate no remote
      throw new Error('git remote not found');
    },
  };
});

import { runDoctor } from '../../src/core/doctor.js';

const ME_DIR = path.join(TEST_HOME, '.forgen', 'me');
const STATE_DIR = path.join(TEST_HOME, '.forgen', 'state');

describe('doctor [Harness Maturity]', () => {
  let output: string;
  const originalLog = console.log;

  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(ME_DIR, { recursive: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // Capture console.log output
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });
    output = '';
    // We set output after runDoctor
    (console as unknown as { _lines: string[] })._lines = lines;
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    vi.restoreAllMocks();
    console.log = originalLog;
  });

  it('doctor runs without error and includes [Harness Maturity] section', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));
    await runDoctor();
    output = lines.join('\n');
    expect(output).toContain('[Harness Maturity]');
    expect(output).toContain('Preparation');
    expect(output).toContain('Context');
    expect(output).toContain('Execution');
    expect(output).toContain('Validation');
    expect(output).toContain('Improvement');
  });

  it('missing directories → L0/L1 levels (graceful, no crash)', async () => {
    // Remove all forgen dirs so everything is missing
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));
    await expect(runDoctor()).resolves.not.toThrow();
    output = lines.join('\n');
    expect(output).toContain('[Harness Maturity]');
    // Should show L1 for all axes (no L3 when nothing exists)
    expect(output).not.toContain('L3     solutions:0, behavior:0');
  });

  it('full setup → L2/L3 level detection', async () => {
    // Create solutions
    const solDir = path.join(ME_DIR, 'solutions');
    fs.mkdirSync(solDir, { recursive: true });
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(solDir, `sol-${i}.md`), `---\nname: "sol-${i}"\nstatus: "verified"\nconfidence: 0.9\n---\n\n## Content\ntest\nevidence:\n  reflected: ${i > 2 ? 1 : 0}\n`);
    }
    // Create behavior
    const behDir = path.join(ME_DIR, 'behavior');
    fs.mkdirSync(behDir, { recursive: true });
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(behDir, `beh-${i}.md`), `---\nname: "beh-${i}"\n---\n`);
    }
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));
    await runDoctor();
    output = lines.join('\n');
    expect(output).toContain('[Harness Maturity]');
    // Context should be L3 (6 solutions >= 5, 4 behavior >= 3)
    expect(output).toContain('Context');
    // Output should contain L2 or L3 for context axis
    const ctxLine = lines.find(l => l.includes('Context'));
    expect(ctxLine).toBeDefined();
    expect(ctxLine).toMatch(/L[23]/);
  });
});
