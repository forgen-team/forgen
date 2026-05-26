/**
 * Forgen — Compound Knowledge Extractor (facade)
 *
 * Orchestrates extraction pipeline: git analysis → quality gates →
 * pattern extraction → persistence. Re-exports from decomposed modules.
 *
 * Module layout (post-decomposition):
 *   extraction-git.ts         — getNewCommits, getCommitMessages, getGitDiff, getDiffStats
 *   extraction-gates.ts       — gate0-gate3, gateTrivial, evaluateExtractedSolution, ExtractedSolution
 *   extraction-diff.ts        — extractFromDiff, findCommonPrefix
 *   extraction-session.ts     — extractFromSessionContext, loadClaudeProjectSessionContext
 *   extraction-persistence.ts — saveExtractedSolution, updateReExtractedCounter, LastExtraction
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { execHost } from '../host/exec-host.js';
import { createLogger } from '../core/logger.js';
import { STATE_DIR } from '../core/paths.js';

import { getNewCommits, getCommitMessages, getGitDiff, getDiffStats } from './extraction-git.js';
import { gate0, evaluateExtractedSolution } from './extraction-gates.js';
import type { ExtractedSolution } from './extraction-gates.js';
import { extractFromDiff } from './extraction-diff.js';
import { extractFromSessionContext } from './extraction-session.js';
import {
  loadLastExtraction, saveLastExtraction,
  saveExtractedSolution, updateReExtractedCounter,
  emitCompoundExtractActedOn,
} from './extraction-persistence.js';
import type { LastExtraction } from './extraction-persistence.js';

const log = createLogger('compound-extractor');

const MAX_EXTRACTIONS_PER_DAY = 5;

// ── Re-exports (backward compatibility) ──

export { loadClaudeProjectSessionContext } from './extraction-session.js';
export type { ExtractedSolution } from './extraction-gates.js';

// ── Orchestration types ──

interface ExtractionAnalysis {
  state: LastExtraction;
  today: string;
  headSha: string;
  extracted: ExtractedSolution[];
  reason?: string;
  stats?: { files: number; lines: number; hasCodeFiles: boolean };
  persistStateWithoutSaving: boolean;
  gitDiff?: string;
}

// ── LLM enrichment (kept inline — ~30 lines, not worth a separate file) ──

function enrichSolutionContent(
  solution: { name: string; context: string; content: string; tags: string[] },
  diffSnippet: string,
): string | null {
  try {
    const prompt = [
      '다음 코드 변경에서 감지된 패턴을 2-3문장으로 설명해주세요.',
      '무엇이 바뀌었는지가 아니라, **왜 이 패턴이 유용한지**와 **언제 적용해야 하는지**를 설명하세요.',
      '',
      `패턴 이름: ${solution.name}`,
      `감지된 컨텍스트: ${solution.context}`,
      `태그: ${solution.tags.join(', ')}`,
      '',
      '코드 변경 (일부):',
      diffSnippet.slice(0, 2000),
    ].join('\n');

    const { message } = execHost({ prompt, model: 'haiku', timeout: 15000 });
    if (message.length > 30 && message.length < 1000) return message;
    return null;
  } catch {
    return null;
  }
}

// ── Orchestration ──

function analyzeExtraction(cwd: string, options?: { enforceDailyLimit?: boolean }): ExtractionAnalysis {
  const state = loadLastExtraction();
  const today = new Date().toISOString().split('T')[0];

  if (state.todayDate !== today) {
    state.extractionsToday = 0;
    state.todayDate = today;
  }

  if (options?.enforceDailyLimit !== false && state.extractionsToday >= MAX_EXTRACTIONS_PER_DAY) {
    return {
      state, today, headSha: '', extracted: [],
      reason: `일일 추출 한도 도달 (${MAX_EXTRACTIONS_PER_DAY}/일)`,
      persistStateWithoutSaving: false,
    };
  }

  const gitLog = getNewCommits(cwd, state.lastCommitSha);
  if (!gitLog.trim()) {
    return { state, today, headSha: '', extracted: [], reason: '새 커밋 없음', persistStateWithoutSaving: false };
  }

  let headSha = '';
  try {
    headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return { state, today, headSha: '', extracted: [], reason: 'git HEAD 조회 실패', persistStateWithoutSaving: false };
  }

  const stats = getDiffStats(cwd, state.lastCommitSha);
  if (!gate0(stats)) {
    return {
      state, today, headSha, extracted: [],
      reason: `Gate 0: 추출 가치 부족 (${stats.files} files, ${stats.lines} lines)`,
      stats, persistStateWithoutSaving: true,
    };
  }

  const gitDiff = getGitDiff(cwd, state.lastCommitSha);
  const commitMessages = getCommitMessages(cwd, state.lastCommitSha);

  const diffPatterns = extractFromDiff(gitLog, gitDiff);
  const contextPatterns = extractFromSessionContext(gitDiff, cwd, state.lastExtractedAt);

  if (commitMessages) {
    for (const sol of diffPatterns) {
      sol.context = sol.context
        ? `${sol.context}\n\nCommit context:\n${commitMessages.slice(0, 300)}`
        : `Commit context:\n${commitMessages.slice(0, 300)}`;
    }
  }

  const extracted = [...diffPatterns, ...contextPatterns].slice(0, 3);

  return { state, today, headSha, extracted, stats, persistStateWithoutSaving: false, gitDiff };
}

// ── Public API ──

export async function previewExtraction(cwd: string): Promise<{
  preview: ExtractedSolution[];
  skipped: string[];
  reason?: string;
}> {
  const analysis = analyzeExtraction(cwd, { enforceDailyLimit: false });
  if (analysis.reason) {
    return { preview: [], skipped: [], reason: analysis.reason };
  }

  const preview: ExtractedSolution[] = [];
  const skipped: string[] = [];

  for (const sol of analysis.extracted.slice(0, 3)) {
    const evaluation = evaluateExtractedSolution(sol);
    if (evaluation.action === 'accept') {
      preview.push(sol);
      continue;
    }
    if (evaluation.action === 're-extract') {
      skipped.push(evaluation.message ?? `${sol.name}: 재추출`);
      continue;
    }
    skipped.push(evaluation.message ?? `${sol.name}: skipped`);
  }

  return { preview, skipped };
}

export async function runExtraction(cwd: string, sessionId: string): Promise<{
  extracted: string[];
  skipped: string[];
  reason?: string;
}> {
  const result = { extracted: [] as string[], skipped: [] as string[] };
  const analysis = analyzeExtraction(cwd);

  if (analysis.reason) {
    if (analysis.persistStateWithoutSaving && analysis.headSha) {
      saveLastExtraction({
        ...analysis.state,
        lastCommitSha: analysis.headSha,
        lastExtractedAt: new Date().toISOString(),
      });
    }
    return { ...result, reason: analysis.reason };
  }

  if (analysis.extracted.length > 0) {
    let enrichCount = 0;
    for (const sol of analysis.extracted) {
      if (enrichCount >= 2) break;
      if (sol.content.length < 100 && analysis.state.extractionsToday < MAX_EXTRACTIONS_PER_DAY) {
        const enriched = enrichSolutionContent(sol, analysis.gitDiff ?? '');
        if (enriched) {
          sol.content = enriched;
          enrichCount++;
        }
      }
    }

    const { saved, skipped } = processExtractionResults(JSON.stringify(analysis.extracted), sessionId);
    result.extracted = saved;
    result.skipped = skipped;
  }

  analysis.state.lastCommitSha = analysis.headSha;
  analysis.state.lastExtractedAt = new Date().toISOString();
  analysis.state.extractionsToday++;
  saveLastExtraction(analysis.state);

  if (analysis.stats) {
    log.debug(`로컬 추출 완료: ${result.extracted.length} saved, ${result.skipped.length} skipped (${analysis.stats.files} files, ${analysis.stats.lines} lines)`);
  }

  return result;
}

/** Process LLM extraction results (called after LLM returns) */
export function processExtractionResults(
  rawJson: string,
  sessionId: string,
): { saved: string[]; skipped: string[] } {
  const saved: string[] = [];
  const skipped: string[] = [];

  let solutions: ExtractedSolution[];
  try {
    solutions = JSON.parse(rawJson);
    if (!Array.isArray(solutions)) return { saved, skipped };
  } catch {
    return { saved, skipped };
  }

  for (const sol of solutions.slice(0, 3)) {
    const evaluation = evaluateExtractedSolution(sol);
    if (evaluation.action === 'skip' || evaluation.action === 'duplicate') {
      skipped.push(evaluation.message ?? `${sol.name}: skipped`);
      continue;
    }
    if (evaluation.action === 're-extract') {
      try { updateReExtractedCounter(sol.tags); } catch (e) { log.debug('re-extract 카운터 업데이트 실패', e); }
      skipped.push(evaluation.message ?? `${sol.name}: 재추출`);
      continue;
    }

    sol.identifiers = sol.identifiers.filter(id => id.length >= 4);

    const savedName = saveExtractedSolution(sol, sessionId);
    if (savedName) {
      saved.push(savedName);
      emitCompoundExtractActedOn(sessionId, savedName, sol.content, null);
    } else {
      skipped.push(`${sol.name}: 파일 이미 존재`);
    }
  }

  return { saved, skipped };
}

/** Check if extraction is paused */
export function isExtractionPaused(): boolean {
  const pausePath = path.join(STATE_DIR, 'extraction-paused');
  return fs.existsSync(pausePath);
}

/** Pause auto-extraction */
export function pauseExtraction(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, 'extraction-paused'), new Date().toISOString());
}

/** Resume auto-extraction */
export function resumeExtraction(): void {
  const pausePath = path.join(STATE_DIR, 'extraction-paused');
  if (fs.existsSync(pausePath)) fs.unlinkSync(pausePath);
}
