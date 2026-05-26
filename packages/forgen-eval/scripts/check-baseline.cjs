#!/usr/bin/env node
/**
 * Sanity eval — baseline regression check.
 *
 * Validates that existing psi-stat reports are intact and metrics are
 * within historical bounds. No API keys required — reads JSON reports only.
 *
 * Exit 0 = pass, Exit 1 = regression detected.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPORTS_DIR = path.join(__dirname, '..', 'reports', 'psi-stat');
const MIN_REPORT_COUNT = 5;
const MAX_PSI_MEAN_ABS = 0.3; // ψ ≈ 0 expected — anything beyond ±0.3 is suspicious

function main() {
  console.log('[sanity-eval] Baseline regression check\n');

  // 1. Check report directory exists
  if (!fs.existsSync(REPORTS_DIR)) {
    console.error(`FAIL: Reports directory missing: ${REPORTS_DIR}`);
    process.exit(1);
  }

  // 2. Load all judged reports
  const files = fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('psi-stat-judged-') && f.endsWith('.json'))
    .sort();

  if (files.length < MIN_REPORT_COUNT) {
    console.error(`FAIL: Only ${files.length} reports found (minimum ${MIN_REPORT_COUNT}). Reports may have been accidentally deleted.`);
    process.exit(1);
  }

  console.log(`  Reports found: ${files.length} (minimum ${MIN_REPORT_COUNT})`);

  // 3. Parse each report and validate structure
  const means = [];
  let parseErrors = 0;

  for (const file of files) {
    const filePath = path.join(REPORTS_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (typeof data.mean !== 'number' || typeof data.N !== 'number') {
        console.error(`  WARN: ${file} — missing mean or N field`);
        parseErrors++;
        continue;
      }
      means.push(data.mean);
    } catch (e) {
      console.error(`  WARN: ${file} — parse error: ${e.message}`);
      parseErrors++;
    }
  }

  if (parseErrors > files.length * 0.5) {
    console.error(`FAIL: >50% of reports have parse errors (${parseErrors}/${files.length})`);
    process.exit(1);
  }

  // 4. Validate ψ mean is within expected bounds
  // ψ measures forgen+mem synergy over max(forgen-only, mem-only)
  // Expected: ≈ 0 (forgen alone is the recommended path)
  const historicalMean = means.reduce((a, b) => a + b, 0) / means.length;
  const latestMean = means[means.length - 1];

  console.log(`  Historical ψ mean: ${historicalMean.toFixed(4)}`);
  console.log(`  Latest ψ mean:     ${latestMean.toFixed(4)}`);

  if (Math.abs(latestMean) > MAX_PSI_MEAN_ABS) {
    console.error(`FAIL: Latest ψ mean (${latestMean.toFixed(4)}) exceeds ±${MAX_PSI_MEAN_ABS} bound — unexpected metric shift.`);
    process.exit(1);
  }

  // 5. Check latest report has reasonable sample size
  const latestFile = files[files.length - 1];
  const latestData = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, latestFile), 'utf-8'));
  if (latestData.N < 3) {
    console.error(`FAIL: Latest report N=${latestData.N} — too small for meaningful CI.`);
    process.exit(1);
  }

  console.log(`  Latest N:          ${latestData.N}`);
  console.log(`\n  All checks passed.`);
  process.exit(0);
}

main();
