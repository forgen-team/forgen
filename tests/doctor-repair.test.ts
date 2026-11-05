/**
 * v0.4.8 (E3): forgen doctor --repair 옵션이 DoctorOptions 시그니처에
 * 노출되고, repair=true 시 안내문이 "auto-repair 시도" 로 바뀌는지 검증.
 *
 * 실제 npm run build + postinstall 실행은 통합 환경 의존이라 단위 테스트
 * 에서는 호출 신호 (안내문 + opts 시그니처) 만 검증.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// W1-4 헬퍼 테스트용 tmp HOME (ESM 에선 spyOn(os) 불가 → vi.mock)
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-doctor-repair-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

describe('A E3: forgen doctor --repair 시그니처', () => {
  const srcPath = path.join(__dirname, '..', 'src', 'core', 'doctor.ts');
  const cliPath = path.join(__dirname, '..', 'src', 'cli.ts');
  const doctorSrc = fs.readFileSync(srcPath, 'utf-8');
  const cliSrc = fs.readFileSync(cliPath, 'utf-8');

  it('DoctorOptions 에 repair?: boolean 필드 노출', () => {
    expect(doctorSrc).toMatch(/repair\?:\s*boolean/);
  });

  it('cli.ts doctor handler 가 --repair 플래그를 opts.repair 로 매핑', () => {
    expect(cliSrc).toMatch(/repair:\s*args\.includes\(['"]--repair['"]\)/);
  });

  it('repair 는 설치와 같은 경로(planClaudeInstall)로 다시 쓰고 재검증한다', () => {
    expect(doctorSrc).toMatch(/planClaudeInstall\(\{ pkgRoot: currentPkgRoot\(\)/);
    expect(doctorSrc).toMatch(/opts\.repair && probes\.some/);
    expect(doctorSrc).toMatch(/복구 확인.*재검증 통과/);
  });
});

// ── shimTargetOk 실동작 (tmp HOME, 실제 fs) ──

describe('shimTargetOk', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_HOME, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('shim 부재 → false, 가리키는 패키지가 있으면 true, 패키지가 사라지면 false', async () => {
    const { shimTargetOk } = await import('../src/core/doctor.js');
    const { writeForgenRunShim, forgenRunShimPath } = await import('../src/host/claude-shim.js');
    expect(shimTargetOk(TEST_HOME)).toBe(false);

    const pkg = path.join(TEST_HOME, 'pkg');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'dist', 'cli.js'), '');
    writeForgenRunShim(pkg, process.execPath, forgenRunShimPath(TEST_HOME));
    expect(shimTargetOk(TEST_HOME)).toBe(true);

    fs.rmSync(pkg, { recursive: true, force: true });
    expect(shimTargetOk(TEST_HOME)).toBe(false);
  });
});
