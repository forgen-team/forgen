/**
 * Forgen v0.4.1 — `forgen recall` CLI (H5)
 *
 * 최근 UserPromptSubmit 에서 매칭/surface 된 솔루션을 사용자에게 되짚어주는 명령.
 *
 * 목적: v0.4.0 에서 compound 솔루션이 8,000+ 번 recall 되었지만 사용자는 0건을
 *   확인할 수 없었다. 이 CLI 는 `~/.forgen/state/implicit-feedback.jsonl` 과
 *   `~/.forgen/state/match-eval-log.jsonl` 을 읽어 "최근 어떤 지식이 붙었나" 를
 *   1초 안에 보여준다. `--show` 플래그로 솔루션 본문 preview 까지.
 *
 * Usage:
 *   forgen recall              최근 10건 요약
 *   forgen recall --limit 20   최근 N건
 *   forgen recall --show       본문 preview 포함
 *   forgen recall --json       JSON 출력 (script 연동용)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR, ME_SOLUTIONS } from './paths.js';

interface RecallEntry {
  at: string;
  sessionId: string;
  solution: string;
  match_score?: number;
}

function readJsonl(p: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(p)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

/** H5: implicit-feedback.jsonl 에서 recommendation_surfaced 만 시간역순으로 추출. */
export function loadRecentRecalls(limit: number = 10): RecallEntry[] {
  const entries = readJsonl(path.join(STATE_DIR, 'implicit-feedback.jsonl'));
  const out: RecallEntry[] = [];
  for (const e of entries) {
    if (e.type !== 'recommendation_surfaced') continue;
    if (typeof e.at !== 'string' || typeof e.solution !== 'string') continue;
    out.push({
      at: e.at,
      sessionId: typeof e.sessionId === 'string' ? e.sessionId : 'unknown',
      solution: e.solution,
      match_score: typeof e.match_score === 'number' ? e.match_score : undefined,
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** 솔루션 body preview — frontmatter 뒤 첫 N줄. */
function readSolutionPreview(solutionName: string, maxLines: number = 8): string | null {
  const candidates = [
    path.join(ME_SOLUTIONS, `${solutionName}.md`),
    path.join(ME_SOLUTIONS, solutionName),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      // frontmatter block skip (--- ... ---)
      const stripped = raw.replace(/^---[\s\S]*?---\n?/, '');
      const lines = stripped.split('\n').filter((l) => l.length > 0).slice(0, maxLines);
      return lines.join('\n');
    } catch {
      return null;
    }
  }
  return null;
}

interface ParsedArgs {
  limit: number;
  showBody: boolean;
  json: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  let limit = 10;
  let showBody = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--limit' && i + 1 < args.length) {
      const n = Number(args[++i]);
      if (Number.isFinite(n) && n > 0) limit = Math.min(100, Math.floor(n));
    } else if (a === '--show' || a === '--body') {
      showBody = true;
    } else if (a === '--json') {
      json = true;
    }
  }
  return { limit, showBody, json };
}

export async function handleRecall(args: string[]): Promise<void> {
  const { limit, showBody, json } = parseArgs(args);
  const recalls = loadRecentRecalls(limit);

  if (json) {
    const payload = recalls.map((r) => ({
      ...r,
      preview: showBody ? readSolutionPreview(r.solution) : undefined,
    }));
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (recalls.length === 0) {
    console.log('  (no recent recalls — run a session with compound hooks enabled)');
    return;
  }

  console.log('');
  console.log(`  forgen status --compound — last ${recalls.length} surfaced solution${recalls.length === 1 ? '' : 's'}`);
  console.log('  ─────────────────────────────────────────');
  for (const r of recalls) {
    const score = r.match_score !== undefined ? ` @${r.match_score.toFixed(2)}` : '';
    console.log(`  ${r.at.slice(0, 19).replace('T', ' ')}  ${r.solution}${score}`);
    if (showBody) {
      const body = readSolutionPreview(r.solution);
      if (body) {
        for (const line of body.split('\n')) console.log(`    │ ${line}`);
        console.log('');
      }
    }
  }
  console.log('');
}
