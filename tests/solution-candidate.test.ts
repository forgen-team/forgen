import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-candidate-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { promoteCandidate, rollbackSince, listCandidates } = await import('../src/engine/solution-candidate.js');
const { ME_SOLUTIONS, CANDIDATES_DIR, ARCHIVED_DIR } = await import('../src/core/paths.js');

function writeCandidate(
  name: string,
  overrides: { status?: string; extractedBy?: string; source?: string; created?: string } = {},
): string {
  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });
  const fm = {
    name,
    version: 1,
    status: overrides.status ?? 'candidate',
    confidence: 0.6,
    type: 'pattern',
    scope: 'me',
    tags: ['phase4'],
    identifiers: [] as string[],
    created: overrides.created ?? '2026-04-16',
    updated: '2026-04-16',
    supersedes: null,
    extractedBy: overrides.extractedBy ?? 'auto',
    source: overrides.source ?? 'evolved',
    evidence: { injected: 0, reflected: 0, negative: 0, sessions: 0, reExtracted: 0 },
  };
  const p = path.join(CANDIDATES_DIR, `${name}.md`);
  fs.writeFileSync(p, `---\n${yaml.dump(fm)}---\n\nbody\n`);
  return p;
}

function writeMeSolution(
  name: string,
  overrides: { source?: string; created?: string } = {},
): string {
  fs.mkdirSync(ME_SOLUTIONS, { recursive: true });
  const fm = {
    name,
    version: 1,
    status: 'verified',
    confidence: 0.6,
    type: 'pattern',
    scope: 'me',
    tags: ['live'],
    identifiers: [] as string[],
    created: overrides.created ?? '2026-04-16',
    updated: '2026-04-16',
    supersedes: null,
    extractedBy: 'auto',
    source: overrides.source ?? 'manual',
    evidence: { injected: 0, reflected: 0, negative: 0, sessions: 0, reExtracted: 0 },
  };
  const p = path.join(ME_SOLUTIONS, `${name}.md`);
  fs.writeFileSync(p, `---\n${yaml.dump(fm)}---\n\nbody\n`);
  return p;
}

describe('solution-candidate', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  describe('promoteCandidate', () => {
    it('moves a valid candidate from lab to me/solutions', () => {
      const src = writeCandidate('evolved-foo');
      const result = promoteCandidate('evolved-foo');
      expect(result.ok).toBe(true);
      expect(fs.existsSync(src)).toBe(false);
      expect(fs.existsSync(path.join(ME_SOLUTIONS, 'evolved-foo.md'))).toBe(true);
    });

    it('rejects when status is not candidate', () => {
      writeCandidate('evolved-bad', { status: 'verified' });
      const result = promoteCandidate('evolved-bad');
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/status/);
    });

    it('rejects when name collides with an existing live solution', () => {
      writeMeSolution('already-here');
      writeCandidate('already-here');
      const result = promoteCandidate('already-here');
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/collision/);
    });

    it('rejects when frontmatter is malformed', () => {
      fs.mkdirSync(CANDIDATES_DIR, { recursive: true });
      fs.writeFileSync(path.join(CANDIDATES_DIR, 'broken.md'), '---\nnope');
      const result = promoteCandidate('broken');
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/schema errors/);
    });

    it('returns not-found for missing candidate', () => {
      const result = promoteCandidate('ghost');
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/not found/);
    });

    it('accepts an absolute path pointing inside the candidates dir', () => {
      const src = writeCandidate('evolved-abs');
      const result = promoteCandidate(src);
      expect(result.ok).toBe(true);
    });
  });

  describe('rollbackSince', () => {
    it('archives evolved solutions newer than cutoff', () => {
      writeMeSolution('old-evolved', { source: 'evolved', created: '2026-04-10' });
      writeMeSolution('new-evolved', { source: 'evolved', created: '2026-04-20' });
      writeMeSolution('manual-anchor', { source: 'manual', created: '2026-04-20' });
      const cutoff = Date.parse('2026-04-15');
      const result = rollbackSince(cutoff);
      expect(result.archived.length).toBe(1);
      expect(result.archived[0]).toMatch(/new-evolved/);
      expect(fs.existsSync(path.join(ME_SOLUTIONS, 'new-evolved.md'))).toBe(false);
      expect(fs.existsSync(path.join(ME_SOLUTIONS, 'old-evolved.md'))).toBe(true);
      expect(fs.existsSync(path.join(ME_SOLUTIONS, 'manual-anchor.md'))).toBe(true);
      expect(result.archive_dir.startsWith(ARCHIVED_DIR)).toBe(true);
    });

    it('archives unpromoted candidates from lab too', () => {
      writeCandidate('evolved-pending', { created: '2026-04-20' });
      const result = rollbackSince(Date.parse('2026-04-15'));
      expect(result.archived.length).toBe(1);
    });

    it('returns empty archived list when nothing matches', () => {
      writeMeSolution('manual', { source: 'manual', created: '2026-04-20' });
      const result = rollbackSince(Date.parse('2026-04-15'));
      expect(result.archived).toEqual([]);
    });
  });

  describe('listCandidates', () => {
    it('returns paths to all .md in CANDIDATES_DIR', () => {
      writeCandidate('a');
      writeCandidate('b');
      const found = listCandidates().map((p) => path.basename(p)).sort();
      expect(found).toEqual(['a.md', 'b.md']);
    });

    it('returns [] when directory does not exist', () => {
      expect(listCandidates()).toEqual([]);
    });
  });
});
