#!/usr/bin/env node
/**
 * Forgen — PreCompact Hook
 *
 * 컨텍스트 압축(compaction) 전 상태 보존.
 * - 현재 활성 모드 상태 스냅샷
 * - 진행 중인 작업 요약 저장
 * - handoff 파일 생성 (압축 후 복구용)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../core/logger.js';
import { readStdinJSON } from './shared/read-stdin.js';
import { isHookEnabled } from './hook-config.js';
import { approve, approveWithWarning, failOpenWithTracking } from './shared/hook-response.js';
import { HANDOFFS_DIR, ME_BEHAVIOR, ME_RULES, STATE_DIR } from '../core/paths.js';
import { sanitizeId } from './shared/sanitize-id.js';

const log = createLogger('pre-compact');

/** 활성 모드 상태 수집 */
function collectActiveStates(): Array<{ mode: string; data: Record<string, unknown> }> {
  const active: Array<{ mode: string; data: Record<string, unknown> }> = [];

  if (!fs.existsSync(STATE_DIR)) return active;

  try {
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (!f.endsWith('-state.json') || f.startsWith('context-guard') || f.startsWith('skill-cache')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf-8'));
        if (data.active) {
          active.push({ mode: f.replace('-state.json', ''), data });
        }
      } catch (e) { log.debug(`상태 파일 파싱 실패 — skip`, e); }
    }
  } catch (e) {
    log.debug('상태 디렉토리 읽기 실패', e);
  }

  return active;
}

export interface SessionBrief {
  sessionId: string;
  mode: string;
  modifiedFiles: string[];
  promptCount: number;
  solutionsInjected: string[];
  correctionCount: number;
  generatedAt: string;
}

/** 세션 브리프 JSON 생성 */
export function buildSessionBrief(sessionId: string): SessionBrief {
  // modifiedFiles: read modified-files-{sessionId}.json (files field keys)
  let modifiedFiles: string[] = [];
  try {
    const modPath = path.join(STATE_DIR, `modified-files-${sanitizeId(sessionId)}.json`);
    if (fs.existsSync(modPath)) {
      const modData = JSON.parse(fs.readFileSync(modPath, 'utf-8'));
      if (modData.files && typeof modData.files === 'object') {
        modifiedFiles = Object.keys(modData.files);
      } else if (Array.isArray(modData.modifiedFiles)) {
        modifiedFiles = modData.modifiedFiles;
      } else if (Array.isArray(modData.fileEdits)) {
        modifiedFiles = modData.fileEdits;
      }
    }
  } catch { /* fail-open */ }

  // promptCount: read context-guard.json
  let promptCount = 0;
  try {
    const cgPath = path.join(STATE_DIR, 'context-guard.json');
    if (fs.existsSync(cgPath)) {
      const cgData = JSON.parse(fs.readFileSync(cgPath, 'utf-8'));
      if (typeof cgData.promptCount === 'number') {
        promptCount = cgData.promptCount;
      }
    }
  } catch { /* fail-open */ }

  // solutionsInjected: read injection-cache-*.json files, collect solutions[].name
  const solutionsInjected: string[] = [];
  try {
    if (fs.existsSync(STATE_DIR)) {
      for (const f of fs.readdirSync(STATE_DIR)) {
        if (!f.startsWith('injection-cache-') || !f.endsWith('.json')) continue;
        try {
          const cacheData = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf-8'));
          if (Array.isArray(cacheData.solutions)) {
            for (const sol of cacheData.solutions) {
              if (typeof sol.name === 'string' && !solutionsInjected.includes(sol.name)) {
                solutionsInjected.push(sol.name);
              }
            }
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* fail-open */ }

  // correctionCount: count files in ME_RULES with scope === 'session'
  let correctionCount = 0;
  try {
    if (fs.existsSync(ME_RULES)) {
      for (const f of fs.readdirSync(ME_RULES)) {
        if (!f.endsWith('.json')) continue;
        try {
          const rule = JSON.parse(fs.readFileSync(path.join(ME_RULES, f), 'utf-8'));
          if (rule.scope === 'session') correctionCount++;
        } catch { /* skip */ }
      }
    }
  } catch { /* fail-open */ }

  // mode: from collectActiveStates
  const activeStates = collectActiveStates();
  const mode = activeStates.length > 0 ? activeStates.map(s => s.mode).join('+') : 'general';

  return {
    sessionId,
    mode,
    modifiedFiles,
    promptCount,
    solutionsInjected,
    correctionCount,
    generatedAt: new Date().toISOString(),
  };
}

/** compaction 전 스냅샷 저장 */
function saveCompactionSnapshot(sessionId: string): string | null {
  const activeStates = collectActiveStates();
  if (activeStates.length === 0) return null;

  fs.mkdirSync(HANDOFFS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(HANDOFFS_DIR, `${timestamp}-pre-compact.md`);

  const lines = [
    '# Pre-Compaction Snapshot',
    `- Session: ${sessionId}`,
    `- Time: ${new Date().toISOString()}`,
    `- Reason: context compaction`,
    '',
    '## Active Modes',
  ];

  for (const { mode, data } of activeStates) {
    lines.push(`### ${mode}`);
    lines.push(`- Prompt: ${(data.prompt as string) ?? 'N/A'}`);
    lines.push(`- Started: ${(data.startedAt as string) ?? 'N/A'}`);
    lines.push('');
  }

  lines.push('## Recovery');
  lines.push('This snapshot was automatically created before compaction.');
  lines.push('Active modes are preserved in state files even after compaction.');

  fs.writeFileSync(snapshotPath, lines.join('\n'));
  return snapshotPath;
}

/** 7일 이상 된 handoff 파일 정리 */
function cleanOldHandoffs(): void {
  if (!fs.existsSync(HANDOFFS_DIR)) return;
  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  try {
    for (const f of fs.readdirSync(HANDOFFS_DIR)) {
      const p = path.join(HANDOFFS_DIR, f);
      const stat = fs.statSync(p);
      if (now - stat.mtimeMs > MAX_AGE_MS) {
        fs.unlinkSync(p);
      }
    }
  } catch (e) { log.debug('old handoff cleanup failed — stale files may remain in handoffs dir', e); }
}

async function main(): Promise<void> {
  const data = await readStdinJSON() ?? {};

  if (!isHookEnabled('pre-compact')) {
    console.log(approve());
    return;
  }

  const sessionId = (data.session_id as string) ?? 'default';

  // 오래된 handoff 정리
  cleanOldHandoffs();

  // 기존 behavioral 패턴 목록 로드 (중복 방지)
  let existingSolutions: string[] = [];
  try {
    const solDir = ME_BEHAVIOR;
    if (fs.existsSync(solDir)) {
      existingSolutions = fs.readdirSync(solDir).filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));
    }
  } catch { /* ignore */ }
  const existingList = existingSolutions.length > 0
    ? `\nAlready captured (skip these): ${existingSolutions.slice(-10).join(', ')}`
    : '';

  const compoundHint = `
<forgen-compound-extract>
Context is about to be compacted. Before it's lost, analyze this conversation and extract the USER's behavioral patterns.

DO NOT extract code patterns or technical solutions. Extract HOW THE USER WORKS:
- Decision-making style (e.g., "always verifies before trusting", "prefers data over intuition")
- Communication preferences (e.g., "wants Korean responses", "hates long explanations")
- Workflow sequences — repeated action ORDER patterns (e.g., "always runs tests → checks coverage → then commits", "bug fix: reproduce first → write test → fix → verify")
- Conditional approaches (e.g., "for refactoring: ensures tests pass first, then restructures", "for PRs: security check → test review → code quality")
- Values/philosophy (e.g., "quality over speed", "pragmatic over theoretical")

For each pattern found, write a file to ~/.forgen/me/behavior/{slug}.md in this EXACT format:
\`\`\`
---
name: "{slug}"
version: 1
kind: "{thinking|preference|workflow}"
observedCount: 1
confidence: 0.6
tags: ["thinking", "{category}", "{specific-tag}"]
created: "${new Date().toISOString().split('T')[0]}"
updated: "${new Date().toISOString().split('T')[0]}"
source: "pre-compact"
---

## Context
{When and why this pattern was observed in this conversation}

## Content
{Concrete description of the behavioral pattern, with specific examples from this session}
\`\`\`

Rules:
- Extract 0-3 patterns MAX (quality over quantity)
- Skip if nothing non-obvious was observed
- Skip patterns that are trivially obvious ("uses TypeScript")
- Each pattern must be specific enough to change Claude's behavior in future sessions${existingList}
</forgen-compound-extract>`;

  // 세션 브리프 저장
  try {
    const brief = buildSessionBrief(sessionId);
    fs.mkdirSync(HANDOFFS_DIR, { recursive: true });
    const briefTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const briefPath = path.join(HANDOFFS_DIR, `${briefTimestamp}-session-brief.json`);
    let briefJson = JSON.stringify(brief, null, 2);
    // max 1500 chars — truncate modifiedFiles and solutionsInjected if needed
    if (briefJson.length > 1500) {
      let truncBrief = { ...brief };
      while (briefJson.length > 1500 && (truncBrief.modifiedFiles.length > 0 || truncBrief.solutionsInjected.length > 0)) {
        if (truncBrief.solutionsInjected.length > 0) {
          truncBrief = { ...truncBrief, solutionsInjected: truncBrief.solutionsInjected.slice(0, Math.max(0, truncBrief.solutionsInjected.length - 1)) };
        } else {
          truncBrief = { ...truncBrief, modifiedFiles: truncBrief.modifiedFiles.slice(0, Math.max(0, truncBrief.modifiedFiles.length - 1)) };
        }
        briefJson = JSON.stringify(truncBrief, null, 2);
      }
    }
    fs.writeFileSync(briefPath, briefJson);
  } catch (e) {
    log.debug('세션 브리프 저장 실패', e);
  }

  // 스냅샷 저장
  try {
    const snapshotPath = saveCompactionSnapshot(sessionId);
    if (snapshotPath) {
      console.log(approveWithWarning(`<compound-compact-info>\n[Forgen] Pre-compaction state snapshot saved: ${path.basename(snapshotPath)}\nActive modes are preserved after compaction.\n</compound-compact-info>\n${compoundHint}`));
      return;
    }
  } catch (e) {
    log.debug('스냅샷 저장 실패', e);
  }

  console.log(approveWithWarning(compoundHint));
}

main().catch((e) => {
  process.stderr.write(`[ch-hook] ${e instanceof Error ? e.message : String(e)}\n`);
  console.log(failOpenWithTracking('pre-compact', e));
});
