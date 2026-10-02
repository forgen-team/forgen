import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { DEFAULT_EVIDENCE } from './solution-format.js';
import { diagnoseFromRawContent } from './solution-quarantine.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('solution-fixup');

export interface FixupReport {
  path: string;
  changed: boolean;
  added: string[];
  remaining_errors: string[];
}

export interface FixupResult {
  scanned: number;
  fixed: number;
  untouched: number;
  unfixable: number;
  reports: FixupReport[];
}

/**
 * Attempt to repair known-safe frontmatter defects.
 *
 * Handled defects (pre-0.3.1 schema drift, observed on 5 auto-extracted
 * solutions from 2026-04-10):
 *   - `extractedBy` missing → add `extractedBy: auto`
 *   - `evidence` block missing → add `DEFAULT_EVIDENCE`
 *
 * All other validation errors (bad scope, non-numeric confidence, etc.)
 * are surfaced in `remaining_errors` and the file is left untouched —
 * those require human judgement, not a mechanical default.
 *
 * `dryRun: true` (default) reports what would change without writing.
 */
export function fixupSolutions(
  solutionsDir: string,
  opts: { dryRun?: boolean } = {},
): FixupResult {
  const dryRun = opts.dryRun !== false;
  const result: FixupResult = { scanned: 0, fixed: 0, untouched: 0, unfixable: 0, reports: [] };
  if (!fs.existsSync(solutionsDir)) return result;
  const files = fs.readdirSync(solutionsDir).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    const filePath = path.join(solutionsDir, file);
    result.scanned++;
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf-8'); }
    catch { result.unfixable++; continue; }

    const errors = diagnoseFromRawContent(content);
    if (errors.length === 0) { result.untouched++; continue; }

    const fix = tryFix(content, errors);
    result.reports.push({
      path: filePath,
      changed: fix.changed,
      added: fix.added,
      remaining_errors: fix.remaining,
    });
    if (fix.changed && fix.remaining.length === 0) {
      if (!dryRun) {
        try {
          fs.writeFileSync(filePath, fix.content);
          log.debug(`fixed: ${filePath} (${fix.added.join(', ')})`);
        } catch (e) {
          log.debug(`write failed: ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
          result.unfixable++;
          continue;
        }
      }
      result.fixed++;
    } else {
      result.unfixable++;
    }
  }
  return result;
}

interface FixAttempt {
  changed: boolean;
  added: string[];
  remaining: string[];
  content: string;
}

function tryFix(content: string, initialErrors: string[]): FixAttempt {
  const trimmed = content.trimStart();
  const added: string[] = [];
  if (!trimmed.startsWith('---')) {
    return { changed: false, added, remaining: initialErrors, content };
  }
  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) {
    return { changed: false, added, remaining: initialErrors, content };
  }
  const leadingWs = content.slice(0, content.length - trimmed.length);
  const fmRaw = trimmed.slice(3, endIdx);
  const body = trimmed.slice(endIdx + 3);
  let fm: Record<string, unknown>;
  try {
    const parsed = yaml.load(fmRaw, { schema: yaml.CORE_SCHEMA });
    if (parsed == null || typeof parsed !== 'object') {
      return { changed: false, added, remaining: initialErrors, content };
    }
    fm = parsed as Record<string, unknown>;
  } catch {
    return { changed: false, added, remaining: initialErrors, content };
  }

  if (fm.extractedBy !== 'auto' && fm.extractedBy !== 'manual') {
    fm.extractedBy = 'auto';
    added.push('extractedBy: auto');
  }
  if (fm.evidence == null || typeof fm.evidence !== 'object') {
    fm.evidence = { ...DEFAULT_EVIDENCE };
    added.push('evidence: default');
  }
  if (fm.supersedes === undefined) {
    fm.supersedes = null;
    added.push('supersedes: null');
  }

  const newFmRaw = yaml.dump(fm, { lineWidth: 120, noRefs: true, sortKeys: false });
  const rebuilt = `${leadingWs}---\n${newFmRaw}---${body}`;
  const remaining = diagnoseFromRawContent(rebuilt);
  return {
    changed: added.length > 0,
    added,
    remaining,
    content: rebuilt,
  };
}
