import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('watch-cli (extracted module)', () => {
  it('module exports handleWatch function', async () => {
    const mod = await import('../src/core/watch-cli.js');
    expect(typeof mod.handleWatch).toBe('function');
  });

  it('compiled output exists in dist', () => {
    const distPath = path.join(__dirname, '..', 'dist', 'core', 'watch-cli.js');
    expect(fs.existsSync(distPath)).toBe(true);
  });
});
