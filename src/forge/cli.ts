/**
 * Forgen Forge — v1 CLI Handler
 *
 * forgen forge                  v1 onboarding (첫 실행) 또는 profile 요약
 * forgen forge --profile        현재 v1 profile 표시
 * forgen forge --export         Profile JSON 출력
 * forgen forge --reset soft     Soft reset
 * forgen forge --reset learning Learning reset
 * forgen forge --reset full     Full reset
 */

import { loadProfile, profileExists } from '../store/profile-store.js';
import { renderProfile } from '../renderer/inspect-renderer.js';
import { runOnboarding } from './onboarding-cli.js';

const KNOWN_FLAGS = new Set(['--onboarding', '--profile', '--export', '--reset', '--yes', '-y']);
const RESET_LEVELS = new Set(['soft', 'learning', 'full']);

function fail(message: string): void {
  console.error(`[forgen] ${message}`);
  process.exitCode = 1;
}

/** 온보딩은 대화형 입력이 필요하다. 파이프·CI 에서는 조용히 끝내지 말고 이유를 말한다. */
function requireTty(what: string): boolean {
  if (process.stdin.isTTY) return true;
  fail(`${what} 은 대화형 터미널(TTY)에서만 실행할 수 있습니다. stdin 이 파이프/리다이렉트라 질문을 받을 수 없습니다. 터미널에서 직접 \`forgen forge --onboarding\` 을 실행하세요.`);
  return false;
}

export async function handleForge(args: string[]): Promise<void> {
  const unknown = args.filter((a) => a.startsWith('-') && !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    fail(`알 수 없는 옵션: ${unknown.join(' ')}\n  사용법: forgen forge [--onboarding|--profile|--export|--reset [soft|learning|full] [--yes]]`);
    return;
  }
  // W1-4 (feature-audit 2026-07-21): forge 를 개인화 단일 관문으로.
  // --onboarding 은 프로필 유무와 무관하게 4질문 온보딩을 재실행 (구 `forgen onboarding`).
  if (args.includes('--onboarding')) {
    if (!requireTty('온보딩')) return;
    await runOnboarding();
    return;
  }

  if (args.includes('--profile')) {
    handleShowProfile();
    return;
  }

  if (args.includes('--export')) {
    handleExport();
    return;
  }

  if (args.includes('--reset')) {
    const next = args[args.indexOf('--reset') + 1];
    const level = next && !next.startsWith('-') ? next : 'soft';
    await handleReset(level, args.includes('--yes') || args.includes('-y'));
    return;
  }

  // Default: profile이 있으면 보여주고, 없으면 onboarding
  if (profileExists()) {
    handleShowProfile();
  } else if (requireTty('온보딩')) {
    await runOnboarding();
  }
}

function handleShowProfile(): void {
  const profile = loadProfile();
  if (!profile) {
    console.log('\n  No v1 profile found. Run `forgen forge` (or `forgen forge --onboarding` to re-run).\n');
    return;
  }
  console.log(`\n${renderProfile(profile)}\n`);
}

function handleExport(): void {
  const profile = loadProfile();
  if (!profile) {
    console.log('{}');
    return;
  }
  console.log(JSON.stringify(profile, null, 2));
}

const RESET_SCOPE: Record<string, string> = {
  soft: '프로필 + 룰 + 추천 + 세션 상태',
  learning: '프로필 + 룰 + 교정/행동 기록(behavior) + 추천 + 세션 상태 + 원본 로그',
  full: '프로필 + 룰 + 교정/행동 기록 + 추천 + 세션 상태 + 원본 로그 + 솔루션(compound 전체)',
};

async function confirmReset(level: string, yes: boolean): Promise<boolean> {
  console.log(`\n  forge --reset ${level} 은 되돌릴 수 없는 삭제입니다: ${RESET_SCOPE[level]}`);
  if (yes) return true;
  if (!process.stdin.isTTY) {
    fail('확인할 수 없어 중단했습니다 (비대화형). 진행하려면 --yes 를 붙이세요. 백업: forgen rule snapshot');
    return false;
  }
  const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((resolve) => rl.question(`  계속하려면 "${level}" 를 입력하세요: `, resolve));
  rl.close();
  if (answer.trim() !== level) {
    console.log('  취소했습니다. 아무것도 삭제하지 않았습니다.\n');
    return false;
  }
  return true;
}

async function handleReset(level: string, yes: boolean): Promise<void> {
  if (!RESET_LEVELS.has(level)) {
    fail(`Invalid reset level: ${level}. Valid levels: soft, learning, full`);
    return;
  }
  if (!(await confirmReset(level, yes))) return;

  // 동적 import로 store 모듈 로드
  const fs = await import('node:fs');
  const { FORGE_PROFILE, ME_RULES, ME_BEHAVIOR, V1_RECOMMENDATIONS_DIR, V1_SESSIONS_DIR, V1_RAW_LOGS_DIR, ME_SOLUTIONS } = await import('../core/paths.js');

  const deleteDirs = (dirs: string[]) => {
    for (const dir of dirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
      } catch { /* ignore */ }
    }
  };

  const deleteFile = (p: string) => {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  };

  if (level === 'soft') {
    deleteFile(FORGE_PROFILE);
    deleteDirs([ME_RULES, V1_RECOMMENDATIONS_DIR, V1_SESSIONS_DIR]);
    console.log('\n  Soft reset 완료. Profile + Rule + Recommendation + Session 초기화.');
  } else if (level === 'learning') {
    deleteFile(FORGE_PROFILE);
    deleteDirs([ME_RULES, ME_BEHAVIOR, V1_RECOMMENDATIONS_DIR, V1_SESSIONS_DIR, V1_RAW_LOGS_DIR]);
    console.log('\n  Learning reset 완료. 개인 학습 전체 초기화.');
  } else if (level === 'full') {
    deleteFile(FORGE_PROFILE);
    deleteDirs([ME_RULES, ME_BEHAVIOR, V1_RECOMMENDATIONS_DIR, V1_SESSIONS_DIR, V1_RAW_LOGS_DIR, ME_SOLUTIONS]);
    console.log('\n  Full reset 완료. Compound 포함 전체 초기화.');
  }

  // Reset 후 자동 온보딩 (interactive 환경에서만)
  if (process.stdin.isTTY) {
    console.log('  새 프로필을 생성합니다.\n');
    await runOnboarding();
  } else {
    console.log('  forgen forge (또는 forgen forge --onboarding) 으로 새 프로필을 생성하세요.\n');
  }
}
