import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({ TEST_HOME: `${process.env.TMPDIR ?? '/tmp'}/forgen-export-home-${process.pid}` }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import { exportKnowledgeSelective, importKnowledgeMerge } from '../src/engine/compound-export.js';

describe('compound-export enhanced (v0.5.0)', () => {
  // 실제 홈에 지식 폴더가 있어야 통과하던 의존을 픽스처로 고정한다.
  beforeAll(() => {
    for (const d of ['solutions', 'rules', 'behavior']) {
      const dir = path.join(TEST_HOME, '.forgen', 'me', d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `fixture-${d}.md`), `# ${d} fixture\n`);
    }
  });
  afterAll(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  describe('exportKnowledgeSelective', () => {
    it('exports only specified categories', () => {
      const outPath = path.join(os.tmpdir(), `forgen-test-selective-${Date.now()}.tar.gz`);
      try {
        const result = exportKnowledgeSelective(['solutions'], outPath);
        expect(result.outputPath).toBe(outPath);
        expect(result.counts).toHaveProperty('solutions');
        expect(result.counts).not.toHaveProperty('rules');
        expect(result.counts).not.toHaveProperty('behavior');
        expect(fs.existsSync(outPath)).toBe(true);
      } finally {
        try { fs.unlinkSync(outPath); } catch { /* ok */ }
      }
    });

    it('throws on invalid categories', () => {
      expect(() => exportKnowledgeSelective(['nonexistent'])).toThrow('No valid categories');
    });

    it('supports multiple categories', () => {
      const outPath = path.join(os.tmpdir(), `forgen-test-multi-${Date.now()}.tar.gz`);
      try {
        const result = exportKnowledgeSelective(['solutions', 'rules'], outPath);
        expect(Object.keys(result.counts)).toEqual(expect.arrayContaining(['solutions', 'rules']));
      } finally {
        try { fs.unlinkSync(outPath); } catch { /* ok */ }
      }
    });
  });

  describe('importKnowledgeMerge', () => {
    it('imports from a valid archive in merge mode', () => {
      const outPath = path.join(os.tmpdir(), `forgen-test-merge-${Date.now()}.tar.gz`);
      try {
        exportKnowledgeSelective(['solutions'], outPath);
        const result = importKnowledgeMerge(outPath);
        expect(typeof result.imported).toBe('number');
        expect(typeof result.merged).toBe('number');
        expect(typeof result.skipped).toBe('number');
        expect(result.imported + result.merged + result.skipped).toBeGreaterThan(0);
      } finally {
        try { fs.unlinkSync(outPath); } catch { /* ok */ }
      }
    });

    it('throws on nonexistent archive', () => {
      expect(() => importKnowledgeMerge('/tmp/nonexistent-archive.tar.gz')).toThrow('Archive not found');
    });

    it('skips files when local is same or newer', () => {
      const outPath = path.join(os.tmpdir(), `forgen-test-skip-${Date.now()}.tar.gz`);
      try {
        exportKnowledgeSelective(['solutions'], outPath);
        const result = importKnowledgeMerge(outPath);
        // All should be skipped since we just exported from the same source
        expect(result.imported).toBe(0);
        expect(result.merged).toBe(0);
      } finally {
        try { fs.unlinkSync(outPath); } catch { /* ok */ }
      }
    });
  });
});
