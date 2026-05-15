/**
 * v0.4.8 — A2: profile.json 이 깨졌을 때 bootstrapV1Session 이 timestamp
 * backup 으로 자동 격리 → needsOnboarding=true 흐름 검증.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let sandbox: string;
let originalHome: string | undefined;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-profile-corrupt-'));
  originalHome = process.env.FORGEN_HOME;
  process.env.FORGEN_HOME = sandbox;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.FORGEN_HOME;
  else process.env.FORGEN_HOME = originalHome;
});

describe('A2: profile corrupt auto-repair', () => {
  it('backupCorruptProfile() 이 timestamp suffix 로 격리하고 원본 제거', async () => {
    const paths = await import('../src/core/paths.js');
    const store = await import('../src/store/profile-store.js');
    fs.mkdirSync(path.dirname(paths.FORGE_PROFILE), { recursive: true });
    fs.writeFileSync(paths.FORGE_PROFILE, '{ this is not valid json');

    const backupPath = store.backupCorruptProfile();

    expect(backupPath).toBeTruthy();
    expect(backupPath).toMatch(/\.corrupt-/);
    expect(fs.existsSync(paths.FORGE_PROFILE)).toBe(false);
    expect(fs.existsSync(backupPath!)).toBe(true);
    expect(fs.readFileSync(backupPath!, 'utf-8')).toBe('{ this is not valid json');
  });

  it('파일이 없으면 null 반환 (no-op)', async () => {
    const store = await import('../src/store/profile-store.js');
    expect(store.backupCorruptProfile()).toBeNull();
  });

  it('v1-bootstrap: corrupt profile → corruptProfileBackupPath 채워짐 + needsOnboarding=true', async () => {
    const paths = await import('../src/core/paths.js');
    fs.mkdirSync(path.dirname(paths.FORGE_PROFILE), { recursive: true });
    // v1 shape 위반: model_version 없음
    fs.writeFileSync(paths.FORGE_PROFILE, JSON.stringify({ random: 'shape' }));

    const bootstrap = await import('../src/core/v1-bootstrap.js');
    const result = bootstrap.bootstrapV1Session();

    expect(result.needsOnboarding).toBe(true);
    expect(result.corruptProfileBackupPath).toBeTruthy();
    expect(result.corruptProfileBackupPath).toMatch(/\.corrupt-/);
    expect(fs.existsSync(result.corruptProfileBackupPath!)).toBe(true);
    expect(fs.existsSync(paths.FORGE_PROFILE)).toBe(false);
  });
});
