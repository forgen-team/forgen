/**
 * Git helpers for compound extraction.
 *
 * Extracted from compound-extractor.ts — pure functions that shell out to git
 * for commit/diff data. All use execFileSync to prevent shell injection.
 */

import { execFileSync } from 'node:child_process';

const MAX_DIFF_LENGTH = 3000;

/** Validate that a string is a valid git SHA (7-64 hex chars) */
export function isValidSha(sha: string): boolean {
  return /^[a-f0-9]{7,64}$/.test(sha);
}

/** Get new commits since last extraction */
export function getNewCommits(cwd: string, lastSha: string): string {
  try {
    if (!lastSha || !isValidSha(lastSha)) {
      return execFileSync('git', ['log', '--oneline', '-5'], { cwd, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    return execFileSync('git', ['log', '--oneline', `${lastSha}..HEAD`], { cwd, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

/** Get commit messages for "why" context enrichment */
export function getCommitMessages(cwd: string, lastSha: string): string {
  try {
    const args = lastSha && isValidSha(lastSha)
      ? ['log', '--format=%B', `${lastSha}..HEAD`]
      : ['log', '--format=%B', '-5'];
    const msgs = execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 5000 });
    return msgs.slice(0, 1000).trim();
  } catch {
    return '';
  }
}

/** Get git diff for extraction */
export function getGitDiff(cwd: string, lastSha: string): string {
  try {
    const args = lastSha && isValidSha(lastSha)
      ? ['diff', `${lastSha}..HEAD`]
      : ['diff', 'HEAD~1'];
    const diff = execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 10000 });
    return diff.slice(0, MAX_DIFF_LENGTH);
  } catch {
    return '';
  }
}

/** Get diff stats for Gate 0 */
export function getDiffStats(cwd: string, lastSha: string): { files: number; lines: number; hasCodeFiles: boolean } {
  try {
    const args = lastSha && isValidSha(lastSha)
      ? ['diff', '--stat', `${lastSha}..HEAD`]
      : ['diff', '--stat', 'HEAD~1'];
    const stat = execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 5000 });
    const lines = stat.split('\n').filter(l => l.trim());
    const codeExts = /\.(ts|tsx|js|jsx|py|rs|go|java|rb|c|cpp|h|swift|kt)$/;
    const hasCodeFiles = lines.some(line => {
      const filePath = line.split('|')[0]?.trim() ?? '';
      return codeExts.test(filePath);
    });
    const lastLine = lines[lines.length - 1] ?? '';
    const changedMatch = lastLine.match(/(\d+)\s+files?\s+changed/);
    const insertMatch = lastLine.match(/(\d+)\s+insertion/);
    const deleteMatch = lastLine.match(/(\d+)\s+deletion/);
    const fileCount = parseInt(changedMatch?.[1] ?? '0', 10);
    const lineCount = parseInt(insertMatch?.[1] ?? '0', 10) + parseInt(deleteMatch?.[1] ?? '0', 10);
    return { files: fileCount, lines: lineCount, hasCodeFiles };
  } catch {
    return { files: 0, lines: 0, hasCodeFiles: false };
  }
}
