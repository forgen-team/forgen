/**
 * Forgen v0.4.1 — `forgen init` CLI
 *
 * 빈 FORGEN_HOME (또는 기존에 starter 미설치 홈) 에 starter-pack 솔루션을
 * 프로비저닝. npm install-g 시의 postinstall 이 하던 starter 배포 로직을 런타임
 * CLI 로 노출해 다음 시나리오 지원:
 *   - `FORGEN_HOME=/tmp/fresh forgen init` — 격리 테스트 환경
 *   - CI pipeline 신규 컨테이너 프로비저닝
 *   - 사용자가 실수로 me/solutions 전부 삭제한 뒤 복구
 *
 * 보수적 정책: me/solutions 에 **≥5개 파일**이 이미 있으면 건너뜀 (사용자
 * 실 축적물 보호). `--force` 플래그로 우회 가능. postinstall 의 installStarterPack
 * 과 동일 규칙.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ME_DIR } from './paths.js';

/** 패키지 루트의 starter-pack/solutions 디렉터리. */
function findStarterDir(): string | null {
  // 런타임에 dist/core/init-cli.js — 패키지 루트는 상위 2단계
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = path.resolve(distDir, '..', '..');
  const starterDir = path.join(pkgRoot, 'starter-pack', 'solutions');
  return fs.existsSync(starterDir) ? starterDir : null;
}

export interface InitResult {
  solutionsInstalled: number;
  solutionsSkippedExisting: number;
  solutionsDir: string;
  starterDir: string | null;
  skipped: boolean;
  skipReason?: string;
}

export function initializeForgenHome(options: { force?: boolean } = {}): InitResult {
  const solutionsDir = path.join(ME_DIR, 'solutions');
  const starterDir = findStarterDir();

  if (!starterDir) {
    return {
      solutionsInstalled: 0,
      solutionsSkippedExisting: 0,
      solutionsDir,
      starterDir: null,
      skipped: true,
      skipReason: 'starter-pack directory not found in package',
    };
  }

  let existing = 0;
  if (fs.existsSync(solutionsDir)) {
    existing = fs.readdirSync(solutionsDir).filter((f) => f.endsWith('.md')).length;
  }

  if (existing >= 5 && !options.force) {
    return {
      solutionsInstalled: 0,
      solutionsSkippedExisting: existing,
      solutionsDir,
      starterDir,
      skipped: true,
      skipReason: `${existing} existing solutions (≥5) — use --force to overwrite`,
    };
  }

  fs.mkdirSync(solutionsDir, { recursive: true });
  const starterFiles = fs.readdirSync(starterDir).filter((f) => f.endsWith('.md'));

  let installed = 0;
  for (const file of starterFiles) {
    const dest = path.join(solutionsDir, file);
    if (!fs.existsSync(dest) || options.force) {
      fs.cpSync(path.join(starterDir, file), dest);
      installed++;
    }
  }

  return {
    solutionsInstalled: installed,
    solutionsSkippedExisting: existing,
    solutionsDir,
    starterDir,
    skipped: false,
  };
}

export async function handleInit(args: string[]): Promise<void> {
  const force = args.includes('--force');
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  forgen init — starter-pack 프로비저닝 (기존 솔루션 보호)

  Usage:
    forgen init            Install starter-pack if solutions/ has < 5 files
    forgen init --force    Overwrite any existing starter files (idempotent)
    FORGEN_HOME=... forgen init    새 홈에 격리 초기화

  Starter pack = starter-* 로 시작하는 범용 개발 패턴 솔루션. 신규 사용자가
  "compound recall" 효과를 첫날부터 체감할 수 있도록 설치 시 기본 제공되지만,
  npm install-g 을 거치지 않은 격리/컨테이너 환경은 이 CLI 로 수동 배포.
`);
    return;
  }

  const result = initializeForgenHome({ force });

  console.log('');
  console.log('  forgen init');
  console.log('  ──────────');
  console.log(`  FORGEN_HOME           ${path.dirname(result.solutionsDir)}`);
  console.log(`  starter-pack source   ${result.starterDir ?? 'NOT FOUND'}`);
  console.log(`  existing solutions    ${result.solutionsSkippedExisting}`);
  console.log(`  newly installed       ${result.solutionsInstalled}`);
  if (result.skipped) {
    console.log(`  status                skipped — ${result.skipReason}`);
  } else {
    console.log(`  status                ✓ initialized`);
  }
  console.log('');
}
