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
  // 실제 호출 형태만 매칭 — 주석/문자열 안의 단순 멘션은 통과.
  // 뒤이어 여는 괄호가 있을 때 호출로 간주.
  const MOCK_RE = /\b(vi\.mock|jest\.mock|sinon\.(stub|mock|spy))\s*\(/;
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
    { name: 'Google OAuth refresh token', re: /\b1\/\/0[A-Za-z0-9_-]{40,}/ },
    { name: 'Stripe secret', re: /\bsk_(live|test)_[0-9A-Za-z]{24,}/ },
    { name: 'Stripe restricted', re: /\brk_(live|test)_[0-9A-Za-z]{24,}/ },
    { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16,}/ },
    { name: 'AWS secret access key', re: /aws_secret_access_key\s*=\s*['"]?[A-Za-z0-9\/+]{40}['"]?/i },
    { name: 'GitHub classic PAT', re: /\bghp_[0-9A-Za-z]{30,}/ },
    { name: 'GitHub OAuth (user-to-server)', re: /\bghu_[0-9A-Za-z]{30,}/ },
    { name: 'GitHub OAuth (server-to-server)', re: /\bghs_[0-9A-Za-z]{30,}/ },
    { name: 'GitHub OAuth (refresh)', re: /\bghr_[0-9A-Za-z]{30,}/ },
    { name: 'GitHub fine-grained PAT', re: /\bgithub_pat_[0-9A-Za-z_]{60,}/ },
    { name: 'GitLab PAT', re: /\bglpat-[0-9A-Za-z_-]{20,}/ },
    { name: 'Slack token', re: /\bxox[bapsr]-[0-9A-Za-z-]{10,}/ },
    { name: 'Slack webhook', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/ },
    { name: 'OpenAI API key', re: /\bsk-[A-Za-z0-9]{20,}/ },
    { name: 'OpenAI project key', re: /\bsk-proj-[A-Za-z0-9_-]{20,}/ },
    { name: 'Anthropic API key', re: /\bsk-ant-(api|admin)\d{2}-[A-Za-z0-9_-]{80,}/ },
    { name: 'NPM token', re: /\bnpm_[A-Za-z0-9]{36}/ },
    { name: 'SendGrid API key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/ },
    { name: 'Fly.io API token', re: /\bfo1_[A-Za-z0-9_-]{40,}/ },
    { name: 'GCP Service Account JSON', re: /"type"\s*:\s*"service_account"/ },
    { name: 'Private key block', re: /-----BEGIN (RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/ },
    { name: 'JWT (3-part base64)', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
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
    /tests\/spike\/.+\/runs\//,
    /tests\/e2e\/harness-e2e/,
    /tests\/post-tool-enforce-via/, // AWS AKIA fixture (EXAMPLE)
    /tests\/hook-integration/, // PRIVATE KEY marker fixture for detectSecrets test
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

// ── 3) enforce_via coverage + dogfood rule regex 정합성 ─────────────────
// ~/.forgen/me/rules 는 사용자 로컬. repo 에는 tests/spike/.../scenarios.json 과
// .forgen/rules/*.json (ADR-003 Phase 1 Dogfood) 가 committed.
function checkEnforceViaCoverage() {
  // 3a. Spike scenarios — verifier 부재 체크
  const scenariosPath = path.join(REPO_ROOT, 'tests', 'spike', 'mech-b-inject', 'scenarios.json');
  if (fs.existsSync(scenariosPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(scenariosPath, 'utf-8'));
      const rules = data.rules ?? [];
      for (const r of rules) {
        if (!r.verifier) fail('enforce_via-missing', `spike rule ${r.id} lacks verifier`);
      }
    } catch (e) {
      fail('enforce_via-missing', `cannot parse scenarios.json: ${String(e)}`);
    }
  }

  // 3b. G12 — .forgen/rules/*.json dogfood regex 검증.
  // 런타임에 new RegExp 가 throw 하면 Mech-A 전체가 침묵할 수 있으므로 CI 에서 선차단.
  // compileSafeRegex 와 동일한 수준(nested quantifier / length) 검사.
  const dogfoodDir = path.join(REPO_ROOT, '.forgen', 'rules');
  if (fs.existsSync(dogfoodDir)) {
    for (const file of fs.readdirSync(dogfoodDir)) {
      if (!file.endsWith('.json')) continue;
      const rulePath = path.join(dogfoodDir, file);
      let rule;
      try {
        rule = JSON.parse(fs.readFileSync(rulePath, 'utf-8'));
      } catch (e) {
        fail('dogfood-rule-parse', `${file}: ${String(e)}`);
        continue;
      }
      // 필수 필드 체크
      for (const field of ['rule_id', 'category', 'scope', 'trigger', 'policy', 'strength', 'status']) {
        if (!rule[field]) fail('dogfood-rule-missing-field', `${file} missing "${field}"`);
      }
      // enforce_via regex 검증
      for (const spec of rule.enforce_via ?? []) {
        const patterns = [
          ['trigger_keywords_regex', spec.trigger_keywords_regex],
          ['trigger_exclude_regex', spec.trigger_exclude_regex],
          ['verifier.params.pattern', spec.verifier?.params?.pattern],
        ];
        for (const [fieldName, pat] of patterns) {
          if (!pat) continue;
          if (typeof pat !== 'string') { fail('dogfood-regex', `${file} ${fieldName} not a string`); continue; }
          if (pat.length > 500) { fail('dogfood-regex', `${file} ${fieldName} length ${pat.length} > 500`); continue; }
          // nested quantifier / overlapping alt / backreference — compileSafeRegex 와 동일 heuristic
          if (/\([^)]*[+*][^)]*\)[+*]/.test(pat)) { fail('dogfood-regex', `${file} ${fieldName} nested quantifier (ReDoS risk)`); continue; }
          if (/\\[1-9]/.test(pat)) { fail('dogfood-regex', `${file} ${fieldName} uses backreference`); continue; }
          try { new RegExp(pat); }
          catch (e) { fail('dogfood-regex', `${file} ${fieldName} compile error: ${String(e).slice(0, 80)}`); }
        }
      }
    }
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
