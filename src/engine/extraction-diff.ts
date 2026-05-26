/**
 * Pattern extraction from git diff.
 *
 * Extracted from compound-extractor.ts — heuristic extraction of reusable
 * patterns from git diff content without LLM involvement.
 */

import * as path from 'node:path';
import { extractTags } from './solution-format.js';
import type { ExtractedSolution } from './extraction-gates.js';

/** Find common prefix among an array of strings */
export function findCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    while (!s.startsWith(prefix) && prefix.length > 0) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix.replace(/-$/, '');
}

/** Simple local extraction from git diff (no LLM needed) */
export function extractFromDiff(gitLog: string, gitDiff: string): ExtractedSolution[] {
  const solutions: ExtractedSolution[] = [];

  // 1. Detect new files/modules created
  const newFiles = gitDiff.match(/^\+\+\+ b\/(.+)$/gm);
  if (newFiles && newFiles.length >= 2) {
    const fileNames = newFiles.map(f => f.replace('+++ b/', ''));
    const ext = path.extname(fileNames[0]);
    const dir = path.dirname(fileNames[0]).split('/').pop() ?? '';
    if (ext && dir) {
      const basenames = fileNames.map(f => path.basename(f, ext));
      const commonPrefix = findCommonPrefix(basenames);
      if (commonPrefix.length >= 3) {
        solutions.push({
          name: `module-${commonPrefix}-pattern`,
          type: 'pattern',
          tags: extractTags(`${fileNames.join(' ')} ${dir}`),
          identifiers: basenames.filter(b => b.length >= 4).slice(0, 5),
          context: `File organization pattern in ${dir}/`,
          content: `Files follow the naming pattern: ${commonPrefix}*${ext} in ${dir}/`,
        });
      }
    }
  }

  // 2. Detect error handling patterns from diff
  const errorPatterns = gitDiff.match(/^\+.*(?:try\s*\{|catch\s*[({]|\.catch\(|throw new|Error\()/gm);
  if (errorPatterns && errorPatterns.length >= 3) {
    const sample = errorPatterns.slice(0, 3).map(l => l.replace(/^\+\s*/, '').trim());
    solutions.push({
      name: 'error-handling-pattern',
      type: 'pattern',
      tags: ['error', 'handling', 'try-catch', 'pattern'],
      identifiers: sample.filter(s => s.length >= 4).slice(0, 3),
      context: 'Error handling approach used in this codebase',
      content: `Consistent error handling: ${sample.join('; ')}`.slice(0, 500),
    });
  }

  // 3. Detect import/dependency patterns
  const imports = gitDiff.match(/^\+\s*import\s+.+from\s+['"]([^'"]+)['"]/gm);
  if (imports && imports.length >= 3) {
    const packages = imports
      .map(i => i.match(/from\s+['"]([^'"]+)['"]/)?.[1])
      .filter((p): p is string => !!p && !p.startsWith('.'))
      .filter((v, i, a) => a.indexOf(v) === i);

    if (packages.length >= 2) {
      solutions.push({
        name: 'dependency-stack',
        type: 'decision',
        tags: ['dependency', 'stack', ...packages.slice(0, 3)],
        identifiers: packages.filter(p => p.length >= 4).slice(0, 5),
        context: 'Technology stack and dependency choices',
        content: `Project uses: ${packages.join(', ')}`,
      });
    }
  }

  // 4. Detect from commit messages
  const commitKeywords: Record<string, { type: ExtractedSolution['type']; tags: string[] }> = {
    'fix': { type: 'troubleshoot', tags: ['bugfix', 'troubleshoot'] },
    'refactor': { type: 'pattern', tags: ['refactor', 'cleanup'] },
    'test': { type: 'pattern', tags: ['testing', 'tdd'] },
    'security': { type: 'pattern', tags: ['security', 'hardening'] },
  };

  for (const [keyword, meta] of Object.entries(commitKeywords)) {
    const re = new RegExp(`^[a-f0-9]+\\s+${keyword}[:\\s](.+)$`, 'gim');
    const matches = [...gitLog.matchAll(re)];
    if (matches.length >= 2) {
      const descriptions = matches.map(m => m[1].trim()).slice(0, 3);
      const commitIdentifiers = descriptions
        .join(' ')
        .match(/\b[a-zA-Z][a-zA-Z0-9]*(?:[A-Z][a-z]+)+\b|\b[a-z]+(?:_[a-z]+)+\b/g)
        ?.filter(id => id.length >= 6)
        ?.filter((v, i, a) => a.indexOf(v) === i)
        ?.slice(0, 5) ?? [];

      solutions.push({
        name: `${keyword}-pattern`,
        type: meta.type,
        tags: [...meta.tags, keyword],
        identifiers: commitIdentifiers,
        context: `Recurring ${keyword} pattern from commit history`,
        content: descriptions.join('. ').slice(0, 500),
      });
    }
  }

  return solutions.slice(0, 3);
}
