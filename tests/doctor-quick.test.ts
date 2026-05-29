import { describe, it, expect } from 'vitest';
import { runDoctor } from '../src/core/doctor.js';

describe('doctor --quick (v0.5.0)', () => {
  it('runDoctor with quick=true completes without error', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      await runDoctor({ quick: true });
    } finally {
      console.log = origLog;
    }
    const output = logs.join('\n');
    expect(output).toContain('Tools');
    expect(output).toContain('Plugins');
    expect(output).toContain('Directories');
    expect(output).toContain('Initialization Status');
    // quick mode should NOT include Environment or Hook Health
    expect(output).not.toContain('Inside tmux session');
    expect(output).not.toContain('Hook Health');
  });

  it('runDoctor without quick=true includes Environment section', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      await runDoctor({});
    } finally {
      console.log = origLog;
    }
    const output = logs.join('\n');
    expect(output).toContain('Environment');
  });
});
