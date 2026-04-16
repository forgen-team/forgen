import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-quarantine-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

// Import AFTER the os mock is registered so paths resolve under TEST_HOME.
const {
  recordQuarantine,
  listQuarantined,
  pruneQuarantine,
  diagnoseFromRawContent,
} = await import('../src/engine/solution-quarantine.js');
const { SOLUTION_QUARANTINE_PATH, ME_SOLUTIONS } = await import('../src/core/paths.js');

describe('solution-quarantine', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(ME_SOLUTIONS, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  describe('diagnoseFromRawContent', () => {
    it('returns empty errors for valid frontmatter', () => {
      const valid = `---
name: ok
version: 1
status: experiment
confidence: 0.5
type: pattern
scope: me
tags: []
identifiers: []
created: "2026-04-16"
updated: "2026-04-16"
supersedes: null
extractedBy: manual
evidence:
  injected: 0
  reflected: 0
  negative: 0
  sessions: 0
  reExtracted: 0
---

body`;
      expect(diagnoseFromRawContent(valid)).toEqual([]);
    });

    it('reports missing extractedBy and evidence for the 2026-04-10 shape', () => {
      const buggy = `---
name: bad
version: 1
status: verified
confidence: 0.8
type: pattern
scope: me
tags: []
identifiers: []
created: "2026-04-10"
updated: "2026-04-10"
supersedes: null
source: compound-manual
---

body`;
      const errors = diagnoseFromRawContent(buggy);
      expect(errors.some((e) => e.startsWith('extractedBy'))).toBe(true);
      expect(errors.some((e) => e.startsWith('evidence'))).toBe(true);
    });

    it('rejects content without frontmatter', () => {
      expect(diagnoseFromRawContent('no yaml here')).toEqual([
        'no YAML frontmatter (missing leading ---)',
      ]);
    });

    it('rejects frontmatter that is not closed', () => {
      expect(diagnoseFromRawContent('---\nname: x\n'))
        .toEqual(['frontmatter not closed (missing trailing ---)']);
    });
  });

  describe('recordQuarantine', () => {
    it('writes one JSONL entry per call to SOLUTION_QUARANTINE_PATH', () => {
      recordQuarantine('/fake/a.md', ['err1']);
      const lines = fs.readFileSync(SOLUTION_QUARANTINE_PATH, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(1);
      const entry = JSON.parse(lines[0]);
      expect(entry.path).toBe('/fake/a.md');
      expect(entry.errors).toEqual(['err1']);
      expect(typeof entry.at).toBe('string');
    });

    it('dedupes consecutive identical entries for the same path', () => {
      recordQuarantine('/fake/a.md', ['err1']);
      recordQuarantine('/fake/a.md', ['err1']);
      const lines = fs.readFileSync(SOLUTION_QUARANTINE_PATH, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(1);
    });

    it('appends a new entry when errors change for the same path', () => {
      recordQuarantine('/fake/a.md', ['err1']);
      recordQuarantine('/fake/a.md', ['err1', 'err2']);
      const lines = fs.readFileSync(SOLUTION_QUARANTINE_PATH, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(2);
    });

    it('appends a new entry when path differs from the latest', () => {
      recordQuarantine('/fake/a.md', ['err1']);
      recordQuarantine('/fake/b.md', ['err1']);
      const lines = fs.readFileSync(SOLUTION_QUARANTINE_PATH, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(2);
    });
  });

  describe('listQuarantined', () => {
    it('returns the latest entry per path and drops missing files', () => {
      const real = path.join(ME_SOLUTIONS, 'real.md');
      fs.writeFileSync(real, '---\nbroken');
      recordQuarantine(real, ['err1']);
      recordQuarantine(real, ['err1', 'err2']);
      recordQuarantine('/nonexistent.md', ['err']);
      const entries = listQuarantined();
      expect(entries.length).toBe(1);
      expect(entries[0].path).toBe(real);
      expect(entries[0].errors).toEqual(['err1', 'err2']);
    });

    it('returns [] when the quarantine file does not exist', () => {
      expect(listQuarantined()).toEqual([]);
    });
  });

  describe('pruneQuarantine', () => {
    it('removes entries whose files now pass validation', () => {
      const good = path.join(ME_SOLUTIONS, 'good.md');
      const bad = path.join(ME_SOLUTIONS, 'bad.md');
      fs.writeFileSync(good, `---
name: good
version: 1
status: experiment
confidence: 0.5
type: pattern
scope: me
tags: []
identifiers: []
created: "2026-04-16"
updated: "2026-04-16"
supersedes: null
extractedBy: manual
evidence:
  injected: 0
  reflected: 0
  negative: 0
  sessions: 0
  reExtracted: 0
---
body`);
      fs.writeFileSync(bad, '---\nname: bad\n');
      recordQuarantine(good, ['extractedBy: missing or not auto|manual']);
      recordQuarantine(bad, ['frontmatter not closed (missing trailing ---)']);
      const result = pruneQuarantine();
      expect(result.removed).toBe(1);
      expect(result.kept).toBe(1);
      const remaining = listQuarantined();
      expect(remaining.length).toBe(1);
      expect(remaining[0].path).toBe(bad);
    });

    it('removes entries whose files were deleted', () => {
      const p = path.join(ME_SOLUTIONS, 'deleted.md');
      fs.writeFileSync(p, '---\nbroken');
      recordQuarantine(p, ['err']);
      fs.unlinkSync(p);
      const result = pruneQuarantine();
      expect(result.removed).toBe(1);
      expect(result.kept).toBe(0);
    });
  });
});
