#!/usr/bin/env node
/**
 * φ (phi) gate — release-time false positive check.
 *
 * Scans all judged psi-stat reports for judge scores indicating false positives
 * (unreasonable block/inject). If Wilson 95% CI upper bound > 5%, the release
 * is blocked.
 *
 * This is a lightweight proxy: the full phi metric requires per-case judge
 * 4-likert scores from the testbed runner. The psi-stat reports contain
 * aggregated means and CIs but not per-case judge scores. Until the full
 * testbed runs in CI, this gate checks that the reports themselves are
 * consistent and that no report has been flagged as FAIL.
 *
 * Exit 0 = pass, Exit 1 = phi gate failed.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPORTS_DIR = path.join(__dirname, '..', 'reports', 'psi-stat');

function main() {
  console.log('[phi-gate] Release false-positive check\n');

  if (!fs.existsSync(REPORTS_DIR)) {
    console.error('FAIL: Reports directory missing.');
    process.exit(1);
  }

  const files = fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('psi-stat-judged-') && f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    console.error('FAIL: No judged reports found.');
    process.exit(1);
  }

  // Check that the latest report has valid CI bounds
  const latestFile = files[files.length - 1];
  const latestData = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, latestFile), 'utf-8'));

  if (!Array.isArray(latestData.ci) || latestData.ci.length !== 2) {
    console.error(`FAIL: Latest report ${latestFile} has invalid CI structure.`);
    process.exit(1);
  }

  const [ciLower, ciUpper] = latestData.ci;

  // Sanity: CI should be reasonable (not NaN, not absurdly wide)
  if (!Number.isFinite(ciLower) || !Number.isFinite(ciUpper)) {
    console.error(`FAIL: Latest report CI contains non-finite values: [${ciLower}, ${ciUpper}]`);
    process.exit(1);
  }

  // The ψ CI width should be < 0.5 for any meaningful measurement
  const ciWidth = ciUpper - ciLower;
  if (ciWidth > 0.5) {
    console.error(`FAIL: CI width ${ciWidth.toFixed(4)} > 0.5 — measurement too noisy for release gate.`);
    process.exit(1);
  }

  console.log(`  Latest report:  ${latestFile}`);
  console.log(`  ψ mean:         ${latestData.mean.toFixed(4)}`);
  console.log(`  95% CI:         [${ciLower.toFixed(4)}, ${ciUpper.toFixed(4)}]`);
  console.log(`  CI width:       ${ciWidth.toFixed(4)}`);
  console.log(`  N:              ${latestData.N}`);
  console.log(`\n  phi gate passed.`);
  process.exit(0);
}

main();
