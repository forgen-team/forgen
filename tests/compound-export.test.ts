import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: '/tmp/forgen-test-export-import',
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import { exportKnowledge, importKnowledge } from '../src/engine/compound-export.js';

const ME_DIR = path.join(TEST_HOME, '.forgen', 'me');
const SOLUTIONS_DIR = path.join(ME_DIR, 'solutions');
const RULES_DIR = path.join(ME_DIR, 'rules');
const BEHAVIOR_DIR = path.join(ME_DIR, 'behavior');

function writeSolutionFile(dir: string, name: string, content?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const body = content ?? `---
name: "${name}"
version: 1
status: "candidate"
confidence: 0.5
type: "pattern"
scope: "me"
tags: ["test"]
identifiers: []
evidence:
  injected: 0
  reflected: 0
  negative: 0
  sessions: 0
  reExtracted: 0
created: "2026-01-01"
updated: "2026-01-01"
supersedes: null
extractedBy: "manual"
---

## Content
Test content for ${name}
`;
  fs.writeFileSync(path.join(dir, `${name}.md`), body);
}

describe('compound-export', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(ME_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  describe('exportKnowledge', () => {
    it('creates a tar.gz archive with knowledge files', () => {
      writeSolutionFile(SOLUTIONS_DIR, 'sol-a');
      writeSolutionFile(SOLUTIONS_DIR, 'sol-b');
      writeSolutionFile(RULES_DIR, 'rule-a');

      const outputPath = path.join(TEST_HOME, 'export.tar.gz');
      const result = exportKnowledge(outputPath);

      expect(result.outputPath).toBe(outputPath);
      expect(result.counts.solutions).toBe(2);
      expect(result.counts.rules).toBe(1);
      expect(result.totalFiles).toBe(3);
      expect(fs.existsSync(outputPath)).toBe(true);
    });

    it('uses default output path when none provided', () => {
      writeSolutionFile(SOLUTIONS_DIR, 'sol-a');

      const origCwd = process.cwd();
      process.chdir(TEST_HOME);
      try {
        const result = exportKnowledge();
        expect(result.outputPath).toContain('forgen-knowledge-');
        expect(result.outputPath).toContain('.tar.gz');
        expect(fs.existsSync(result.outputPath)).toBe(true);
      } finally {
        process.chdir(origCwd);
      }
    });

    it('throws when no knowledge directories exist', () => {
      // ME_DIR exists but no subdirectories
      expect(() => exportKnowledge(path.join(TEST_HOME, 'out.tar.gz'))).toThrow(
        'No knowledge directories found',
      );
    });
  });

  describe('importKnowledge', () => {
    it('imports new files from archive', () => {
      // Create some files and export
      writeSolutionFile(SOLUTIONS_DIR, 'sol-a');
      writeSolutionFile(RULES_DIR, 'rule-a');
      const archivePath = path.join(TEST_HOME, 'export.tar.gz');
      exportKnowledge(archivePath);

      // Remove original files
      fs.rmSync(SOLUTIONS_DIR, { recursive: true, force: true });
      fs.rmSync(RULES_DIR, { recursive: true, force: true });

      // Import
      const result = importKnowledge(archivePath);
      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(0);
      expect(fs.existsSync(path.join(SOLUTIONS_DIR, 'sol-a.md'))).toBe(true);
      expect(fs.existsSync(path.join(RULES_DIR, 'rule-a.md'))).toBe(true);
    });

    it('skips existing files without overwriting', () => {
      writeSolutionFile(SOLUTIONS_DIR, 'sol-a');
      writeSolutionFile(SOLUTIONS_DIR, 'sol-b');
      const archivePath = path.join(TEST_HOME, 'export.tar.gz');
      exportKnowledge(archivePath);

      // Modify sol-a content to verify it is NOT overwritten
      const solAPath = path.join(SOLUTIONS_DIR, 'sol-a.md');
      fs.writeFileSync(solAPath, 'modified content');

      // Remove only sol-b
      fs.unlinkSync(path.join(SOLUTIONS_DIR, 'sol-b.md'));

      const result = importKnowledge(archivePath);
      expect(result.imported).toBe(1); // sol-b
      expect(result.skipped).toBe(1); // sol-a (exists)

      // Verify sol-a was NOT overwritten
      expect(fs.readFileSync(solAPath, 'utf-8')).toBe('modified content');
    });

    it('throws when archive does not exist', () => {
      expect(() => importKnowledge('/nonexistent/path.tar.gz')).toThrow('Archive not found');
    });
  });

  describe('roundtrip', () => {
    it('export then import restores all files', () => {
      writeSolutionFile(SOLUTIONS_DIR, 'sol-1');
      writeSolutionFile(SOLUTIONS_DIR, 'sol-2');
      writeSolutionFile(RULES_DIR, 'rule-1');
      writeSolutionFile(BEHAVIOR_DIR, 'beh-1');

      const archivePath = path.join(TEST_HOME, 'roundtrip.tar.gz');
      const exportResult = exportKnowledge(archivePath);
      expect(exportResult.totalFiles).toBe(4);

      // Clear all
      fs.rmSync(SOLUTIONS_DIR, { recursive: true, force: true });
      fs.rmSync(RULES_DIR, { recursive: true, force: true });
      fs.rmSync(BEHAVIOR_DIR, { recursive: true, force: true });

      const importResult = importKnowledge(archivePath);
      expect(importResult.imported).toBe(4);
      expect(importResult.skipped).toBe(0);
    });
  });
});
