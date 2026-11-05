/**
 * Invariant: settings.json parse failure preserves the corrupt original
 * and aborts the write, never silently replaces the user's file with an
 * empty-ish merged object.
 *
 * Audit finding #2/#10 (2026-04-21): prior `catch { settings = {} }`
 * paths in both `src/core/settings-injector.ts` and
 * `scripts/postinstall.js` let subsequent writes clobber any settings.json
 * that had even a single-character JSON error. This test locks the new
 * behavior: preserve to `.corrupt-<ts>`, throw, original file untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-settings-parse-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { readSettingsSafely } = await import('../src/core/settings-lock.js');
const { CLAUDE_DIR, SETTINGS_PATH } = await import('../src/core/paths.js');

describe('readSettingsSafely parse-failure handling', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('settings.json이 없으면 빈 객체 반환 (fresh install)', () => {
    expect(readSettingsSafely()).toEqual({});
  });

  it('유효한 JSON은 파싱해서 반환, 원본 무손상', () => {
    const original = { permissions: { deny: ['Bash(rm -rf *)'] }, theme: 'dark' };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(original, null, 2));
    const before = fs.readFileSync(SETTINGS_PATH, 'utf-8');

    expect(readSettingsSafely()).toEqual(original);

    const after = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    expect(after).toBe(before);
  });

  it('malformed JSON은 throw + 원본 보존 + .corrupt-<ts> 백업', () => {
    const malformed = '{ "permissions": { "deny": [ "Bash(rm -rf';
    fs.writeFileSync(SETTINGS_PATH, malformed);

    expect(() => readSettingsSafely()).toThrow();

    // 원본은 여전히 그대로 (덮어쓰기 없음)
    expect(fs.readFileSync(SETTINGS_PATH, 'utf-8')).toBe(malformed);

    // 손상본 .corrupt-<ts> 파일이 CLAUDE_DIR에 생성됨
    const files = fs.readdirSync(CLAUDE_DIR);
    const corruptFile = files.find((f) => f.includes('.corrupt-'));
    expect(corruptFile).toBeDefined();
    expect(fs.readFileSync(path.join(CLAUDE_DIR, corruptFile!), 'utf-8')).toBe(malformed);
  });

  it('throw 시 실제 타입은 Error (downstream catch 가능)', () => {
    fs.writeFileSync(SETTINGS_PATH, '{ invalid');
    try {
      readSettingsSafely();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });
});

describe('settings-injector data loss defense (static source invariant)', () => {
  it('settings-injector가 readSettingsSafely를 호출한다 (silent {} fallback 금지)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'settings-injector.ts'),
      'utf-8',
    );
    expect(src).toMatch(/readSettingsSafely\(\)/);
    // 과거 silent fallback 패턴이 더 이상 남아있지 않은지 확인
    expect(src).not.toMatch(/log\.debug\([^)]*파싱 실패[^)]*빈 설정/);
  });

  it('설치 경로(install-claude)가 parse 실패 시 corrupt 보존 + 덮어쓰지 않고 throw, 쓰기는 atomic', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'host', 'install-claude.ts'),
      'utf-8',
    );
    // settings.json 과 .claude.json 모두 같은 readJsonObject 를 거친다
    expect(src).toMatch(/corrupt-\$\{Date\.now\(\)\}/);
    expect(src).toMatch(/left untouched/);
    expect(src).toMatch(/renameSync\(tmp, file\)/);
  });
});
