/**
 * Forgen — Compound Knowledge Export/Import
 *
 * Provides backup, migration, and sharing of accumulated personal knowledge
 * stored under ~/.forgen/me/ (solutions/, rules/, behavior/).
 *
 * Export creates a tar.gz archive; Import extracts it while skipping existing
 * files to prevent accidental overwrites.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ME_DIR } from '../core/paths.js';

/** Directories within ME_DIR to include in the archive. */
const KNOWLEDGE_DIRS = ['solutions', 'rules', 'behavior'] as const;

export interface ExportResult {
  outputPath: string;
  counts: Record<string, number>;
  totalFiles: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  details: { file: string; action: 'imported' | 'skipped' }[];
}

/**
 * Count .md files in a directory (non-recursive).
 * Returns 0 if the directory does not exist.
 */
function countFiles(dir: string): number {
  try {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter(f => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

/**
 * Export knowledge directories to a tar.gz archive.
 *
 * Uses `tar czf` via child_process for simplicity and reliability.
 * Only archives solutions/, rules/, behavior/ under ME_DIR.
 */
export function exportKnowledge(outputPath?: string): ExportResult {
  const date = new Date().toISOString().split('T')[0];
  const resolved = outputPath ?? path.join(process.cwd(), `forgen-knowledge-${date}.tar.gz`);

  // Gather counts before archiving
  const counts: Record<string, number> = {};
  const existingDirs: string[] = [];
  for (const name of KNOWLEDGE_DIRS) {
    const dir = path.join(ME_DIR, name);
    const count = countFiles(dir);
    counts[name] = count;
    if (fs.existsSync(dir)) {
      existingDirs.push(name);
    }
  }

  const totalFiles = Object.values(counts).reduce((a, b) => a + b, 0);

  if (existingDirs.length === 0) {
    throw new Error('No knowledge directories found to export.');
  }

  // Ensure output directory exists
  const outDir = path.dirname(resolved);
  fs.mkdirSync(outDir, { recursive: true });

  // Create tar.gz relative to ME_DIR so archive paths are solutions/*, rules/*, behavior/*
  execFileSync('tar', ['czf', resolved, ...existingDirs], {
    cwd: ME_DIR,
    timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return { outputPath: resolved, counts, totalFiles };
}

/**
 * Import knowledge from a tar.gz archive.
 *
 * For each file in the archive, if a file with the same name already exists
 * in the target directory, it is SKIPPED (no overwrite). Only new files are
 * added.
 */
export function importKnowledge(archivePath: string): ImportResult {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Archive not found: ${archivePath}`);
  }

  // List files in the archive
  const listOutput = execFileSync('tar', ['tzf', archivePath], {
    timeout: 30000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const archiveFiles = listOutput
    .split('\n')
    .map(f => f.trim())
    .filter(f => f && !f.endsWith('/'));

  // Extract to a temp directory first, then selectively copy
  const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'forgen-import-'));

  try {
    execFileSync('tar', ['xzf', archivePath, '-C', tmpDir], {
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const result: ImportResult = { imported: 0, skipped: 0, details: [] };

    for (const relFile of archiveFiles) {
      const srcPath = path.join(tmpDir, relFile);
      const destPath = path.join(ME_DIR, relFile);

      // Security: ensure the dest path stays within ME_DIR
      const realDest = path.resolve(destPath);
      if (!realDest.startsWith(ME_DIR)) {
        result.skipped++;
        result.details.push({ file: relFile, action: 'skipped' });
        continue;
      }

      if (fs.existsSync(destPath)) {
        result.skipped++;
        result.details.push({ file: relFile, action: 'skipped' });
      } else {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
        result.imported++;
        result.details.push({ file: relFile, action: 'imported' });
      }
    }

    return result;
  } finally {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** CLI handler: forgen compound export */
export async function handleExport(args: string[]): Promise<void> {
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : undefined;

  try {
    const result = exportKnowledge(outputPath);

    console.log('\n  Compound Knowledge Export\n');
    console.log(`  Output: ${result.outputPath}`);
    console.log();
    for (const [category, count] of Object.entries(result.counts)) {
      console.log(`    ${category}: ${count} files`);
    }
    console.log(`\n  Total: ${result.totalFiles} files exported.\n`);
  } catch (e) {
    console.error(`\n  Export failed: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

/** CLI handler: forgen compound import */
export async function handleImport(args: string[]): Promise<void> {
  const archivePath = args[0];

  if (!archivePath || archivePath.startsWith('--')) {
    console.log('  Usage: forgen compound import <path-to-archive>\n');
    return;
  }

  try {
    const resolved = path.resolve(archivePath);
    const result = importKnowledge(resolved);

    console.log('\n  Compound Knowledge Import\n');
    console.log(`  Archive: ${resolved}`);
    console.log(`  Imported: ${result.imported} new files`);
    console.log(`  Skipped: ${result.skipped} existing files`);

    if (result.details.length > 0 && result.details.length <= 20) {
      console.log();
      for (const d of result.details) {
        const icon = d.action === 'imported' ? '+' : '-';
        console.log(`    ${icon} ${d.file}`);
      }
    }
    console.log();
  } catch (e) {
    console.error(`\n  Import failed: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
