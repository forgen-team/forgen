#!/usr/bin/env node

/**
 * fgx — forgen --dangerously-skip-permissions 의 단축 명령
 * 모든 인자를 그대로 전달하되, --dangerously-skip-permissions 를 자동 주입
 */

import { resolveLaunchContext } from './services/session.js';
import { prepareHarness, isFirstRun } from './core/harness.js';
import { spawnClaude } from './core/spawn.js';
import { getHostRuntime } from './host/host-runtime.js';

const args = process.argv.slice(2);

// 이미 포함되어 있으면 중복 추가하지 않음
const launchContext = resolveLaunchContext(args);
const runtime = launchContext.runtime;
const skipFlag = getHostRuntime(runtime).dangerousSkipFlag;
const launchArgs = [...launchContext.args];
if (!launchArgs.includes(skipFlag)) {
  launchArgs.unshift(skipFlag);
}

async function main() {
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

  // fgx는 서브커맨드 없이 바로 Claude Code 실행 전용
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

main().catch((err) => {
  console.error('[forgen] Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
