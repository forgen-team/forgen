/**
 * fgx init — dev-guide inject wiring regression guard
 *
 * 목적: init.ts 의 injectDevGuidePrinciples 호출이 profileExists() 분기 *앞*에
 * 위치하는 것을 보장. 단위 테스트(dev-guide-injector.test.ts)는 wiring 회귀를 잡지 못함.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let cwd: string;
let forgenHome: string;
let originalCwd: string;
let originalForgenHome: string | undefined;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fgx-init-test-'));
  forgenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fgx-home-test-'));
  originalCwd = process.cwd();
  originalForgenHome = process.env.FORGEN_HOME;
  process.env.FORGEN_HOME = forgenHome;
  process.chdir(cwd);
  vi.resetModules();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(forgenHome, { recursive: true, force: true });
  if (originalForgenHome === undefined) delete process.env.FORGEN_HOME;
  else process.env.FORGEN_HOME = originalForgenHome;
  vi.resetModules();
});

describe('fgx init — dev-guide inject wiring (regression guard)', () => {
  it('profile 없음 케이스: inject 가 onboarding 전에 통과', async () => {
    // react 프로젝트로 스택 감지되도록
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      name: 't', dependencies: { react: '^19.0.0' },
    }));

    vi.doMock('../../src/forge/onboarding-cli.js', () => ({
      runOnboarding: async () => { /* no-op */ },
    }));
    vi.doMock('../../src/store/profile-store.js', () => ({
      profileExists: () => false,
    }));
    // init-cli 도 no-op
    vi.doMock('../../src/core/init-cli.js', () => ({
      initializeForgenHome: () => ({ solutionsInstalled: 0, skipped: false, solutionsSkippedExisting: 0 }),
    }));

    const { handleInit } = await import('../../src/core/init.js');
    await handleInit([]);

    expect(fs.existsSync(path.join(cwd, '.claude', 'rules', 'dev-guide-principles.md'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'AGENTS.md'))).toBe(true);
  });

  it('profile 존재 케이스: inject 가 early-return 전에 통과', async () => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      name: 't', dependencies: { react: '^19.0.0' },
    }));

    vi.doMock('../../src/store/profile-store.js', () => ({
      profileExists: () => true,
    }));
    vi.doMock('../../src/core/init-cli.js', () => ({
      initializeForgenHome: () => ({ solutionsInstalled: 0, skipped: false, solutionsSkippedExisting: 0 }),
    }));

    const { handleInit } = await import('../../src/core/init.js');
    await handleInit([]);

    expect(fs.existsSync(path.join(cwd, '.claude', 'rules', 'dev-guide-principles.md'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'AGENTS.md'))).toBe(true);
  });

  it('스택 미감지 (package.json/go.mod 없음): 파일 안 만들어짐', async () => {
    // package.json 없음 — 스택 감지 불가

    vi.doMock('../../src/store/profile-store.js', () => ({
      profileExists: () => true,
    }));
    vi.doMock('../../src/core/init-cli.js', () => ({
      initializeForgenHome: () => ({ solutionsInstalled: 0, skipped: false, solutionsSkippedExisting: 0 }),
    }));

    const { handleInit } = await import('../../src/core/init.js');
    await handleInit([]);

    expect(fs.existsSync(path.join(cwd, '.claude', 'rules', 'dev-guide-principles.md'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, 'AGENTS.md'))).toBe(false);
  });
});
