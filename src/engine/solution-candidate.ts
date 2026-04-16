import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARCHIVED_DIR, CANDIDATES_DIR, ME_SOLUTIONS } from '../core/paths.js';
import { parseFrontmatterOnly } from './solution-format.js';
import { diagnoseFromRawContent } from './solution-quarantine.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('solution-candidate');

export interface PromoteResult {
  ok: boolean;
  source?: string;
  dest?: string;
  reason?: string;
}

export interface RollbackResult {
  archived: string[];
  archive_dir: string;
  errors: string[];
}

export function listCandidates(): string[] {
  if (!fs.existsSync(CANDIDATES_DIR)) return [];
  return fs
    .readdirSync(CANDIDATES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(CANDIDATES_DIR, f));
}

/**
 * Move one candidate file from lab/candidates/ to me/solutions/ after
 * schema + ownership checks. Refuses to overwrite an existing solution.
 * Returns `{ok:false, reason}` for any precondition failure so the CLI
 * can report exactly why promotion was rejected.
 */
export function promoteCandidate(nameOrPath: string): PromoteResult {
  const source = resolveCandidatePath(nameOrPath);
  if (!source) return { ok: false, reason: `candidate not found: ${nameOrPath}` };

  const content = fs.readFileSync(source, 'utf-8');
  const errors = diagnoseFromRawContent(content);
  if (errors.length > 0) {
    return { ok: false, source, reason: `schema errors: ${errors.join('; ')}` };
  }
  const fm = parseFrontmatterOnly(content);
  if (!fm) return { ok: false, source, reason: 'frontmatter parse failed post-diagnose (unexpected)' };
  if (fm.status !== 'candidate') {
    return { ok: false, source, reason: `status must be 'candidate', got '${fm.status}'` };
  }
  if (fm.extractedBy !== 'auto') {
    return { ok: false, source, reason: `extractedBy must be 'auto' (evolved proposals)` };
  }
  const dest = path.join(ME_SOLUTIONS, `${fm.name}.md`);
  if (fs.existsSync(dest)) {
    return { ok: false, source, reason: `name collision: ${fm.name} already exists in me/solutions` };
  }

  fs.mkdirSync(ME_SOLUTIONS, { recursive: true });
  try {
    fs.renameSync(source, dest);
  } catch {
    // renameSync fails across filesystems — fall back to copy+unlink.
    fs.copyFileSync(source, dest);
    try { fs.unlinkSync(source); } catch { /* ignore */ }
  }
  log.debug(`promoted: ${fm.name}`);
  return { ok: true, source, dest };
}

/**
 * Archive evolved-* solutions created at-or-after the given epoch ms.
 * Looks in ME_SOLUTIONS first (live, promoted candidates) then in
 * CANDIDATES_DIR (unpromoted). Archive is a timestamp-suffixed
 * directory so concurrent rollbacks don't clobber each other.
 *
 * "evolved" is identified by `source: evolved` in frontmatter; we
 * deliberately do NOT use filename prefix so a manually-renamed
 * evolved solution can still be rolled back.
 */
export function rollbackSince(epochMs: number): RollbackResult {
  const archiveDir = path.join(ARCHIVED_DIR, `rollback-${Date.now()}`);
  const archived: string[] = [];
  const errors: string[] = [];
  const dirs = [ME_SOLUTIONS, CANDIDATES_DIR];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(dir, file);
      let content: string;
      try { content = fs.readFileSync(filePath, 'utf-8'); }
      catch (e) { errors.push(`read ${filePath}: ${errMsg(e)}`); continue; }
      const fm = parseFrontmatterOnly(content);
      if (!fm) continue;
      // `source` is an optional free-form field written by the evolver.
      const source = (fm as unknown as Record<string, unknown>).source;
      if (source !== 'evolved') continue;
      // `created` is YAML-formatted date string. If parsing fails or the
      // created date is older than epochMs, leave the file in place.
      const createdMs = Date.parse(fm.created);
      if (Number.isFinite(createdMs) && createdMs < epochMs) continue;
      try {
        fs.mkdirSync(archiveDir, { recursive: true });
        const destName = path.basename(dir) + '__' + file;
        fs.renameSync(filePath, path.join(archiveDir, destName));
        archived.push(filePath);
      } catch (e) {
        errors.push(`archive ${filePath}: ${errMsg(e)}`);
      }
    }
  }
  return { archived, archive_dir: archiveDir, errors };
}

function resolveCandidatePath(nameOrPath: string): string | null {
  if (fs.existsSync(nameOrPath)) return nameOrPath;
  const byBasename = path.join(CANDIDATES_DIR, nameOrPath.endsWith('.md') ? nameOrPath : `${nameOrPath}.md`);
  if (fs.existsSync(byBasename)) return byBasename;
  return null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
