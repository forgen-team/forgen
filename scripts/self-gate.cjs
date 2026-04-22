#!/usr/bin/env node
/**
 * scripts/self-gate.cjs — ADR-003 정적 스캔.
 *
 * forgen 이 자기 자신의 L1 규칙을 릴리즈 전에 어기지 않았음을 증명한다.
 * CI fail 시 exit(1).
 *
 * 검사 항목:
 *   1. Mock in production — src/ 비-test 파일에 vi.mock|jest.mock|sinon
 *   2. Secrets leak — API key 패턴
 *   3. enforce_via 누락 — L1 hard/strong rules 가 enforce_via 없이 커밋
 *   4. 릴리즈 일관성 (릴리즈 커밋 한정) — .forgen-release/e2e-report.json 부재
 *
 * β1 제약: 외부 LLM 호출 금지. 순수 파일 스캔.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

const failures = [];
function fail(check, detail) { failures.push({ check, detail }); }

// ── 1) Mock in production ────────────────────────────────────────────────
// src/**/*.ts 중 .test.ts / .spec.ts 제외 — 안에 vi.mock|jest.mock|sinon 리터럴 존재 시 FAIL.
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) walk(p, out);
    else if (name.isFile() && /\.ts$/.test(name.name)) out.push(p);
  }
  return out;
}

function checkMockInProduction() {
  if (!fs.existsSync(SRC_DIR)) return;
  const files = walk(SRC_DIR).filter((f) => !/\.(test|spec)\.ts$/.test(f));
  const MOCK_RE = /\b(vi\.mock|jest\.mock|sinon\.(stub|mock|spy)|\/\*\s*@mock)\b/;
  const hits = [];
  for (const f of files) {
    try {
      const content = fs.readFileSync(f, 'utf-8');
      if (MOCK_RE.test(content)) hits.push(path.relative(REPO_ROOT, f));
    } catch { /* skip */ }
  }
  if (hits.length > 0) {
    fail('mock-in-production', `Mock construct in non-test source file(s):\n    - ${hits.join('\n    - ')}`);
  }
}

// ── 2) Secrets leak ──────────────────────────────────────────────────────
// API key 패턴. .env.example 과 docs/** 는 예시라 허용.
function checkSecretsLeak() {
  const PATTERNS = [
    { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{10,}/ },
    { name: 'Stripe secret', re: /\bsk_(live|test)_[0-9A-Za-z]{24,}/ },
    { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16,}/ },
    { name: 'GitHub PAT', re: /\bghp_[0-9A-Za-z]{30,}/ },
    { name: 'Slack token', re: /\bxox[bapsr]-[0-9A-Za-z-]{10,}/ },
  ];
  const ALLOW_GLOBS = [
    /\.env\.example$/,
    /docs\//,
    /\.md$/,
    /scripts\/self-gate\.cjs$/,
    /tests\/[^/]*secret/,
    /tests\/[^/]*security/,
    /tests\/fixtures\//,
    /tests\/spike\//,
  ];
  const ALLOW_LITERALS = [
    /EXAMPLE\b/, // canonical AWS/GCP/Stripe docs fixtures end in EXAMPLE
  ];
  const root = REPO_ROOT;

  function scan(dir) {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      if (name.name.startsWith('.git')) continue;
      if (name.name === 'node_modules' || name.name === 'dist') continue;
      const p = path.join(dir, name.name);
      const rel = path.relative(root, p);
      if (ALLOW_GLOBS.some((g) => g.test(rel))) continue;
      if (name.isDirectory()) scan(p);
      else if (name.isFile() && /\.(ts|js|cjs|mjs|json|yml|yaml)$/.test(name.name)) {
        try {
          const content = fs.readFileSync(p, 'utf-8');
          for (const { name: n, re } of PATTERNS) {
            const m = content.match(re);
            if (!m) continue;
            // Skip canonical docs fixtures (end in EXAMPLE)
            if (ALLOW_LITERALS.some((lit) => lit.test(m[0]))) continue;
            fail('secrets-leak', `${n} pattern in ${rel} (sample: ${m[0].slice(0, 20)}...)`);
          }
        } catch { /* skip */ }
      }
    }
  }
  scan(root);
}

// ── 3) enforce_via missing on strong/hard rules ──────────────────────────
// ~/.forgen/me/rules 는 사용자 로컬. 여기서는 repo 내 ref rules (tests/fixtures 같은) 있으면 검사.
// forgen 자체 L1 규칙 세트는 향후 repo 에 checked-in 될 예정. 지금은 tests/spike/.../scenarios.json 의 rules 검증.
function checkEnforceViaCoverage() {
  const scenariosPath = path.join(REPO_ROOT, 'tests', 'spike', 'mech-b-inject', 'scenarios.json');
  if (!fs.existsSync(scenariosPath)) return;
  try {
    const data = JSON.parse(fs.readFileSync(scenariosPath, 'utf-8'));
    const rules = data.rules ?? [];
    for (const r of rules) {
      // spike rules inline verifier 를 가지지만 production 타입 EnforceSpec 형식은 아님.
      // 여기서는 verifier 부재만 체크.
      if (!r.verifier) fail('enforce_via-missing', `rule ${r.id} lacks verifier`);
    }
  } catch (e) {
    fail('enforce_via-missing', `cannot parse scenarios.json: ${String(e)}`);
  }
}

// ── 4) Release artifact consistency (release commit only) ────────────────
function isReleaseCommit() {
  try {
    const msg = execFileSync('git', ['log', '-1', '--pretty=%B'], { encoding: 'utf-8' }).trim();
    return /chore\(release\)|^release\s*v?\d|^v\d+\.\d+\.\d+/im.test(msg);
  } catch {
    return false;
  }
}

function checkReleaseArtifact() {
  if (!isReleaseCommit()) return;
  const report = path.join(REPO_ROOT, '.forgen-release', 'e2e-report.json');
  if (!fs.existsSync(report)) {
    fail('release-artifact', `release commit missing .forgen-release/e2e-report.json`);
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(report, 'utf-8'));
    if (data.passed !== true) fail('release-artifact', `e2e-report.passed=${data.passed} (expected true)`);
    if (data.mock_detected === true) fail('release-artifact', `e2e-report flagged mock_detected=true`);
  } catch (e) {
    fail('release-artifact', `cannot parse e2e-report.json: ${String(e)}`);
  }
}

// ── run ──────────────────────────────────────────────────────────────────
function main() {
  checkMockInProduction();
  checkSecretsLeak();
  checkEnforceViaCoverage();
  checkReleaseArtifact();

  if (failures.length === 0) {
    console.log('  [self-gate] ✓ all static checks passed');
    process.exit(0);
  }
  console.error(`\n  [self-gate] ✗ ${failures.length} failure(s):\n`);
  for (const f of failures) {
    console.error(`    [${f.check}] ${f.detail}`);
  }
  console.error('');
  process.exit(1);
}

main();
