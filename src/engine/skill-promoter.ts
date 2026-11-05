/**
 * Forgen — Skill Promoter
 *
 * verified/mature 솔루션을 표준 SKILL.md(agentskills.io) 디렉터리로 승격한다. 변환은 Way 컴파일러(target: skill)가 한다.
 *   기본  : ~/.forgen/me/skills/<name>/SKILL.md
 *   --install : ~/.claude/skills/<name>/SKILL.md  (Claude Code 개인 스킬)
 *   --out <dir> : <dir>/<name>/SKILL.md
 * `compound --verify` 게이트는 그대로다. 내용이 빈 솔루션은 거부한다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSolutionV3 } from './solution-format.js';
import { createLogger } from '../core/logger.js';
import { ME_SOLUTIONS, ME_SKILLS, CLAUDE_DIR } from '../core/paths.js';
import { compile } from '../way/compile.js';
import { readSolutions } from '../way/extract.js';
import { writeFiles } from '../way/io.js';
import { WAY_SCHEMA } from '../way/types.js';

const log = createLogger('skill-promoter');

export interface PromoteResult {
  success: boolean;
  paths?: string[];
  reason?: string;
}

export interface PromoteOptions { install?: boolean; out?: string; force?: boolean }

export function promoteSolution(solutionName: string, opts: PromoteOptions = {}): PromoteResult {
  if (!/^[\w.-]+$/.test(solutionName)) return { success: false, reason: `Invalid solution name: ${solutionName}` };
  const solPath = path.join(ME_SOLUTIONS, `${solutionName}.md`);
  if (!fs.existsSync(solPath)) return { success: false, reason: `Solution not found: ${solutionName}` };

  const parsed = parseSolutionV3(fs.readFileSync(solPath, 'utf-8'));
  if (!parsed) return { success: false, reason: `Failed to parse solution: ${solutionName}` };

  if (!['verified', 'mature'].includes(parsed.frontmatter.status)) {
    return {
      success: false,
      reason: `Only verified/mature solutions can be promoted. Current: ${parsed.frontmatter.status}. Use 'forgen compound --verify ${solutionName}' first.`,
    };
  }
  if (!parsed.content.trim()) return { success: false, reason: `Solution has no content: ${solutionName}. A skill needs a procedure to carry.` };

  const id = `solution:${solutionName}`;
  const item = readSolutions().items.find((i) => i.id === id);
  if (!item) return { success: false, reason: `Solution is not exportable (habit log or invalid): ${solutionName}` };

  const res = compile({ schema: WAY_SCHEMA, generator: 'forgen-way', generated_at: new Date().toISOString(), items: [item], stats: {} as never }, 'skill', { only: [id] });
  if (!res.files.length) return { success: false, reason: `Nothing to write for ${solutionName}` };

  // 컴파일러 경로(.claude/skills/<name>/SKILL.md)에서 <name>/SKILL.md 만 취해 대상 폴더에 놓는다.
  const files = res.files.map((f) => ({ ...f, path: f.path.replace(/^\.claude\/skills\//, '') }));
  const base = opts.out ? path.resolve(opts.out) : opts.install ? path.join(CLAUDE_DIR, 'skills') : ME_SKILLS;
  const { plan, written } = writeFiles(files, base, opts.force ?? false);
  const blocked = plan.find((p) => p.action.startsWith('blocked'));
  if (blocked) {
    return { success: false, reason: blocked.action === 'blocked-foreign'
      ? `${blocked.abs} exists and was not written by forgen. Not overwritten.`
      : `${blocked.abs} already exists with different content. Use --force to overwrite.` };
  }
  log.debug(`스킬 승격 완료: ${solutionName} → ${plan.map((p) => p.abs).join(', ')} (written ${written})`);
  return { success: true, paths: plan.map((p) => p.abs) };
}

/** 스킬 목록 조회 (SKILL.md 디렉터리 + 구 형식 .md) */
export function listSkills(): Array<{ name: string; status: string; description: string }> {
  if (!fs.existsSync(ME_SKILLS)) return [];
  const out: Array<{ name: string; status: string; description: string }> = [];
  for (const entry of fs.readdirSync(ME_SKILLS, { withFileTypes: true })) {
    const file = entry.isDirectory() ? path.join(ME_SKILLS, entry.name, 'SKILL.md') : entry.name.endsWith('.md') ? path.join(ME_SKILLS, entry.name) : '';
    if (!file || !fs.existsSync(file)) continue;
    try {
      const fm = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(file, 'utf-8'))?.[1];
      if (!fm) continue;
      const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? entry.name.replace(/\.md$/, '');
      const status = entry.isDirectory() ? 'standard' : (fm.match(/^status:\s*(.+)$/m)?.[1]?.trim() ?? 'legacy');
      let description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
      if (description.startsWith('"')) { try { description = JSON.parse(description); } catch { /* 그대로 */ } }
      out.push({ name, status, description: description.length > 80 ? `${description.slice(0, 79)}…` : description });
    } catch { /* 건너뜀 */ }
  }
  return out;
}
