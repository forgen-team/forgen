#!/usr/bin/env node

/**
 * fgx — forgen --dangerously-skip-permissions 의 단축 명령
 * 모든 인자를 그대로 전달하되, --dangerously-skip-permissions 를 자동 주입
 */

import { resolveLaunchContext } from './services/session.js';
import { prepareHarness, isFirstRun } from './core/harness.js';
import { spawnClaude } from './core/spawn.js';

const args = process.argv.slice(2);

// 이미 포함되어 있으면 중복 추가하지 않음
const launchContext = resolveLaunchContext(args);
const runtime = launchContext.runtime;
const launchArgs = [...launchContext.args];
if (!launchArgs.includes('--dangerously-skip-permissions')) {
  launchArgs.unshift('--dangerously-skip-permissions');
}

async function main() {
  // Security warning — fgx bypasses all Claude Code permission checks
  console.warn('\n  ⚠  fgx: ALL permission checks are disabled (--dangerously-skip-permissions)');
  console.warn('  ⚠  Claude Code will execute tools without asking for confirmation.');
  console.warn('  ⚠  Use only in trusted environments.\n');

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
  console.log('[forgen] Mode: dangerously-skip-permissions');
  const runtimeLabel = runtime === 'codex' ? 'Codex' : 'Claude';
  console.log(`[forgen] Starting ${runtimeLabel}...\n`);

  await spawnClaude(launchArgs, context, runtime);
}

main().catch((err) => {
  console.error('[forgen] Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
