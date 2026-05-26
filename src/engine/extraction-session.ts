/**
 * Session context extraction for compound knowledge.
 *
 * Extracted from compound-extractor.ts — reads Claude session JSONL files
 * to extract prompts and write history correlated to a specific project.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLAUDE_DIR, STATE_DIR } from '../core/paths.js';
import { createLogger } from '../core/logger.js';
import type { ExtractedSolution } from './extraction-gates.js';

const log = createLogger('extraction-session');

interface WriteContextEntry {
  filePath: string;
  contentSnippet: string;
  fileExtension: string;
}

function normalizeProjectPath(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return typeof fs.realpathSync.native === 'function'
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function getProjectPathCandidates(cwd: string): string[] {
  const resolved = path.resolve(cwd);
  const candidates = new Set<string>([resolved, normalizeProjectPath(cwd)]);

  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) {
      candidates.add(path.resolve(path.dirname(resolved), fs.readlinkSync(resolved)));
    }
  } catch {
    // Ignore lstat/readlink failures
  }

  for (const candidate of [...candidates]) {
    candidates.add(normalizeProjectPath(candidate));
  }

  return [...candidates];
}

function getClaudeProjectDirs(cwd: string): string[] {
  return getProjectPathCandidates(cwd)
    .map(candidate => path.join(CLAUDE_DIR, 'projects', candidate.replace(/[:\\/]/g, '-')));
}

function listClaudeSessionFiles(projectDirs: string[], maxFiles: number): Array<{ filePath: string; mtimeMs: number }> {
  return projectDirs
    .flatMap(projectDir => {
      let entries: string[];
      try {
        entries = fs.readdirSync(projectDir);
      } catch {
        return [] as Array<{ filePath: string; mtimeMs: number }>;
      }
      const out: Array<{ filePath: string; mtimeMs: number }> = [];
      for (const file of entries) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = path.join(projectDir, file);
        try {
          if (fs.lstatSync(filePath).isSymbolicLink()) continue;
          out.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs });
        } catch {
          // unreadable / vanished between readdir and stat — skip
        }
      }
      return out;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles);
}

function getAllClaudeProjectDirs(): string[] {
  const projectsRoot = path.join(CLAUDE_DIR, 'projects');
  if (!fs.existsSync(projectsRoot)) return [];

  return fs.readdirSync(projectsRoot)
    .map(name => path.join(projectsRoot, name))
    .filter(dir => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
}

function collectClaudeProjectSessionContext(
  files: Array<{ filePath: string; mtimeMs: number }>,
  cwdCandidates: Set<string>,
  cutoffMs: number,
): { prompts: string[]; writes: WriteContextEntry[] } {
  const prompts: string[] = [];
  const writes: WriteContextEntry[] = [];

  for (const file of files) {
    try {
      if (fs.lstatSync(file.filePath).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    let lines: string[];
    try {
      lines = fs.readFileSync(file.filePath, 'utf-8').split('\n').filter(Boolean);
    } catch {
      continue;
    }
    for (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const entryCandidates = typeof entry.cwd === 'string' ? getProjectPathCandidates(entry.cwd) : [];
      if (!entryCandidates.some(candidate => cwdCandidates.has(candidate))) continue;

      const timestamp = typeof entry.timestamp === 'string' ? new Date(entry.timestamp).getTime() : Number.NaN;
      if (cutoffMs && Number.isFinite(timestamp) && timestamp <= cutoffMs) continue;

      if (entry.type === 'user') {
        const message = entry.message as { role?: string; content?: unknown } | undefined;
        if (message?.role === 'user' && typeof message.content === 'string') {
          prompts.push(message.content);
        }
        continue;
      }

      if (entry.type !== 'assistant') continue;
      const message = entry.message as { role?: string; content?: unknown } | undefined;
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;

      for (const item of message.content) {
        if (typeof item !== 'object' || item === null) continue;
        const toolUse = item as {
          type?: string;
          name?: string;
          input?: Record<string, unknown>;
        };
        if (toolUse.type !== 'tool_use') continue;
        if (toolUse.name !== 'Write' && toolUse.name !== 'Edit') continue;
        const filePath = String(toolUse.input?.file_path ?? toolUse.input?.filePath ?? '');
        const content = String(toolUse.input?.content ?? toolUse.input?.new_string ?? '');
        if (!filePath || !content) continue;
        writes.push({
          filePath: filePath.slice(-100),
          contentSnippet: content.slice(0, 200),
          fileExtension: path.extname(filePath).toLowerCase(),
        });
      }
    }
  }

  return {
    prompts: prompts.slice(-50),
    writes: writes.slice(-30),
  };
}

export function loadPromptHistoryFallback(): string[] {
  const promptHistoryPath = path.join(STATE_DIR, 'prompt-history.jsonl');
  try {
    if (!fs.existsSync(promptHistoryPath)) return [];
    const lines = fs.readFileSync(promptHistoryPath, 'utf-8').split('\n').filter(Boolean);
    return lines.slice(-50).map(l => {
      try { return JSON.parse(l).prompt as string; } catch { return ''; }
    }).filter(Boolean);
  } catch (e) {
    log.debug('prompt-history.jsonl 읽기 실패 — session context fallback 건너뜀', e);
    return [];
  }
}

/**
 * Load Claude session prompts + writes correlated to `cwd`.
 *
 * Exported primarily for test assertions (the `claude-session-context`
 * tests verify correlation logic directly).
 */
export function loadClaudeProjectSessionContext(
  cwd: string,
  lastExtractedAt: string,
): { prompts: string[]; writes: WriteContextEntry[] } {
  const cwdCandidates = new Set(getProjectPathCandidates(cwd));
  const projectDirs = getClaudeProjectDirs(cwd).filter(dir => fs.existsSync(dir));
  const cutoffMs = lastExtractedAt ? new Date(lastExtractedAt).getTime() : 0;

  try {
    if (projectDirs.length > 0) {
      const primary = collectClaudeProjectSessionContext(listClaudeSessionFiles(projectDirs, 5), cwdCandidates, cutoffMs);
      if (primary.prompts.length > 0 || primary.writes.length > 0) return primary;
    }

    const fallbackDirs = getAllClaudeProjectDirs().filter(dir => !projectDirs.includes(dir));
    if (fallbackDirs.length === 0) return { prompts: [], writes: [] };

    return collectClaudeProjectSessionContext(listClaudeSessionFiles(fallbackDirs, 20), cwdCandidates, cutoffMs);
  } catch (e) {
    log.debug('Claude project session context 로드 실패 — fallback 사용', e);
    return { prompts: [], writes: [] };
  }
}

/** Extract patterns from accumulated session context (prompts + writes + diff) */
export function extractFromSessionContext(
  gitDiff: string,
  cwd: string,
  lastExtractedAt: string,
): ExtractedSolution[] {
  const solutions: ExtractedSolution[] = [];

  const claudeContext = loadClaudeProjectSessionContext(cwd, lastExtractedAt);

  let prompts = claudeContext.prompts;
  if (prompts.length === 0) {
    prompts = loadPromptHistoryFallback();
  }

  const techDecisions: string[] = [];
  const techTerms = ['react', 'vue', 'next', 'express', 'fastify', 'prisma', 'drizzle', 'zustand', 'redux', 'tailwind', 'styled', 'vitest', 'jest', 'playwright', 'cypress'];
  for (const term of techTerms) {
    const inPrompts = prompts.some(p => p.toLowerCase().includes(term));
    const inDiff = gitDiff.toLowerCase().includes(term);
    if (inPrompts && inDiff) {
      techDecisions.push(term);
    }
  }

  if (techDecisions.length >= 2) {
    solutions.push({
      name: 'tech-stack-decision',
      type: 'decision',
      tags: ['stack', 'technology', ...techDecisions.slice(0, 5)],
      identifiers: techDecisions.filter(t => t.length >= 4).slice(0, 5),
      context: 'Technology choices confirmed by both discussion and implementation',
      content: `Active technology stack: ${techDecisions.join(', ')}. Both discussed in prompts and present in code changes.`,
    });
  }

  return solutions;
}
