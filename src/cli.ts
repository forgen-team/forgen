#!/usr/bin/env node

const nodeVersion = parseInt(process.version.slice(1).split('.')[0], 10);
if (nodeVersion < 20) {
  console.error(`[Forgen] Node.js 20 or higher is required. Current: ${process.version}`);
  process.exit(1);
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHarness, isFirstRun } from './core/harness.js';
import { spawnClaudeWithResume } from './core/spawn.js';
import { resolveLaunchContext } from './services/session.js';
// global-config is used by harness internally

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));
const PKG_VERSION: string = pkgJson.version ?? '0.0.0';

const launchContext = resolveLaunchContext(process.argv.slice(2));
const args = launchContext.args;
const runtime = launchContext.runtime;

// ---------------------------------------------------------------------------
// Command Registry — "쓸수록 나를 더 잘 아는 Claude"에 필요한 것만
// ---------------------------------------------------------------------------

interface Command {
  name: string;
  aliases?: string[];
  description: string;
  handler: (args: string[]) => Promise<void>;
}

const commands: Command[] = [
  {
    name: 'forge',
    description: 'Personalization profile (--profile|--export|--reset)',
    handler: async (args) => {
      const { handleForge } = await import('./forge/cli.js');
      await handleForge(args);
    },
  },
  {
    name: 'compound',
    description: 'Preview/save compound insights and manage accumulated knowledge',
    handler: async (args) => {
      const { handleCompound } = await import('./engine/compound-loop.js');
      await handleCompound(args);
    },
  },
  {
    name: 'skill',
    description: 'Skill management (promote|list)',
    handler: async (args) => {
      const sub = args[0];
      if (sub === 'promote' && args[1]) {
        const { promoteSolution } = await import('./engine/skill-promoter.js');
        const triggers = args.includes('--trigger')
          ? args.slice(args.indexOf('--trigger') + 1).filter(a => !a.startsWith('-'))
          : undefined;
        const result = promoteSolution(args[1], triggers);
        if (result.success) {
          console.log(`\n  ✓ Promoted: ${args[1]} → ${result.skillPath}\n`);
        } else {
          console.log(`\n  ✗ ${result.reason}\n`);
        }
      } else if (sub === 'list') {
        const { listSkills } = await import('./engine/skill-promoter.js');
        const skills = listSkills();
        if (skills.length === 0) {
          console.log('\n  No promoted skills yet. Use `forgen skill promote <solution-name>`\n');
        } else {
          console.log(`\n  Promoted Skills (${skills.length}):\n`);
          for (const s of skills) {
            console.log(`    ${s.name} [${s.status}] triggers: ${s.triggers.join(', ')}`);
          }
          console.log('');
        }
      } else {
        console.log('  Usage:\n    forgen skill promote <solution-name> [--trigger "keyword"]\n    forgen skill list');
      }
    },
  },
  {
    name: 'dashboard',
    description: 'Compound system dashboard with rich overview',
    handler: async (_args) => {
      const { handleDashboard } = await import('./core/dashboard.js');
      await handleDashboard();
    },
  },
  {
    name: 'learn',
    description: 'Solution maintenance: fix-up | quarantine | fitness',
    handler: async (args) => {
      const { handleLearn } = await import('./engine/learn-cli.js');
      await handleLearn(args);
    },
  },
  {
    name: 'me',
    description: 'Personal dashboard (→ inspect profile)',
    handler: async (_args) => {
      const { handleInspect } = await import('./core/inspect-cli.js');
      await handleInspect(['profile']);
    },
  },
  {
    name: 'config',
    description: 'Configuration (hooks [--regenerate])',
    handler: async (args) => {
      const sub = args[0];
      if (sub === 'hooks') {
        if (args.includes('--regenerate')) {
          const { writeHooksJson } = await import('./hooks/hooks-generator.js');
          const hooksDir = path.join(process.cwd(), 'hooks');
          const result = writeHooksJson(hooksDir, { cwd: process.cwd(), runtime });
          console.log(`[forgen] hooks.json regenerated: ${result.active} active, ${result.disabled} disabled`);
        } else {
          const { displayHookStatus } = await import('./core/config-hooks.js');
          await displayHookStatus(process.cwd());
        }
      } else {
        console.log('Usage: forgen config hooks [--regenerate]');
      }
    },
  },
  {
    name: 'mcp',
    description: 'MCP server management (list|templates|add|remove)',
    handler: async (args) => {
      const { handleMcp } = await import('./core/mcp-config.js');
      await handleMcp(args);
    },
  },
  {
    name: 'init',
    description: 'Initialize project',
    handler: async (args) => {
      const { handleInit } = await import('./core/init.js');
      await handleInit(args);
    },
  },
  {
    name: 'notepad',
    description: 'Notepad (show|add|clear)',
    handler: async (args) => {
      const { handleNotepad } = await import('./core/notepad.js');
      await handleNotepad(args);
    },
  },
  {
    name: 'inspect',
    description: 'v1 state inspector (profile|rules|evidence|session)',
    handler: async (args) => {
      const { handleInspect } = await import('./core/inspect-cli.js');
      await handleInspect(args);
    },
  },
  {
    name: 'onboarding',
    description: 'v1 2-question onboarding flow',
    handler: async (_args) => {
      const { runOnboarding } = await import('./forge/onboarding-cli.js');
      await runOnboarding();
    },
  },
  {
    name: 'doctor',
    description: 'Diagnostics (--prune-state to GC stale session files)',
    handler: async (args) => {
      const { runDoctor } = await import('./core/doctor.js');
      await runDoctor({ pruneState: args.includes('--prune-state') });
    },
  },
  // install --plugin 제거됨 — postinstall이 유일한 설치 경로
  // 수동 재설치: node scripts/postinstall.js
  {
    name: 'uninstall',
    description: 'Remove forgen from settings [--force] [--purge (also deletes ~/.forgen/)]',
    handler: async (args) => {
      const { handleUninstall } = await import('./core/uninstall.js');
      await handleUninstall(process.cwd(), {
        force: args.includes('--force'),
        purge: args.includes('--purge'),
      });
    },
  },
  {
    name: 'rule',
    description: 'Rule management (list|suppress|activate|scan|health-scan|classify)',
    handler: async (args) => {
      await handleRuleNamespace(args);
    },
  },
  {
    name: 'classify-enforce',
    aliases: ['rule-classify'],
    description: '[alias: rule classify] Propose enforce_via for rules (ADR-001 migration).',
    handler: async (args) => {
      const { handleClassifyEnforce } = await import('./engine/classify-enforce-cli.js');
      await handleClassifyEnforce(args);
    },
  },
  {
    name: 'rule-meta-scan',
    description: '[alias: rule health-scan] Scan drift for stuck-loop events and demote Mech-A rules.',
    handler: async (args) => {
      const { handleRuleMetaScan } = await import('./engine/lifecycle/meta-cli.js');
      await handleRuleMetaScan(args);
    },
  },
  {
    name: 'lifecycle-scan',
    description: '[alias: rule scan] Run all rule lifecycle triggers (T1~T5 + Meta).',
    handler: async (args) => {
      const { handleLifecycleScan } = await import('./engine/lifecycle/lifecycle-cli.js');
      await handleLifecycleScan(args);
    },
  },
  {
    name: 'stats',
    description: 'One-screen dashboard: active rules, corrections, blocks/bypass/drift (7d).',
    handler: async (args) => {
      const { handleStats } = await import('./core/stats-cli.js');
      await handleStats(args);
    },
  },
  {
    name: 'last-block',
    description: 'Show the most recent Mech-A/B block event with rule detail (R6-UX2).',
    handler: async (_args) => {
      const { handleInspect } = await import('./core/inspect-cli.js');
      await handleInspect(['violations', '--last', '1']);
    },
  },
  {
    name: 'suppress-rule',
    description: '[alias: rule suppress] Disable a rule by id/prefix. Hard rules refused.',
    handler: async (args) => {
      const { handleSuppressRule } = await import('./engine/rule-toggle-cli.js');
      await handleSuppressRule(args);
    },
  },
  {
    name: 'activate-rule',
    description: '[alias: rule activate] Re-activate a suppressed rule by id/prefix.',
    handler: async (args) => {
      const { handleActivateRule } = await import('./engine/rule-toggle-cli.js');
      await handleActivateRule(args);
    },
  },
];

// ---------------------------------------------------------------------------
// `forgen rule <subcommand>` — user-facing namespace (R9-IA1)
// Thin dispatcher that routes to existing handlers. Top-level legacy commands
// (suppress-rule, activate-rule, lifecycle-scan, rule-meta-scan, classify-enforce)
// remain as backward-compatible aliases.
// ---------------------------------------------------------------------------
async function handleRuleNamespace(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(`
  forgen rule — manage personalization rules

  Usage:
    forgen rule list                       List all rules (alias: inspect rules)
    forgen rule suppress <id-or-prefix>    Disable a rule (hard rules refused)
    forgen rule activate <id-or-prefix>    Re-activate a suppressed rule
    forgen rule scan [--apply]             Run lifecycle triggers (promote/demote/retire)
    forgen rule health-scan [--apply]      Scan drift → Mech downgrade candidates
    forgen rule classify [--apply] [--force]
                                           Propose enforce_via for legacy rules
`);
    return;
  }

  switch (sub) {
    case 'list': {
      const { handleInspect } = await import('./core/inspect-cli.js');
      await handleInspect(['rules', ...rest]);
      return;
    }
    case 'suppress': {
      const { handleSuppressRule } = await import('./engine/rule-toggle-cli.js');
      await handleSuppressRule(rest);
      return;
    }
    case 'activate': {
      const { handleActivateRule } = await import('./engine/rule-toggle-cli.js');
      await handleActivateRule(rest);
      return;
    }
    case 'scan': {
      const { handleLifecycleScan } = await import('./engine/lifecycle/lifecycle-cli.js');
      await handleLifecycleScan(rest);
      return;
    }
    case 'health-scan': {
      const { handleRuleMetaScan } = await import('./engine/lifecycle/meta-cli.js');
      await handleRuleMetaScan(rest);
      return;
    }
    case 'classify': {
      const { handleClassifyEnforce } = await import('./engine/classify-enforce-cli.js');
      await handleClassifyEnforce(rest);
      return;
    }
    default: {
      console.error(`[forgen] Unknown rule subcommand: ${sub}\n  Run "forgen rule help" for options.`);
      process.exit(1);
    }
  }
}

/** 최소 편집 거리 (유사 명령 제안용) */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function findCommand(name: string): Command | undefined {
  return commands.find(
    (c) => c.name === name || (c.aliases?.includes(name)),
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return;
  }
  if (args[0] === '--version' || args[0] === '-V') {
    console.log(PKG_VERSION);
    return;
  }

  const cmd = findCommand(args[0]);
  if (cmd) {
    await cmd.handler(args.slice(1));
    return;
  }

  // 등록되지 않은 서브커맨드는 에러 처리
  // 플래그(--resume 등), 따옴표 프롬프트, 인자 없는 실행은 하네스로 통과
  if (args[0] && !args[0].startsWith('-') && !args[0].startsWith('"') && !args[0].startsWith("'")) {
    const suggestion = commands
      .map(c => ({ name: c.name, dist: levenshtein(args[0], c.name) }))
      .filter(c => c.dist <= 3)
      .sort((a, b) => a.dist - b.dist)[0];
    const hint = suggestion ? `\n  Did you mean: forgen ${suggestion.name}` : '';
    console.error(`[forgen] Unknown command: ${args[0]}${hint}\n  Run "forgen help" for available commands.`);
    process.exit(1);
  }

  // Default: run Claude Code with harness
  try {
    const firstRun = isFirstRun();

    if (firstRun) {
      console.log(`
  ╔══════════════════════════════════════════════╗
  ║  Welcome to Forgen                          ║
  ╚══════════════════════════════════════════════╝

  The more you use Claude with Forgen,
  the better Claude gets at helping YOU.

  Setting up...`);
    }

    let context = await prepareHarness(process.cwd(), { runtime });

    // 첫 실행 또는 프로필 없음 → 자동 온보딩 (interactive 환경)
    if (context.v1.needsOnboarding && process.stdin.isTTY) {
      console.log('\n  프로필이 없습니다. 온보딩을 시작합니다.\n');
      const { runOnboarding } = await import('./forge/onboarding-cli.js');
      await runOnboarding();
      // 온보딩 후 harness 재실행 (프로필 반영)
      context = await prepareHarness(process.cwd(), { runtime });
    }

    if (firstRun && !context.v1.needsOnboarding) {
      console.log(`
  Setup complete!
`);
    }

    const bold = '\x1b[1m';
    const cyan = '\x1b[36m';
    const dim = '\x1b[2m';
    const reset = '\x1b[0m';
    console.log(`
  ${bold}${cyan}█▀▀ █▀█ █▀█ █▀▀ █▀▀ █▄░█${reset}
  ${bold}${cyan}█▀▀ █▄█ █▀▄ █▄█ ██▄ █░▀█${reset}  ${dim}v${PKG_VERSION}${reset}

  ${dim}Code, forged for you.${reset}
  ${dim}Scope: v1(${context.v1.session?.quality_pack ?? 'onboarding needed'})${reset}
`);
    const runtimeLabel = runtime === 'codex' ? 'Codex' : 'Claude';
    console.log(`[forgen] Starting ${runtimeLabel}...\n`);

    await spawnClaudeWithResume(args, context, () => prepareHarness(process.cwd(), { runtime }), runtime);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Codex is not installed')) {
      console.error('[forgen] Codex is not installed.');
    } else if (msg.includes('Claude Code is not installed')) {
      console.error('[forgen] Claude Code not found. Install: npm install -g @anthropic-ai/claude-code');
    } else {
      console.error('[forgen] Error:', msg);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// printHelp
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`
  Forgen v${PKG_VERSION}
  The more you use Claude, the better it knows you.

  Usage:
    forgen                          Start runtime launcher (harness mode)
    forgen "prompt"                 Start with a prompt
    forgen --resume                 Resume previous session
    forgen --runtime claude|codex   Select launch runtime

  Commands:
    forgen forge                    Personalize your coding profile
    forgen onboarding               Run 2-question onboarding
    forgen inspect [profile|rules|corrections|session]
                                    Inspect v1 state (alias: evidence → corrections)
    forgen rule <list|suppress|activate|scan|health-scan|classify>
                                    Rule management (see: forgen rule help)
    forgen stats                    One-screen trust-layer dashboard
    forgen last-block               Show the most recent block event
    forgen compound                 Manage accumulated knowledge
    forgen dashboard                Compound system dashboard
    forgen me                       Personal dashboard
    forgen init                     Initialize project
    forgen config hooks             Hook management
    forgen mcp                      MCP server management
    forgen skill promote|list       Skill management
    forgen notepad show|add|clear   Session notepad
    forgen doctor [--prune-state]   System diagnostics (+ daily T4 decay on prune)
    forgen uninstall                Remove forgen

  Harness mode (default):
    Wraps Claude (or Codex) with personalization, auto-compound, and safety hooks.
`);
}

main().catch(() => {
  process.exit(1);
});
