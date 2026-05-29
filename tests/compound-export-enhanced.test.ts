import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exportKnowledgeSelective, importKnowledgeMerge } from '../src/engine/compound-export.js';

describe('compound-export enhanced (v0.5.0)', () => {
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
