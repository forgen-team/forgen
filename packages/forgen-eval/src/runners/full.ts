/**
 * Full runner — N=300 cases × 3 turn-depths × 5 arms × Triple judge.
 * 릴리즈 전 manual trigger. ~$540/run + GPU.
 */

import { runTestbed } from './orchestrator.js';
import { loadTestCases, loadDatasetVersion } from '../datasets/loader.js';

const DATASET_DIR = process.env.FORGEN_EVAL_DATA_DIR ?? './forgen-eval-data';

async function main() {
  const version = loadDatasetVersion(DATASET_DIR);
  const cases = loadTestCases({ rootDir: DATASET_DIR, limit: 300, realRetroMinRatio: 0.3 });
  if (cases.length < 300) {
    throw new Error(`Full run requires N=300, dataset has ${cases.length}`);
  }
  // Power analysis announce (ADR-006)
  console.log(`Full run: N=${cases.length}, Bonferroni α=0.005 (10 paired comparisons)`);
  console.log('Detection threshold: d≥0.8 with power 0.80, effective N≈22 sufficient.');

  const report = await runTestbed({
    track: 'DEV',
    tier: 'full',
    cases,
    outDir: './reports/full',
    datasetVersion: version.commit,
    turnDepths: [1, 5, 10], // N=1 anchor only (excluded from γ-slope per ADR-006)
  });
  console.log(`Full run ${report.runId}: ${report.passFail.passed ? 'PASS' : 'FAIL'}`);
  if (!report.passFail.passed) {
    console.error(`Hard fail reason: ${report.passFail.hardFailReason ?? 'metric_below_threshold'}`);
  }
  process.exit(report.passFail.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}

export { main as runFull };
