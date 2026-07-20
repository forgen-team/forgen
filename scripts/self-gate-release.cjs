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
 *   4. .forgen-release/smoke-report.json 존재 + passed=true + mock_detected=false
 *      + vitest check 포함·통과 (ADR-010 W0-2: Docker e2e-report 게이트 폐지,
 *      evidence a723507f — 증거 수단 적정화, 실제 실행 산출물 원칙은 유지)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// FORGEN_GATE_ROOT: fixture 테스트용 오버라이드 (tests/release-gate-smoke.test.ts)
const REPO_ROOT = process.env.FORGEN_GATE_ROOT || path.resolve(__dirname, '..');
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

// ── 4) smoke report (v0.5.0+, 구 e2e-report 대체) ───────────────────────
// NOTE: self-gate.cjs checkReleaseArtifact() 와 의도적 중복 — 두 스크립트는
// standalone 유지 (pre-commit용 / release-tag용). 스키마 변경 시 양쪽 동기화.
function checkSmokeReport() {
  const reportPath = path.join(REPO_ROOT, '.forgen-release', 'smoke-report.json');
  if (!fs.existsSync(reportPath)) {
    const legacy = path.join(REPO_ROOT, '.forgen-release', 'e2e-report.json');
    if (fs.existsSync(legacy)) {
      fail('smoke-report-missing', `e2e-report.json is deprecated since v0.5.0 — generate smoke evidence: node scripts/smoke.cjs`);
    } else {
      fail('smoke-report-missing', `.forgen-release/smoke-report.json not found — run: node scripts/smoke.cjs`);
    }
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    if (data.passed !== true) fail('smoke-failed', `smoke-report.passed=${data.passed}`);
    if (data.mock_detected === true) fail('smoke-mock-detected', `smoke-report.mock_detected=true`);
    // stale-evidence 방지: report 는 현재 package.json 버전으로 생성된 것이어야 한다.
    const pkgVersion = readPkgVersion();
    if (data.version !== pkgVersion) fail('smoke-version-mismatch', `smoke-report.version=${data.version} but package.json=${pkgVersion} — re-run: node scripts/smoke.cjs`);
    const checks = Array.isArray(data.checks) ? data.checks : [];
    if (checks.length === 0) fail('smoke-empty', 'smoke-report has no checks');
    const vitest = checks.find((c) => c && c.name === 'vitest');
    if (!vitest) fail('smoke-vitest-missing', 'smoke-report lacks vitest check');
    else if (vitest.skipped === true) fail('smoke-vitest-skipped', 'vitest was skipped (--skip=vitest) — release evidence requires a full run');
    else if (vitest.passed !== true) fail('smoke-vitest-failed', `vitest check passed=${vitest.passed}`);
  } catch (e) {
    fail('smoke-report-parse', `${String(e)}`);
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
  checkSmokeReport();

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
