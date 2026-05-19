/**
 * Forgen — Compound Retire (P3)
 *
 * `forgen compound retire [--dry-run] [--apply]`
 *
 * dead 분류 솔루션을 ~/ .forgen/lab/archived/<id>.md 로 이동.
 * 기본은 dry-run (목록만 출력). --apply 시 사용자 확인 후 이동.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { ME_SOLUTIONS, ARCHIVED_DIR } from '../core/paths.js';
import { classifySolutions } from '../core/lifecycle-classifier.js';

export interface RetireResult {
  retired: string[];
  skipped: string[];
  dryRun: boolean;
}

function promptConfirm(question: string): Promise<boolean> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

/** dead 솔루션을 lab/archived/ 로 이동 */
export async function retireDeadSolutions(opts: { dryRun: boolean; yes?: boolean }): Promise<RetireResult> {
  const classified = classifySolutions();
  const dead = classified.filter(c => c.lifecycle === 'dead');
  const retired: string[] = [];
  const skipped: string[] = [];

  if (dead.length === 0) {
    return { retired: [], skipped: [], dryRun: opts.dryRun };
  }

  // dry-run or apply 출력
  console.log(`\n  Dead solutions (${dead.length}):\n`);
  for (const d of dead) {
    const dest = path.join(ARCHIVED_DIR, `${d.solutionId}.md`);
    console.log(`    ${d.solutionId}`);
    console.log(`      matched_180d=${d.matched_180d}  age=${d.ageDays}d`);
    console.log(`      → ${dest}`);
  }
  console.log();

  if (opts.dryRun) {
    console.log('  [dry-run] 파일 이동 없음. --apply 로 실행하세요.\n');
    return { retired: dead.map(d => d.solutionId), skipped: [], dryRun: true };
  }

  // apply — 확인 프롬프트
  if (!opts.yes) {
    const ok = await promptConfirm(`  ${dead.length}개 솔루션을 archived 로 이동합니다. 계속하시겠습니까? (y/N) `);
    if (!ok) {
      console.log('  취소되었습니다.\n');
      return { retired: [], skipped: dead.map(d => d.solutionId), dryRun: false };
    }
  }

  // mkdir + rename (fail-stop: 오류 시 즉시 throw)
  fs.mkdirSync(ARCHIVED_DIR, { recursive: true });

  for (const d of dead) {
    const src = path.join(ME_SOLUTIONS, `${d.solutionId}.md`);
    const dest = path.join(ARCHIVED_DIR, `${d.solutionId}.md`);

    // 이미 archived 인 경우 skip
    if (fs.existsSync(dest)) {
      skipped.push(d.solutionId);
      continue;
    }

    // src 없으면 skip
    if (!fs.existsSync(src)) {
      skipped.push(d.solutionId);
      continue;
    }

    // fail-stop: rename 실패 시 throw (데이터 이동 정확성 우선)
    fs.renameSync(src, dest);
    retired.push(d.solutionId);
  }

  console.log(`  ✓ ${retired.length}개 이동 완료`);
  if (skipped.length > 0) {
    console.log(`  ○ ${skipped.length}개 skip (이미 archived 또는 파일 없음)`);
  }
  console.log();

  return { retired, skipped, dryRun: false };
}

/** CLI 핸들러: forgen compound retire */
export async function handleCompoundRetire(args: string[]): Promise<void> {
  const apply = args.includes('--apply');
  const yes = args.includes('--yes');
  const dryRun = !apply;

  await retireDeadSolutions({ dryRun, yes });
}
