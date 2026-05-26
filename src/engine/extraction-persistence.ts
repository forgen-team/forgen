/**
 * Solution persistence for compound extraction.
 *
 * Extracted from compound-extractor.ts — saving extracted solutions,
 * updating re-extraction counters, and managing extraction state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ME_SOLUTIONS, STATE_DIR } from '../core/paths.js';
import { createLogger } from '../core/logger.js';
import { emitSolutionEvent } from '../core/observability-store.js';
import { serializeSolutionV3, DEFAULT_EVIDENCE } from './solution-format.js';
import type { SolutionV3 } from './solution-format.js';
import { atomicWriteJSON, atomicWriteText } from '../hooks/shared/atomic-write.js';
import { mutateSolutionFile } from './solution-writer.js';
import type { ExtractedSolution } from './extraction-gates.js';

const log = createLogger('extraction-persistence');

const LAST_EXTRACTION_PATH = path.join(STATE_DIR, 'last-extraction.json');

export interface LastExtraction {
  lastCommitSha: string;
  lastExtractedAt: string;
  extractionsToday: number;
  todayDate: string;
}

/** Load last extraction state */
export function loadLastExtraction(): LastExtraction {
  try {
    if (fs.existsSync(LAST_EXTRACTION_PATH)) {
      return JSON.parse(fs.readFileSync(LAST_EXTRACTION_PATH, 'utf-8'));
    }
  } catch (e) { log.debug('last extraction state read failed — may cause duplicate extractions', e); }
  return { lastCommitSha: '', lastExtractedAt: '', extractionsToday: 0, todayDate: '' };
}

/** Save last extraction state */
export function saveLastExtraction(state: LastExtraction): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  atomicWriteJSON(LAST_EXTRACTION_PATH, state);
}

/** Save an extracted solution as experiment */
export function saveExtractedSolution(sol: ExtractedSolution, _sessionId: string): string | null {
  const today = new Date().toISOString().split('T')[0];
  const slugName = sol.name.toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || `untitled-${Date.now()}`;

  const solution: SolutionV3 = {
    frontmatter: {
      name: slugName,
      version: 1,
      status: 'experiment',
      confidence: 0.3,
      type: sol.type,
      scope: 'me',
      tags: sol.tags.slice(0, 5),
      identifiers: sol.identifiers.filter(id => id.length >= 4),
      evidence: { ...DEFAULT_EVIDENCE },
      created: today,
      updated: today,
      supersedes: null,
      extractedBy: 'auto',
    },
    context: sol.context,
    content: sol.content,
  };

  const filePath = path.join(ME_SOLUTIONS, `${slugName}.md`);
  if (fs.existsSync(filePath)) return null;

  fs.mkdirSync(ME_SOLUTIONS, { recursive: true });
  atomicWriteText(filePath, serializeSolutionV3(solution));

  return slugName;
}

/**
 * Increment reExtracted counter on existing solution that matches given tags.
 */
export function updateReExtractedCounter(tags: string[]): void {
  if (!fs.existsSync(ME_SOLUTIONS)) return;
  const files = fs.readdirSync(ME_SOLUTIONS).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const filePath = path.join(ME_SOLUTIONS, file);
    try {
      if (fs.lstatSync(filePath).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    let preview: string;
    try { preview = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const tagMatch = preview.match(/tags:\s*\[([^\]]*)\]/);
    if (!tagMatch) continue;
    const existingTags = tagMatch[1].split(',').map(t => t.trim().replace(/"/g, ''));
    const overlap = tags.filter(t => existingTags.includes(t));
    if (overlap.length / Math.max(tags.length, existingTags.length, 1) < 0.7) continue;

    mutateSolutionFile(filePath, sol => {
      sol.frontmatter.evidence.reExtracted = (sol.frontmatter.evidence.reExtracted ?? 0) + 1;
      return true;
    });
    return;
  }
}

/**
 * Observability: detect references to existing solutions in new content → emit acted_on.
 */
export function emitCompoundExtractActedOn(sessionId: string, newSolutionName: string, newContent: string, newSupersedes: string | null): void {
  try {
    if (!fs.existsSync(ME_SOLUTIONS)) return;
    const bodyLower = newContent.toLowerCase();
    const supersedes = newSupersedes ?? '';
    const files = fs.readdirSync(ME_SOLUTIONS).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const existingName = path.basename(file, '.md');
      if (existingName === newSolutionName) continue;
      const referenced = (supersedes && existingName === supersedes)
                      || bodyLower.includes(existingName.toLowerCase());
      if (!referenced) continue;
      emitSolutionEvent({
        sessionId,
        solutionId: existingName,
        eventType: 'acted_on',
        signalSource: 'compound-extract',
        signalScore: 0.20,
        meta: {
          new_solution: newSolutionName,
          via: (supersedes && existingName === supersedes) ? 'supersedes' : 'body-mention',
        },
      });
    }
  } catch (e) {
    log.debug('emitCompoundExtractActedOn 실패', e);
  }
}
