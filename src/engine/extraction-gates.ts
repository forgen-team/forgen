/**
 * Quality gates for compound extraction.
 *
 * Extracted from compound-extractor.ts — validation and dedup logic that
 * determines whether an extracted solution is worth persisting.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ME_SOLUTIONS } from '../core/paths.js';
import { createLogger } from '../core/logger.js';
import type { SolutionType } from './solution-format.js';

const log = createLogger('extraction-gates');

/** Shape of a solution extracted from git diff or session context */
export interface ExtractedSolution {
  name: string;
  type: SolutionType;
  tags: string[];
  identifiers: string[];
  context: string;
  content: string;
}

const TOXICITY_PATTERNS = [
  /@ts-ignore/i, /@ts-nocheck/i, /as\s+any\b/i,
  /--force\b/i, /--no-verify\b/i, /--skip-ci\b/i,
  /eslint-disable/i, /prettier-ignore/i, /noqa/i,
  /\bTODO:/i, /\bFIXME:/i, /\bHACK:/i, /\bXXX:/i,
  /\/Users\//i, /\/home\//i, /C:\\\\Users/i,
];

/** Gate 0: Is this extraction worth doing? */
export function gate0(stats: { files: number; lines: number; hasCodeFiles: boolean }): boolean {
  if (stats.files < 1) return false;
  if (stats.lines < 30) return false;
  if (!stats.hasCodeFiles) return false;
  return true;
}

/** Gate 1: Structural validation (pure — does not mutate input) */
export function gate1(sol: ExtractedSolution): boolean {
  if (!sol.name || sol.name.length < 3) return false;
  if (!sol.tags || sol.tags.length === 0) return false;
  if (!sol.content || sol.content.length < 50) return false;
  if (!sol.context) return false;
  return true;
}

/** Gate 2: Toxicity filter */
export function gate2(sol: ExtractedSolution): boolean {
  const text = `${sol.context} ${sol.content}`;
  return !TOXICITY_PATTERNS.some(p => p.test(text));
}

/**
 * Gate 2.5: Trivial pattern rejection — 자명한 패턴은 축적할 가치 없음.
 */
export function gateTrivial(sol: ExtractedSolution): boolean {
  const content = sol.content.trim();
  if (content.length < 80) return false;
  if (/^주로\s/.test(content) && content.split('\n').length < 3) return false;
  if (sol.identifiers.length === 0 && sol.tags.length < 3) return false;
  return true;
}

/** Gate 3: Dedup check against existing solutions */
export function gate3(sol: ExtractedSolution): 'new' | 're-extract' | 'duplicate' {
  if (!fs.existsSync(ME_SOLUTIONS)) return 'new';
  try {
    const files = fs.readdirSync(ME_SOLUTIONS).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(ME_SOLUTIONS, file), 'utf-8');
      const tagMatch = content.match(/tags:\s*\[([^\]]*)\]/);
      if (!tagMatch) continue;
      const existingTags = tagMatch[1].split(',').map(t => t.trim().replace(/"/g, ''));
      const overlap = sol.tags.filter(t => existingTags.includes(t));
      const overlapRatio = overlap.length / Math.max(sol.tags.length, existingTags.length, 1);
      if (overlapRatio >= 0.7) {
        if (content.includes('status: "experiment"') || content.includes("status: 'experiment'") || content.includes('status: experiment')) {
          return 're-extract';
        }
        return 'duplicate';
      }
    }
  } catch (e) { log.debug('gate3 기존 솔루션 파일 읽기 실패 — new로 간주', e); }
  return 'new';
}

/** Evaluate an extracted solution against all quality gates */
export function evaluateExtractedSolution(sol: ExtractedSolution): { action: 'accept' | 'skip' | 'duplicate' | 're-extract'; message?: string } {
  if (!gate1(sol)) return { action: 'skip', message: `${sol.name ?? 'unnamed'}: Gate 1 실패 (구조 검증)` };
  if (!gate2(sol)) return { action: 'skip', message: `${sol.name}: Gate 2 실패 (독성 필터)` };
  if (!gateTrivial(sol)) return { action: 'skip', message: `${sol.name}: Gate 2.5 실패 (자명한 패턴)` };

  const dupResult = gate3(sol);
  if (dupResult === 'duplicate') return { action: 'duplicate', message: `${sol.name}: Gate 3 중복` };
  if (dupResult === 're-extract') return { action: 're-extract', message: `${sol.name}: 재추출 (기존 솔루션 강화)` };

  return { action: 'accept' };
}
