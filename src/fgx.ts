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
    // cli.js 위임 경로는 건드리지 않는다. watch/dashboard/workflows 등 long-running
    // 서브커맨드가 여기서 강제 종료되면 잘린다. cli.js 가 자체 process.exit 를 책임진다.
    await routeToCli();
    return;
  }

  await runClaudeLauncher();

  // 대화형 세션 종료 후 fgx 프로세스 종료를 명시적으로 보장한다.
  //
  // WHY: spawnClaude 는 세션 종료 시 auto-compound-runner 를 detached + unref 로 띄우고
  // 즉시 resolve 한다(설계상 비차단). 그런데 fgx 는 성공 경로에서 process.exit 를 호출하지
  // 않고 Node 이벤트 루프 자연 배수에 의존해 왔다. 지금은 미해제 핸들이 없어 정상 종료하지만,
  // 향후 post-session 경로에 닫히지 않은 핸들(SQLite 커넥션, 타이머, 소켓 등)이 하나라도
  // 생기면 fgx 가 종료하지 못하고 셸 프롬프트가 돌아오지 않는다(= 터미널 물림). 명시 종료로
  // 이 종류의 회귀를 원천 차단한다. detached 자식은 unref 되어 독립 실행되므로 백그라운드
  // compound 는 영향받지 않고 계속된다.
  process.exit(0);
}

main().catch((err) => {
  console.error('[forgen] Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
