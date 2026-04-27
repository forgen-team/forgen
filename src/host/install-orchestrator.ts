/**
 * Install orchestrator — feat/codex-support P1-3
 *
 * `forgen install` CLI 의 분기 처리:
 *   - 인자 없음    → interactive 3-choice (claude/codex/both/quit)
 *   - 'claude'    → planClaudeInstall()
 *   - 'codex'     → planCodexInstall()
 *   - 'both'      → 둘 다 실행
 *
 * 사용자 host 선택 권한이 forgen 측에 위임 (1원칙: Claude default 강요 금지).
 * Phase 1 Round 2 의 *마이그레이션 정책 C* (기존 entry 보존) 와 함께 동작.
 */

import * as path from 'node:path';
import * as readline from 'node:readline';
import { detectAvailableHosts, type HostAvailability } from '../core/host-detect.js';
import { planClaudeInstall, type ClaudeInstallResult } from './install-claude.js';
import { planCodexInstall, type CodexInstallResult } from './install-codex.js';

export type InstallTarget = 'claude' | 'codex' | 'both';

export interface OrchestratorOptions {
  /** Sub-command 인자: 'claude'|'codex'|'both' 또는 undefined (interactive). */
  target?: string;
  pkgRoot: string;
  dryRun?: boolean;
  registerMcp?: boolean;
}

export interface OrchestratorResult {
  target: InstallTarget;
  claude?: ClaudeInstallResult;
  codex?: CodexInstallResult;
  detection: ReturnType<typeof detectAvailableHosts>;
}

function askChoice(rl: readline.Interface, question: string, validChoices: string[]): Promise<string> {
  return new Promise((resolve) => {
    const ask = () => {
      rl.question(question, (answer) => {
        const trimmed = answer.trim().toLowerCase();
        if (validChoices.includes(trimmed)) resolve(trimmed);
        else {
          console.log(`  Please enter one of: ${validChoices.join(', ')}`);
          ask();
        }
      });
    };
    ask();
  });
}

function renderHostStatus(host: HostAvailability): string {
  if (!host.available) return `  ✗ ${host.host} (not detected — binary 미설치 + ~/.${host.host}/ 부재)`;
  const bits: string[] = [];
  if (host.binaryFound) bits.push(`binary: ${host.binaryPath}`);
  if (host.homeExists) bits.push(`home: ${host.homePath}`);
  if (host.host === 'codex' && host.authPresent) bits.push('auth: present');
  return `  ✓ ${host.host} (${bits.join(', ')})`;
}

async function chooseTargetInteractively(detection: ReturnType<typeof detectAvailableHosts>): Promise<InstallTarget | null> {
  console.log('\n  [forgen] Setup wizard\n');
  console.log('  Detected hosts:');
  console.log(renderHostStatus(detection.claude));
  console.log(renderHostStatus(detection.codex));
  console.log('');

  if (detection.noneAvailable) {
    console.log('  ⚠ Neither Claude nor Codex detected. Install one of:');
    console.log('     - Claude Code: npm install -g @anthropic-ai/claude-code');
    console.log('     - Codex CLI:   npm install -g @openai/codex');
    return null;
  }

  console.log('  Where to register forgen?');
  console.log('    [1] Claude only');
  console.log('    [2] Codex only');
  console.log('    [3] Both');
  console.log('    [q] Quit');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const choice = await askChoice(rl, '  Choice: ', ['1', '2', '3', 'q']);
    if (choice === 'q') return null;
    return choice === '1' ? 'claude' : choice === '2' ? 'codex' : 'both';
  } finally {
    rl.close();
  }
}

export async function runInstall(opts: OrchestratorOptions): Promise<OrchestratorResult | null> {
  const detection = detectAvailableHosts();

  let target: InstallTarget;
  if (opts.target === 'claude' || opts.target === 'codex' || opts.target === 'both') {
    target = opts.target;
  } else if (opts.target === undefined) {
    const interactive = await chooseTargetInteractively(detection);
    if (interactive === null) return null;
    target = interactive;
  } else {
    throw new Error(`Unknown install target: ${opts.target}. Use claude|codex|both or omit for interactive.`);
  }

  const result: OrchestratorResult = { target, detection };
  const dryRun = opts.dryRun ?? false;
  const registerMcp = opts.registerMcp ?? true;

  if (target === 'claude' || target === 'both') {
    result.claude = planClaudeInstall({ pkgRoot: opts.pkgRoot, dryRun, registerMcp });
  }
  if (target === 'codex' || target === 'both') {
    result.codex = planCodexInstall({ pkgRoot: opts.pkgRoot, dryRun, registerMcp });
  }

  return result;
}

/** CLI 출력 포맷터 — orchestrator 결과를 사용자에게 표시. */
export function renderResult(result: OrchestratorResult, dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(`\n  [forgen] Install ${dryRun ? '(dry-run)' : 'completed'} — target: ${result.target}`);
  if (result.claude) {
    lines.push('');
    lines.push('  Claude:');
    lines.push(`    plugin cache: ${result.claude.pluginCachePath}`);
    lines.push(`    slash commands: ${result.claude.slashCommandsCount} → ${result.claude.slashCommandsPath}`);
    lines.push(`    settings.json hooks: ${result.claude.hooksInjected}`);
    lines.push(`    MCP: ${result.claude.mcpAlreadyPresent ? 'already present' : (result.claude.mcpRegistered ? 'registered' : 'skipped')}`);
  }
  if (result.codex) {
    lines.push('');
    lines.push('  Codex:');
    lines.push(`    CODEX_HOME: ${result.codex.codexHome}`);
    lines.push(`    hooks.json: ${result.codex.hooksCount} forgen hooks (preserved user: ${result.codex.preservedUserHookCount})`);
    lines.push(`    MCP: ${result.codex.mcpAlreadyPresent ? 'already present' : (result.codex.mcpRegistered ? 'registered' : 'skipped')}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** pkgRoot resolve from binary location (dist/cli.js → pkgRoot). */
export function resolvePkgRootFromBinary(metaUrl: string): string {
  const here = path.dirname(new URL(metaUrl).pathname);
  return path.resolve(here, '..');
}
