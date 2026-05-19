/**
 * dev-guide-injector — fgx init 시 dev-guide principles 를
 * Claude (.claude/rules/dev-guide-principles.md) + Codex (AGENTS.md managed block)
 * 양쪽에 stack-aware 자동 inject.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── 상수 ──────────────────────────────────────────────────────────────────────

const AGENTS_MD_BEGIN = '<!-- >>> forgen-managed-rules -->';
const AGENTS_MD_END = '<!-- <<< forgen-managed-rules -->';

// ── 타입 ──────────────────────────────────────────────────────────────────────

export interface DetectedStack {
  side: 'fe' | 'be';
  stack: 'react' | 'vue' | 'node' | 'go';
  principlesFiles: string[]; // ['common.md', '<stack>.md']
}

export interface InjectResult {
  stack: DetectedStack | null;
  claudeRulePath: string;
  claudeRuleWritten: boolean;
  agentsMdPath: string;
  agentsMdInjected: boolean;
  bytesWritten: number;
}

export interface InjectOptions {
  cwd: string;
  pkgRoot: string;
  dryRun?: boolean;
}

// ── detectStack ───────────────────────────────────────────────────────────────

export function detectStack(cwd: string): DetectedStack | null {
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      if ('react' in deps || 'next' in deps) {
        return { side: 'fe', stack: 'react', principlesFiles: ['common.md', 'react.md'] };
      }
      if ('vue' in deps || 'nuxt' in deps) {
        return { side: 'fe', stack: 'vue', principlesFiles: ['common.md', 'vue.md'] };
      }
      return { side: 'be', stack: 'node', principlesFiles: ['common.md', 'node.md'] };
    } catch {
      // JSON parse 실패 — fall through to go.mod check
    }
  }

  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    return { side: 'be', stack: 'go', principlesFiles: ['common.md', 'go.md'] };
  }

  return null;
}

// ── readPrinciples ────────────────────────────────────────────────────────────

export function readPrinciples(pkgRoot: string, side: 'fe' | 'be', stack: string): string {
  const principlesDir = path.join(pkgRoot, 'assets', 'dev-guide', side, 'principles');
  const commonContent = fs.readFileSync(path.join(principlesDir, 'common.md'), 'utf-8');
  const stackContent = fs.readFileSync(path.join(principlesDir, `${stack}.md`), 'utf-8');

  return [
    `<!-- forgen dev-guide principles (auto-generated, do not edit) -->`,
    `<!-- source: assets/dev-guide/${side}/principles/common.md + ${stack}.md -->`,
    ``,
    `# common (${side})`,
    commonContent.trimEnd(),
    ``,
    `---`,
    ``,
    `# ${stack}`,
    stackContent.trimEnd(),
    ``,
  ].join('\n');
}

// ── injectDevGuidePrinciples ──────────────────────────────────────────────────

export function injectDevGuidePrinciples(opts: InjectOptions): InjectResult {
  const { cwd, pkgRoot, dryRun = false } = opts;

  const claudeRulePath = path.join(cwd, '.claude', 'rules', 'dev-guide-principles.md');
  const agentsMdPath = path.join(cwd, 'AGENTS.md');

  const emptyResult: InjectResult = {
    stack: null,
    claudeRulePath,
    claudeRuleWritten: false,
    agentsMdPath,
    agentsMdInjected: false,
    bytesWritten: 0,
  };

  const detected = detectStack(cwd);
  if (!detected) return emptyResult;

  const body = readPrinciples(pkgRoot, detected.side, detected.stack);

  // ── Claude side ──
  const claudeRuleWritten = writeClaudeRule({ claudeRulePath, body, dryRun });

  // ── Codex side ──
  const agentsMdInjected = upsertAgentsMd({ agentsMdPath, body, dryRun });

  return {
    stack: detected,
    claudeRulePath,
    claudeRuleWritten,
    agentsMdPath,
    agentsMdInjected,
    bytesWritten: dryRun ? 0 : body.length,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function writeClaudeRule(opts: { claudeRulePath: string; body: string; dryRun: boolean }): boolean {
  const { claudeRulePath, body, dryRun } = opts;

  const existing = fs.existsSync(claudeRulePath)
    ? fs.readFileSync(claudeRulePath, 'utf-8')
    : null;

  if (existing === body) return false;

  if (!dryRun) {
    fs.mkdirSync(path.dirname(claudeRulePath), { recursive: true });
    fs.writeFileSync(claudeRulePath, body, 'utf-8');
  }
  return true;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildDevGuideBlock(body: string): string {
  return [AGENTS_MD_BEGIN, body.trimEnd(), AGENTS_MD_END].join('\n');
}

function upsertAgentsMd(opts: { agentsMdPath: string; body: string; dryRun: boolean }): boolean {
  const { agentsMdPath, body, dryRun } = opts;

  const block = buildDevGuideBlock(body);
  const current = fs.existsSync(agentsMdPath) ? fs.readFileSync(agentsMdPath, 'utf-8') : '';

  const reMarker = new RegExp(`${escapeRegex(AGENTS_MD_BEGIN)}[\\s\\S]*?${escapeRegex(AGENTS_MD_END)}`);
  const hasBlock = reMarker.test(current);

  let newContent: string;
  if (hasBlock) {
    newContent = current.replace(reMarker, block);
  } else {
    const beginIdx = current.indexOf(AGENTS_MD_BEGIN);
    const endIdx = current.indexOf(AGENTS_MD_END);
    if (beginIdx !== -1 && endIdx === -1) {
      // self-heal: begin 만 있고 end 손상
      newContent = `${current.slice(0, beginIdx).replace(/\s+$/, '')}\n\n${block}\n`;
    } else if (current.length === 0) {
      // 신규 파일
      newContent = `# Agent Instructions (forgen-managed)\n\n${block}\n`;
    } else {
      // 기존 파일에 append
      newContent = `${current.replace(/\s+$/, '')}\n\n${block}\n`;
    }
  }

  if (newContent === current) return false;

  if (!dryRun) {
    fs.mkdirSync(path.dirname(agentsMdPath), { recursive: true });
    fs.writeFileSync(agentsMdPath, newContent, 'utf-8');
  }
  return true;
}
