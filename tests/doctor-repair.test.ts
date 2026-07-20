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

  it('attemptPluginRepair: build 는 dist 부재 시에만, postinstall 은 항상 (W1-4)', () => {
    expect(doctorSrc).toMatch(/function attemptPluginRepair/);
    // W1-4 실측 버그: 글로벌 설치엔 devDeps 가 없어 무조건 build 가
    // MODULE_NOT_FOUND 로 실패 → postinstall 미도달. dist 존재 시 build 생략.
    const buildIdx = doctorSrc.indexOf("execFileSync('npm', ['run', 'build']");
    const guardIdx = doctorSrc.indexOf("if (!exists(path.join(pkgRoot, 'dist', 'cli.js')))");
    expect(guardIdx).toBeGreaterThan(0);
    expect(buildIdx).toBeGreaterThan(guardIdx); // build 호출이 dist-guard 안쪽
    expect(doctorSrc).toMatch(/execFileSync\('node',\s*\['scripts\/postinstall\.js'\]/);
  });

  it('W1-4: repair 는 실행이 아니라 결과를 재검증해 보고한다', () => {
    // "실행했다" 가 아니라 pluginCacheOk && pluginRegisteredOk 재검증 통과를
    // 성공 조건으로 삼는다 (실측: postinstall 실행돼도 캐시 미생성 케이스 존재).
    expect(doctorSrc).toMatch(/const ok = pluginCacheOk\(\) && pluginRegisteredOk\(\)/);
    expect(doctorSrc).toMatch(/복구 확인.*재검증 통과/);
  });

  it('W1-4: 재검증 통과 시 failedChecks 에서 plugin 항목을 걷어낸다 (Summary 정직성)', () => {
    expect(doctorSrc).toMatch(/failedChecks = failedChecks\.filter\(f => !pluginLabels\.has\(f\.label\)\)/);
  });

  it('runDoctor 가 plugin cache 또는 registered 실패 + opts.repair=true 일 때만 repair 호출', () => {
    expect(doctorSrc).toMatch(/opts\.repair\s*&&\s*\(!forgenPluginCacheOk\s*\|\|\s*!pluginRegistered\)/);
  });

  it('repair 안내문이 --repair 사용 시 "auto-repair" 로 전환', () => {
    expect(doctorSrc).toMatch(/Attempting auto-repair \(--repair\)/);
  });
});

// ── W1-4: 재검증 헬퍼 실동작 (tmp HOME, 실제 fs) ──

describe('W1-4: pluginCacheOk / pluginRegisteredOk (실제 fs)', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_HOME, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  async function loadHelpers() {
    return import('../src/core/doctor.js');
  }

  it('pluginCacheOk: 버전 디렉토리 존재 시 true, 빈/부재 시 false', async () => {
    const { pluginCacheOk } = await loadHelpers();
    expect(pluginCacheOk()).toBe(false); // 캐시 자체 부재

    const base = path.join(TEST_HOME, '.claude', 'plugins', 'cache', 'forgen-local', 'forgen');
    fs.mkdirSync(base, { recursive: true });
    expect(pluginCacheOk()).toBe(false); // 디렉토리는 있으나 버전 엔트리 없음

    fs.mkdirSync(path.join(base, '0.5.0'));
    expect(pluginCacheOk()).toBe(true);
  });

  it('pluginRegisteredOk: entry + installPath 실존 시에만 true', async () => {
    const { pluginRegisteredOk } = await loadHelpers();
    expect(pluginRegisteredOk()).toBe(false); // registry 부재

    const pluginsDir = path.join(TEST_HOME, '.claude', 'plugins');
    const installPath = path.join(pluginsDir, 'cache', 'forgen-local', 'forgen', '0.5.0');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const registryPath = path.join(pluginsDir, 'installed_plugins.json');

    // 등록은 됐지만 installPath 가 디스크에 없음 → false (이번 세션 실측 케이스)
    fs.writeFileSync(registryPath, JSON.stringify({
      version: 2,
      plugins: { 'forgen@forgen-local': [{ scope: 'user', installPath, version: '0.5.0' }] },
    }));
    expect(pluginRegisteredOk()).toBe(false);

    fs.mkdirSync(installPath, { recursive: true });
    expect(pluginRegisteredOk()).toBe(true);
  });
});
