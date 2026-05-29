import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listTemplates, installWorkflows, findTemplatesDir } from '../src/core/workflows-cli.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('workflows-cli (ADR-009 §3)', () => {
  it('findTemplatesDir resolves the bundled assets/claude/workflows', () => {
    const dir = findTemplatesDir();
    expect(dir.endsWith(path.join('assets', 'claude', 'workflows'))).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('bundles the canonical templates', () => {
    const templates = listTemplates(findTemplatesDir());
    expect(templates).toContain('evidence-gate-audit.js');
    expect(templates).toContain('compound-extract.js');
  });

  it('listTemplates returns [] for a missing dir', () => {
    expect(listTemplates('/no/such/dir')).toEqual([]);
  });

  it('installWorkflows copies all .js templates into target/.claude/workflows', () => {
    const src = tmpDir('forgen-wf-src-');
    fs.writeFileSync(path.join(src, 'a.js'), '// a');
    fs.writeFileSync(path.join(src, 'b.js'), '// b');
    fs.writeFileSync(path.join(src, 'ignore.txt'), 'no');

    const target = path.join(tmpDir('forgen-wf-dst-'), '.claude', 'workflows');
    const r = installWorkflows(src, target);

    expect(r.installed.sort()).toEqual(['a.js', 'b.js']);
    expect(fs.existsSync(path.join(target, 'a.js'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'b.js'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'ignore.txt'))).toBe(false);
  });

  it('installWorkflows overwrites existing files (idempotent re-install)', () => {
    const src = tmpDir('forgen-wf-src2-');
    fs.writeFileSync(path.join(src, 'x.js'), '// new content');
    const target = tmpDir('forgen-wf-dst2-');
    fs.writeFileSync(path.join(target, 'x.js'), '// old content');

    installWorkflows(src, target);
    expect(fs.readFileSync(path.join(target, 'x.js'), 'utf-8')).toBe('// new content');
  });

  it('the real bundled templates install end-to-end', () => {
    const target = path.join(tmpDir('forgen-wf-e2e-'), '.claude', 'workflows');
    const r = installWorkflows(findTemplatesDir(), target);
    expect(r.installed).toContain('evidence-gate-audit.js');
    expect(fs.existsSync(path.join(target, 'evidence-gate-audit.js'))).toBe(true);
  });
});
