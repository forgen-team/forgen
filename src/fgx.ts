#!/usr/bin/env node

/**
 * fgx — forgen --dangerously-skip-permissions 의 단축 명령
 *
 * 기본 동작: 모든 인자를 Claude(또는 Codex) 로 그대로 전달 + 권한 우회 플래그 자동 주입.
 * v0.4.10: forgen 서브커맨드(status/init/install/maintenance/compound 등)는
 *          Claude 로 안 넘기고 cli.js 로 라우팅 (사용자 혼동 갭 해소).
 */

import { resolveLaunchContext } from './services/session.js';
import { prepareHarness, isFirstRun } from './core/harness.js';
import { spawnClaude } from './core/spawn.js';
import { getHostRuntime } from './host/host-runtime.js';

const args = process.argv.slice(2);

// v0.4.10: forgen 서브커맨드 인벤토리. src/cli.ts 의 commands[] 와 sync 유지.
// 첫 비-플래그 인자가 이 집합에 들어가면 forgen cli 로 라우팅.
const FORGEN_SUBCOMMANDS = new Set([
  'forge', 'compound', 'skill', 'dashboard', 'learn', 'me', 'statusline',
  'config', 'mcp', 'init', 'install', 'status', 'maintenance', 'parity',
  'notepad', 'inspect', 'onboarding', 'doctor', 'uninstall', 'rule',
  'classify-enforce', 'rule-meta-scan', 'lifecycle-scan',
  'stats', 'last-block', 'recall', 'migrate', 'suppress-rule', 'activate-rule',
  'regress-map', 'watch', 'health', 'probe-workflow', 'workflows', 'explain', 'changelog',
  // 메타 명령도 cli.ts 가 처리 (fgx claude spawn 으로는 의미 없음)
  'help', '--help', '-h', '--version', '-V',
]);

function findFirstSubcommand(rawArgs: string[]): string | null {
  for (const a of rawArgs) {
    if (FORGEN_SUBCOMMANDS.has(a)) return a;
    // 첫 비-플래그 인자를 보면 더 이상 후보 X (e.g. ['my-prompt', 'status'] → null)
    if (!a.startsWith('-')) return null;
  }
  return null;
}

async function routeToCli(): Promise<void> {
  // cli.js 가 process.argv.slice(2) 를 직접 사용. fgx 가 받은 args 그대로 전달됨.
  // top-level main() 이 모듈 로드 시 실행 + process.exit 처리.
  await import('./cli.js');
}

async function runClaudeLauncher(): Promise<void> {
  const launchContext = resolveLaunchContext(args);
  const runtime = launchContext.runtime;
  const skipFlag = getHostRuntime(runtime).dangerousSkipFlag;
  const launchArgs = [...launchContext.args];
  if (!launchArgs.includes(skipFlag)) {
    launchArgs.unshift(skipFlag);
  }

  // Security warning — fgx bypasses all Claude Code permission checks.
  //
  // Audit fix #3 (2026-04-21): The warning banner is shown regardless of
  // the user's profile trust policy, which means "가드레일 우선" users who
  // alias `fgx` unknowingly run with zero guardrails. Users who rely on
  // the profile trust policy should NOT use `fgx`. Surface the mismatch
  // loudly (harness.ts also prints the Trust 상승 warning downstream).
  console.warn(`\n  ⚠  fgx: ALL permission checks are disabled (${skipFlag})`);
  console.warn(`  ⚠  ${getHostRuntime(runtime).displayName} will execute tools without asking for confirmation.`);
  console.warn('  ⚠  Use only in trusted environments. If your profile trust policy is');
  console.warn('  ⚠  "가드레일 우선" or "승인 완화", consider `forgen` (no flag) instead.\n');

  const firstRun = isFirstRun();
  if (firstRun) {
    console.log('\n  Forgen — Setting up for the first time.\n');
    console.log('  Creating ~/.forgen/ directory and default philosophy.');
    console.log('  Run `forgen onboarding` afterwards to complete personalization.\n');
  }

  const context = await prepareHarness(process.cwd(), { runtime });

  if (firstRun) {
    console.log('  [Done] Initial setup complete.\n');
  }

  const v1 = context.v1;
  console.log(`[forgen] Profile: ${v1.session ? `${v1.session.quality_pack}/${v1.session.autonomy_pack}` : 'onboarding needed'}`);
  if (v1.session) {
    console.log(`[forgen] Trust: ${v1.session.effective_trust_policy}`);
  }
  console.log(`[forgen] Mode: ${skipFlag.replace(/^--/, '')}`);
  const runtimeLabel = getHostRuntime(runtime).displayName;
  console.log(`[forgen] Starting ${runtimeLabel}...\n`);

  await spawnClaude(launchArgs, context, runtime);
}

async function main() {
  const sub = findFirstSubcommand(args);
  if (sub !== null) {
    await routeToCli();
    return;
  }
  await runClaudeLauncher();
}

main().catch((err) => {
  console.error('[forgen] Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
