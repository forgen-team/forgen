/**
 * Smoke runner — N=10 cases, dual local judges only, ~$0 marginal cost.
 * PR마다 실행 가능하도록 빠름 (~10분 목표).
 */

import { runTestbed } from './orchestrator.js';
import { loadTestCases, loadDatasetVersion } from '../datasets/loader.js';

const DATASET_DIR = process.env.FORGEN_EVAL_DATA_DIR ?? './forgen-eval-data';

async function main() {
  const version = loadDatasetVersion(DATASET_DIR);
  const cases = loadTestCases({ rootDir: DATASET_DIR, limit: 10 });
  const report = await runTestbed({
    track: 'PUBLIC',
    tier: 'smoke',
    cases,
    outDir: './reports/smoke',
    datasetVersion: version.commit,
    turnDepths: [5],
  });
  console.log(`Smoke run ${report.runId}: ${report.passFail.passed ? 'PASS' : 'FAIL'}`);
  process.exit(report.passFail.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}

export { main as runSmoke };
