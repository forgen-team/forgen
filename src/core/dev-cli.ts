/**
 * forgen dev — 개발/유지보수 명령 네임스페이스 (Wave 1 W1-3, feature-audit 2026-07-21).
 *
 * probe-workflow / parity / migrate / regress-map 은 개발·CI·스키마 유지보수용으로,
 * 일반 사용자 표면(top-level)을 어지럽혔다. `forgen dev <sub>` 하나로 모아 사용자
 * 명령 표면을 정리한다. 각 핸들러는 기존 것을 재사용.
 *
 *   forgen dev probe-workflow arm|report|status   ADR-009 §1 훅 발화 측정
 *   forgen dev parity codex [--dry-run]            host parity (source 체크아웃 전용)
 *   forgen dev migrate [implicit-feedback|...]     one-shot 스키마 마이그레이션
 *   forgen dev regress-map [--days N --top N]      최근 fix 집중 파일
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

function printDevHelp(): void {
  console.log(`
  forgen dev — developer / maintenance utilities

    forgen dev probe-workflow arm|report|status   Measure hook firing in dynamic-workflow subagents (ADR-009 §1)
    forgen dev parity codex [--dry-run]            Host parity checks (source checkout only)
    forgen dev migrate [target]                    One-shot schema migration
    forgen dev regress-map [--days N --top N]      Top fix-touched files
`);
}

async function runParity(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== 'codex') {
    console.log('Usage:\n  forgen dev parity codex [--dry-run]\n\nNotes:\n  - source 체크아웃에서만 작동합니다 (tests/ 디렉토리 필요).\n  - npm install 로 설치된 패키지에서는 run-parity.sh 가 없습니다.');
    return;
  }
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/core
  const scriptPath = path.resolve(here, '..', '..', 'tests', 'e2e', 'codex', 'run-parity.sh');
  if (!fs.existsSync(scriptPath)) {
    console.error('[forgen] run-parity.sh 는 source 체크아웃에서만 작동. 직접 git clone 후 실행하세요.');
    console.error(`  expected: ${scriptPath}`);
    process.exit(1);
  }
  const { spawnSync } = await import('node:child_process');
  const dryRun = args.includes('--dry-run');
  const result = spawnSync('bash', [scriptPath, ...(dryRun ? ['--dry-run'] : [])], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export async function handleDev(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'probe-workflow': {
      const { handleProbeWorkflow } = await import('./probe-workflow-cli.js');
      await handleProbeWorkflow(rest);
      return;
    }
    case 'parity':
      await runParity(rest);
      return;
    case 'migrate': {
      const { handleMigrate } = await import('./migrate-cli.js');
      await handleMigrate(rest);
      return;
    }
    case 'regress-map': {
      const { handleRegressMap } = await import('./regress-map-cli.js');
      await handleRegressMap(rest);
      return;
    }
    default:
      printDevHelp();
  }
}
