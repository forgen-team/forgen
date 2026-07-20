#!/usr/bin/env node
/**
 * scripts/smoke.cjs — 릴리스 smoke 증거 생성기 (ADR-010 W0-2).
 *
 * Docker e2e 게이트 폐지(2026-07-16, evidence a723507f)에 따른 대체 증거 경로.
 * 원칙 유지: 모든 check 는 실제 child_process 실행 산출물만 기록한다 (mock 금지).
 * mock_detected 는 구조상 항상 false — 이 스크립트는 spawn 결과 외의 값을 쓰지 않는다.
 *
 * 산출: .forgen-release/smoke-report.json  (self-gate.cjs / self-gate-release.cjs 가 검증)
 *
 * 사용:
 *   node scripts/smoke.cjs                 # 전체 (릴리스 파이프라인)
 *   node scripts/smoke.cjs --skip=vitest   # 빠른 로컬/테스트용 — 게이트는 이 report 를 거부한다
 *   node scripts/smoke.cjs --out=<dir>     # report 출력 디렉토리 오버라이드 (테스트용)
 *
 * Checks:
 *   1. vitest               — `npx vitest run` 전체 그린
 *   2. cli-version          — dist/cli.js --version 이 package.json 버전과 일치
 *   3. statusline-roundtrip — dist/cli.js statusline 이 stdin JSON 을 받아 정상 출력
 *   4. hook-exec            — 대표 훅(stop-guard, secret-filter)이 최소 stdin 에서 정상 종료
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = process.env.FORGEN_GATE_ROOT || path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { skip: new Set(), out: null };
  for (const a of argv.slice(2)) {
    const skipM = a.match(/^--skip=(.+)$/);
    if (skipM) { for (const s of skipM[1].split(',')) args.skip.add(s.trim()); continue; }
    const outM = a.match(/^--out=(.+)$/);
    if (outM) { args.out = outM[1]; continue; }
  }
  return args;
}

/** 실제 프로세스 실행. 결과 객체만이 check 의 근거가 된다. */
function run(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: opts.timeout ?? 15 * 60 * 1000,
    input: opts.input,
    env: { ...process.env, ...opts.env },
  });
}

function checkVitest() {
  const r = run('npx', ['vitest', 'run'], { timeout: 20 * 60 * 1000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // vitest 요약 라인 추출 (e.g. "Tests  2721 passed")
  const m = out.match(/Tests\s+([^\n]+)/);
  return {
    name: 'vitest',
    passed: r.status === 0,
    summary: m ? m[1].trim() : `exit=${r.status}`,
  };
}

function checkCliVersion() {
  const cli = path.join(REPO_ROOT, 'dist', 'cli.js');
  if (!fs.existsSync(cli)) {
    return { name: 'cli-version', passed: false, summary: 'dist/cli.js missing — run npm run build' };
  }
  const r = run('node', [cli, '--version'], { timeout: 30_000 });
  const got = (r.stdout ?? '').trim();
  let want = null;
  try {
    want = String(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')).version);
  } catch { /* fallthrough */ }
  const ok = r.status === 0 && want !== null && got === want;
  return { name: 'cli-version', passed: ok, summary: ok ? got : `exit=${r.status} got="${got}" want="${want}"` };
}

function checkStatuslineRoundtrip() {
  const cli = path.join(REPO_ROOT, 'dist', 'cli.js');
  const r = run('node', [cli, 'statusline'], { input: '{}\n', timeout: 30_000 });
  const ok = r.status === 0 && (r.stdout ?? '').trim().length > 0;
  return { name: 'statusline-roundtrip', passed: ok, summary: ok ? 'stdin {} → non-empty output' : `exit=${r.status}` };
}

function checkHookExec() {
  // 대표 훅 2종: Stop(stop-guard) + PostToolUse(secret-filter).
  // Docker e2e 가 지키던 핵심 = 훅 런타임이 최소 입력에서 crash 하지 않는 것.
  const hooks = ['stop-guard.js', 'secret-filter.js'];
  const results = [];
  for (const h of hooks) {
    const p = path.join(REPO_ROOT, 'dist', 'hooks', h);
    if (!fs.existsSync(p)) { results.push(`${h}: missing`); continue; }
    const r = run('node', [p], { input: '{}\n', timeout: 30_000 });
    if (r.status !== 0) results.push(`${h}: exit=${r.status}`);
  }
  return {
    name: 'hook-exec',
    passed: results.length === 0,
    summary: results.length === 0 ? `${hooks.join(', ')} exit 0 on minimal stdin` : results.join('; '),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const checks = [];

  if (args.skip.has('vitest')) {
    checks.push({ name: 'vitest', passed: false, skipped: true, summary: 'skipped via --skip=vitest (gate will reject)' });
  } else {
    console.log('  [smoke] vitest run …');
    checks.push(checkVitest());
  }
  console.log('  [smoke] cli-version …');
  checks.push(checkCliVersion());
  console.log('  [smoke] statusline-roundtrip …');
  checks.push(checkStatuslineRoundtrip());
  console.log('  [smoke] hook-exec …');
  checks.push(checkHookExec());

  const executed = checks.filter((c) => !c.skipped);
  const executedPassed = executed.length > 0 && executed.every((c) => c.passed === true);
  // report.passed 불변식: "전 체크가 실행되고 전부 통과" — skip 이 하나라도 있으면 false.
  // exit code 는 실행된 체크 기준(executedPassed)이라 --skip 개발 플로우는 그대로 exit 0.
  const passed = executedPassed && executed.length === checks.length;

  // version 바인딩: 게이트가 stale report(이전 릴리스 증거 재사용)를 거부할 수 있도록
  // 생성 시점의 package.json 버전을 박아 넣는다.
  let pkgVersion = null;
  try {
    pkgVersion = String(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')).version);
  } catch { /* report 에 null 로 남김 — 게이트에서 mismatch 로 걸린다 */ }

  const report = {
    schema: 'smoke-report/v1',
    passed,
    at: new Date().toISOString(),
    version: pkgVersion,
    // 구조상 항상 false: 모든 check 는 위 spawnSync 산출물에서만 유도된다.
    mock_detected: false,
    node: process.version,
    checks,
  };

  const outDir = args.out ? path.resolve(args.out) : path.join(REPO_ROOT, '.forgen-release');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'smoke-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');

  for (const c of checks) {
    const mark = c.skipped ? '○' : c.passed ? '✓' : '✗';
    console.log(`  [smoke] ${mark} ${c.name} — ${c.summary}`);
  }
  console.log(`  [smoke] report → ${outPath} (passed=${passed}, executed=${executed.length}/${checks.length})`);
  process.exit(executedPassed ? 0 : 1);
}

main();
