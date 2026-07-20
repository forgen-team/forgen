/**
 * tests/release-gate-smoke.test.ts — ADR-010 W0-2 릴리스 게이트 개정 검증.
 *
 * Docker e2e-report 게이트 → smoke-report 게이트 전환의 회귀 방지.
 * 원칙: 전 케이스 실제 child_process spawn (mock 금지). fixture 는 tmp 디렉토리
 * + FORGEN_GATE_ROOT 오버라이드로 구성한다.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SMOKE = path.join(REPO_ROOT, 'scripts', 'smoke.cjs');
const GATE_RELEASE = path.join(REPO_ROOT, 'scripts', 'self-gate-release.cjs');
const GATE_STATIC = path.join(REPO_ROOT, 'scripts', 'self-gate.cjs');

function runNode(script: string, opts: { env?: Record<string, string>; cwd?: string; args?: string[] } = {}) {
  return spawnSync('node', [script, ...(opts.args ?? [])], {
    encoding: 'utf-8',
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: 120_000,
  });
}

function validSmokeReport(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'smoke-report/v1',
    passed: true,
    at: new Date().toISOString(),
    version: '9.9.9', // fixture package.json 과 바인딩
    mock_detected: false,
    node: process.version,
    checks: [
      { name: 'vitest', passed: true, summary: '9999 passed' },
      { name: 'cli-version', passed: true, summary: '9.9.9' },
      { name: 'statusline-roundtrip', passed: true, summary: 'ok' },
      { name: 'hook-exec', passed: true, summary: 'ok' },
    ],
    ...overrides,
  };
}

/** self-gate-release 용 최소 릴리스 fixture: version/tag/CHANGELOG/dist 전부 유효 */
function makeReleaseFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-gate-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 9.9.9\n- test\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), '// src');
  fs.mkdirSync(path.join(dir, 'dist'));
  fs.writeFileSync(path.join(dir, 'dist', 'a.js'), '// dist');
  // dist 가 src 보다 최신이도록 (freshness check)
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(path.join(dir, 'dist', 'a.js'), future, future);
  fs.mkdirSync(path.join(dir, '.forgen-release'));
  return dir;
}

function writeReport(dir: string, report: unknown): void {
  fs.writeFileSync(path.join(dir, '.forgen-release', 'smoke-report.json'), JSON.stringify(report, null, 2));
}

const RELEASE_ENV = { GITHUB_REF: 'refs/tags/v9.9.9' };

const cleanups: string[] = [];
afterAll(() => {
  for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });
});

describe('smoke.cjs (evidence generator)', () => {
  let outDir: string;
  beforeAll(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-smoke-out-'));
    cleanups.push(outDir);
  });

  it('runs real checks against this repo and writes a report (--skip=vitest)', () => {
    const r = runNode(SMOKE, { args: ['--skip=vitest', `--out=${outDir}`] });
    const reportPath = path.join(outDir, 'smoke-report.json');
    expect(fs.existsSync(reportPath), `smoke did not write report. stdout=${r.stdout} stderr=${r.stderr}`).toBe(true);

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    expect(report.schema).toBe('smoke-report/v1');
    expect(report.mock_detected).toBe(false);

    const byName = Object.fromEntries(report.checks.map((c: { name: string }) => [c.name, c]));
    // vitest 는 스킵 마킹 — 게이트가 거부해야 하는 형태
    expect(byName['vitest'].skipped).toBe(true);
    // 리뷰 SEV-3: skip 이 있으면 report.passed 는 false — "passed:true = 전 체크 실행+통과" 불변식
    expect(report.passed).toBe(false);
    // 나머지는 실제 실행 결과 — 이 레포의 dist 는 빌드돼 있으므로 통과해야 한다
    expect(byName['cli-version'].passed).toBe(true);
    expect(byName['statusline-roundtrip'].passed).toBe(true);
    expect(byName['hook-exec'].passed).toBe(true);
    // 실행된 check 전부 통과 → exit 0
    expect(r.status).toBe(0);
  }, 120_000);
});

describe('self-gate-release.cjs (release-tag gate)', () => {
  it('passes with a valid smoke-report', () => {
    const dir = makeReleaseFixture();
    cleanups.push(dir);
    writeReport(dir, validSmokeReport());
    const r = runNode(GATE_RELEASE, { env: { ...RELEASE_ENV, FORGEN_GATE_ROOT: dir } });
    expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
  });

  it('fails with migration message when only legacy e2e-report exists', () => {
    const dir = makeReleaseFixture();
    cleanups.push(dir);
    fs.writeFileSync(
      path.join(dir, '.forgen-release', 'e2e-report.json'),
      JSON.stringify({ passed: true, mock_detected: false }),
    );
    const r = runNode(GATE_RELEASE, { env: { ...RELEASE_ENV, FORGEN_GATE_ROOT: dir } });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('deprecated');
    expect(`${r.stdout}${r.stderr}`).toContain('smoke.cjs');
  });

  it('fails when smoke-report.passed=false', () => {
    const dir = makeReleaseFixture();
    cleanups.push(dir);
    writeReport(dir, validSmokeReport({ passed: false }));
    const r = runNode(GATE_RELEASE, { env: { ...RELEASE_ENV, FORGEN_GATE_ROOT: dir } });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('smoke-failed');
  });

  it('rejects a --skip=vitest report (vitest skipped)', () => {
    const dir = makeReleaseFixture();
    cleanups.push(dir);
    const report = validSmokeReport();
    (report.checks as Array<Record<string, unknown>>)[0] = { name: 'vitest', passed: false, skipped: true, summary: 'skipped' };
    writeReport(dir, report);
    const r = runNode(GATE_RELEASE, { env: { ...RELEASE_ENV, FORGEN_GATE_ROOT: dir } });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('smoke-vitest-skipped');
  });

  it('fails when mock_detected=true', () => {
    const dir = makeReleaseFixture();
    cleanups.push(dir);
    writeReport(dir, validSmokeReport({ mock_detected: true }));
    const r = runNode(GATE_RELEASE, { env: { ...RELEASE_ENV, FORGEN_GATE_ROOT: dir } });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('smoke-mock-detected');
  });

  it('rejects a stale report from a previous version (version binding)', () => {
    const dir = makeReleaseFixture();
    cleanups.push(dir);
    writeReport(dir, validSmokeReport({ version: '9.9.8' })); // 이전 릴리스 증거 재사용 시나리오
    const r = runNode(GATE_RELEASE, { env: { ...RELEASE_ENV, FORGEN_GATE_ROOT: dir } });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('smoke-version-mismatch');
  });
});

describe('self-gate.cjs checkReleaseArtifact (pre-commit static gate)', () => {
  /** git repo fixture — isReleaseCommit 은 cwd 의 마지막 커밋 subject 를 본다 */
  function makeGitFixture(commitSubject: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-gate-git-'));
    const git = (...args: string[]) =>
      spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf-8' });
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', commitSubject);
    fs.mkdirSync(path.join(dir, '.forgen-release'), { recursive: true });
    // version 바인딩 검사가 읽는 package.json
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    return dir;
  }

  it('release commit + stale version report → fail', () => {
    const dir = makeGitFixture('chore(release): 9.9.9');
    cleanups.push(dir);
    writeReport(dir, validSmokeReport({ version: '9.9.8' }));
    const r = runNode(GATE_STATIC, { cwd: dir, env: { FORGEN_GATE_ROOT: dir } });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('smoke-report.version');
  });

  it('release commit + valid smoke-report → pass', () => {
    const dir = makeGitFixture('chore(release): 9.9.9');
    cleanups.push(dir);
    writeReport(dir, validSmokeReport());
    const r = runNode(GATE_STATIC, { cwd: dir, env: { FORGEN_GATE_ROOT: dir } });
    expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
  });

  it('release commit + missing report → fail with smoke.cjs hint', () => {
    const dir = makeGitFixture('chore(release): 9.9.9');
    cleanups.push(dir);
    const r = runNode(GATE_STATIC, { cwd: dir, env: { FORGEN_GATE_ROOT: dir } });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('smoke-report.json');
  });

  it("colon format 'release: v9.9.9' is recognized as a release commit (review fix)", () => {
    const dir = makeGitFixture('release: v9.9.9');
    cleanups.push(dir);
    const r = runNode(GATE_STATIC, { cwd: dir, env: { FORGEN_GATE_ROOT: dir } });
    expect(r.status).toBe(1); // report 없음 → 릴리스 커밋으로 인식돼 실패해야 함
    expect(`${r.stdout}${r.stderr}`).toContain('smoke-report.json');
  });

  it('non-release commit → report not required', () => {
    const dir = makeGitFixture('feat: unrelated change');
    cleanups.push(dir);
    const r = runNode(GATE_STATIC, { cwd: dir, env: { FORGEN_GATE_ROOT: dir } });
    expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
  });
});

describe('dogfood 룰 정합 (e2e 게이트 폐지 회귀 방지 — 리뷰 SEV-2)', () => {
  it('.forgen/rules 에 active 상태의 e2e 완료게이트 룰이 없다', () => {
    // e2e 게이트 폐지(교정 a723507f) 후 v1-rules.md(안내)와 rule-store JSON(강제)이
    // 갈라지는 split-brain 회귀 방지: 완료-선언을 e2e 증거에 묶는 룰은 retired 여야 한다.
    const rulesDir = path.join(REPO_ROOT, '.forgen', 'rules');
    if (!fs.existsSync(rulesDir)) return;
    for (const f of fs.readdirSync(rulesDir).filter((n) => n.endsWith('.json'))) {
      const rule = JSON.parse(fs.readFileSync(path.join(rulesDir, f), 'utf-8'));
      const bindsCompletionToE2e =
        rule.trigger === 'completion-before-e2e' || /e2e-result\.json/.test(JSON.stringify(rule.enforce_via ?? []));
      if (bindsCompletionToE2e) {
        expect(rule.status, `${f} 는 e2e 완료게이트를 강제하므로 retired 여야 한다`).not.toBe('active');
      }
    }
  });
});
