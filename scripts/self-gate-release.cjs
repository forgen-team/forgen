#!/usr/bin/env node
/**
 * scripts/self-gate-release.cjs — ADR-003 릴리즈 아티팩트 일관성.
 *
 * 릴리즈 태그 (refs/tags/v*) 빌드에서만 실행. 그 외 이벤트에서는 no-op exit 0.
 *
 * 검사 항목:
 *   1. package.json.version == git tag (`v` prefix 제거 비교)
 *   2. CHANGELOG.md 에 해당 버전 섹션 존재
 *   3. dist/ 가 src/ 대비 stale 아님 (dist/ 최신 mtime >= src/ 최신 mtime)
 *   4. .forgen-release/e2e-report.json 존재 + passed=true + mock_detected=false
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const failures = [];
function fail(check, detail) { failures.push({ check, detail }); }

function readPkgVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    return String(pkg.version);
  } catch {
    return null;
  }
}

function gitTag() {
  // Explicit env (CI): GITHUB_REF=refs/tags/v1.2.3
  const ref = process.env.GITHUB_REF ?? '';
  const m = ref.match(/^refs\/tags\/(v.+)$/);
  if (m) return m[1];
  // Fallback: `git describe --tags --exact-match HEAD`
  try {
    return execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function isReleaseBuild(tag) {
  return typeof tag === 'string' && /^v\d+\.\d+\.\d+/.test(tag);
}

// ── 1) version/tag match ────────────────────────────────────────────────
function checkVersionTagMatch(version, tag) {
  const tagNoPrefix = tag.replace(/^v/, '');
  if (version !== tagNoPrefix) {
    fail('version-tag-mismatch', `package.json version=${version} does not match tag=${tag}`);
  }
}

// ── 2) CHANGELOG section ────────────────────────────────────────────────
function checkChangelog(version) {
  const changelogPath = path.join(REPO_ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    fail('changelog-missing', `CHANGELOG.md not found at ${changelogPath}`);
    return;
  }
  const content = fs.readFileSync(changelogPath, 'utf-8');
  // ## [1.2.3] or ## 1.2.3 or ## v1.2.3 형태 허용
  const sectionRe = new RegExp(`^##\\s*\\[?v?${version.replace(/\./g, '\\.')}\\]?`, 'm');
  if (!sectionRe.test(content)) {
    fail('changelog-section-missing', `no section for version ${version} in CHANGELOG.md`);
  }
}

// ── 3) dist freshness ───────────────────────────────────────────────────
function latestMtime(dir) {
  let max = 0;
  if (!fs.existsSync(dir)) return max;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const name of fs.readdirSync(cur, { withFileTypes: true })) {
      if (name.name === 'node_modules') continue;
      const p = path.join(cur, name.name);
      try {
        const st = fs.statSync(p);
        if (name.isDirectory()) stack.push(p);
        else if (st.mtimeMs > max) max = st.mtimeMs;
      } catch { /* skip */ }
    }
  }
  return max;
}

function checkDistFreshness() {
  const srcMtime = latestMtime(path.join(REPO_ROOT, 'src'));
  const distMtime = latestMtime(path.join(REPO_ROOT, 'dist'));
  if (distMtime === 0) {
    fail('dist-missing', 'dist/ directory is empty — run npm run build');
    return;
  }
  // 허용 슬랙 5s — checkout + build 사이 미세 지연.
  if (distMtime + 5000 < srcMtime) {
    fail('dist-stale', `dist mtime (${new Date(distMtime).toISOString()}) older than src mtime (${new Date(srcMtime).toISOString()})`);
  }
}

// ── 4) e2e report ──────────────────────────────────────────────────────
function checkE2EReport() {
  const reportPath = path.join(REPO_ROOT, '.forgen-release', 'e2e-report.json');
  if (!fs.existsSync(reportPath)) {
    fail('e2e-report-missing', `.forgen-release/e2e-report.json not found`);
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    if (data.passed !== true) fail('e2e-failed', `e2e-report.passed=${data.passed}`);
    if (data.mock_detected === true) fail('e2e-mock-detected', `e2e-report.mock_detected=true`);
  } catch (e) {
    fail('e2e-report-parse', `${String(e)}`);
  }
}

function main() {
  const tag = gitTag();
  if (!isReleaseBuild(tag)) {
    console.log('  [self-gate-release] skip — not a release build (no git tag matching v*.*.*)');
    process.exit(0);
  }
  const version = readPkgVersion();
  if (!version) {
    console.error('  [self-gate-release] ✗ cannot read package.json version');
    process.exit(1);
  }

  checkVersionTagMatch(version, tag);
  checkChangelog(version);
  checkDistFreshness();
  checkE2EReport();

  if (failures.length === 0) {
    console.log(`  [self-gate-release] ✓ release artifact consistency OK (${tag} / ${version})`);
    process.exit(0);
  }
  console.error(`\n  [self-gate-release] ✗ ${failures.length} failure(s) for tag ${tag}:\n`);
  for (const f of failures) {
    console.error(`    [${f.check}] ${f.detail}`);
  }
  process.exit(1);
}

main();
