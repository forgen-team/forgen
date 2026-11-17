import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  installedVersionPath, maybeStartSelfSetup, runSetupNow, SELF_SETUP_RETRY_MS, setupState,
} from '../src/core/install-marker.js';

let root: string;
let pkg: string;
let home: string;

/** postinstall 대역: 받은 env 를 기록하고 표식을 남긴다 (실제 postinstall 의 마지막 단계와 같은 결과). */
const FAKE_POSTINSTALL = `
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.FORGEN_HOME;
mkdirSync(join(home, 'state'), { recursive: true });
writeFileSync(join(home, 'ran.json'), JSON.stringify({ global: process.env.npm_config_global, self: process.env.FORGEN_SELF_SETUP }));
writeFileSync(join(home, 'state', 'installed-version'), '1.2.3\\n');
`;

async function waitFor(file: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-marker-'));
  pkg = path.join(root, 'pkg');
  home = path.join(root, 'home');
  fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '1.2.3', type: 'module' }));
  fs.writeFileSync(path.join(pkg, 'scripts', 'postinstall.js'), FAKE_POSTINSTALL);
  process.env.FORGEN_HOME = home;
});
afterEach(() => {
  delete process.env.FORGEN_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('setupState', () => {
  it('표식이 없으면 설치 마무리가 필요하다', () => {
    expect(setupState(pkg, home)).toMatchObject({ pending: true, pkgVersion: '1.2.3', installed: null });
  });
  it('표식이 이전 버전이면 필요하고, 같은 버전이면 필요 없다', () => {
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.writeFileSync(installedVersionPath(home), '1.2.2\n');
    expect(setupState(pkg, home).pending).toBe(true);
    fs.writeFileSync(installedVersionPath(home), '1.2.3\n');
    expect(setupState(pkg, home).pending).toBe(false);
  });
  it('저장소 체크아웃은 대상이 아니다 (postinstall 이 사용자 설정을 건드리지 않음)', () => {
    fs.mkdirSync(path.join(pkg, '.git'));
    expect(setupState(pkg, home)).toMatchObject({ pending: false, skip: 'repo checkout' });
  });
});

describe('maybeStartSelfSetup', () => {
  it('필요하면 postinstall 을 전역 설치 env 로 띄우고 표식이 생긴다', async () => {
    expect(maybeStartSelfSetup({ pkgRoot: pkg, home })).toBe(true);
    await waitFor(path.join(home, 'ran.json'));
    expect(JSON.parse(fs.readFileSync(path.join(home, 'ran.json'), 'utf-8'))).toEqual({ global: 'true', self: '1' });
    await waitFor(installedVersionPath(home));
    expect(setupState(pkg, home).pending).toBe(false);
    expect(maybeStartSelfSetup({ pkgRoot: pkg, home })).toBe(false);
  });
  it('같은 버전은 재시도 간격 안에 다시 띄우지 않고, 간격이 지나면 다시 띄운다', () => {
    // 표식을 남기지 않는(실패하는) postinstall
    fs.writeFileSync(path.join(pkg, 'scripts', 'postinstall.js'), 'process.exit(1);\n');
    const t0 = 1_000_000;
    expect(maybeStartSelfSetup({ pkgRoot: pkg, home, now: t0 })).toBe(true);
    expect(maybeStartSelfSetup({ pkgRoot: pkg, home, now: t0 + 1000 })).toBe(false);
    expect(maybeStartSelfSetup({ pkgRoot: pkg, home, now: t0 + SELF_SETUP_RETRY_MS + 1 })).toBe(true);
  });
  it('버전이 바뀌면 재시도 간격과 무관하게 띄운다', () => {
    fs.writeFileSync(path.join(pkg, 'scripts', 'postinstall.js'), 'process.exit(1);\n');
    expect(maybeStartSelfSetup({ pkgRoot: pkg, home, now: 1 })).toBe(true);
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '1.2.4', type: 'module' }));
    expect(maybeStartSelfSetup({ pkgRoot: pkg, home, now: 2 })).toBe(true);
  });
});

describe('runSetupNow', () => {
  it('postinstall 을 동기로 실행해 표식을 남긴다', () => {
    const r = runSetupNow(pkg);
    expect(r.status).toBe(0);
    expect(setupState(pkg, home).pending).toBe(false);
  });
});
