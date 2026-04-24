/**
 * forgen init — v1 프로젝트 초기화
 *
 * 온보딩 기반 프로필 생성 + v1 디렉토리 구조 초기화.
 * philosophy/pack 시스템은 v1에서 제거됨.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { profileExists } from '../store/profile-store.js';
import { ensureV1Directories } from './v1-bootstrap.js';
import { initializeForgenHome } from './init-cli.js';

// ── CLI 핸들러 ──

export async function handleInit(_args: string[]): Promise<void> {
  const cwd = process.cwd();
  const projectName = path.basename(cwd);

  console.log(`\n  Forgen Init — ${projectName}\n`);

  // v1 디렉토리 생성
  ensureV1Directories();

  // 프로젝트 .claude/rules 디렉토리 생성
  const rulesDir = path.join(cwd, '.claude', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });

  // v0.4.1 (2026-04-24): starter-pack 프로비저닝 — 격리 홈 / 신규 FORGEN_HOME
  // 에서 "신규 사용자 첫날 가치" 가 0이 되는 결함 해소. npm install-g 시의
  // postinstall 이 하던 starter 배포를 런타임에서도 보장.
  // 보수적: me/solutions 에 ≥5개면 skip — 기존 사용자 실 축적물 보호.
  try {
    const r = initializeForgenHome();
    if (r.solutionsInstalled > 0) {
      console.log(`  ✓ Starter-pack: ${r.solutionsInstalled} solutions installed.`);
    } else if (r.skipped && r.solutionsSkippedExisting > 0) {
      console.log(`  • Starter-pack: skipped (${r.solutionsSkippedExisting} existing solutions).`);
    }
  } catch (e) {
    console.log(`  ⚠ Starter-pack install 실패: ${(e as Error).message}`);
  }

  // 프로필 존재 확인
  if (profileExists()) {
    console.log('  Profile already exists. Your personalization is active.');
    console.log('  Run `forgen inspect profile` to view your current settings.');
    console.log('  Run `forgen forge --reset` to re-onboard.\n');
    return;
  }

  console.log('  No profile found. Starting onboarding...\n');

  // 온보딩 실행
  const { runOnboarding } = await import('../forge/onboarding-cli.js');
  await runOnboarding();

  console.log('  Init complete!');
  console.log('  Next steps:');
  console.log('    forgen                     Start Claude Code with personalization');
  console.log('    forgen inspect profile     View your profile');
  console.log('    forgen doctor              Check system health\n');
}
