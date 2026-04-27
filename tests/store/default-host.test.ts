/**
 * default_host helpers — feat/codex-support P1-4 단위 테스트
 *
 * profile.default_host 의 read/write/resolve 동작 검증.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('../../src/store/profile-store.js');

let originalForgenHome: string | undefined;
let isolatedHome: string;

async function reload(): Promise<Mod> {
  vi.resetModules();
  return (await import('../../src/store/profile-store.js')) as Mod;
}

beforeEach(() => {
  originalForgenHome = process.env.FORGEN_HOME;
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'default-host-test-'));
  process.env.FORGEN_HOME = isolatedHome;
});

afterEach(() => {
  if (originalForgenHome === undefined) delete process.env.FORGEN_HOME;
  else process.env.FORGEN_HOME = originalForgenHome;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

describe('default_host helpers', () => {
  it('legacy profile (default_host 미설정) → resolveDefaultHost = claude fallback', async () => {
    const m = await reload();
    const p = m.createProfile('default', '균형형', '확인 우선형', '균형형', 'inferred', '구조적접근형', '균형형');
    m.saveProfile(p);
    expect(m.getDefaultHost()).toBeUndefined();
    expect(m.resolveDefaultHost()).toBe('claude');
  });

  it('setDefaultHost(codex) → getDefaultHost = codex + resolveDefaultHost = codex', async () => {
    const m = await reload();
    const p = m.createProfile('default', '균형형', '확인 우선형', '균형형', 'inferred', '구조적접근형', '균형형');
    m.saveProfile(p);
    expect(m.setDefaultHost('codex')).toBe(true);
    expect(m.getDefaultHost()).toBe('codex');
    expect(m.resolveDefaultHost()).toBe('codex');
  });

  it('setDefaultHost(ask) → resolveDefaultHost = ask (caller 가 prompt 책임)', async () => {
    const m = await reload();
    const p = m.createProfile('default', '균형형', '확인 우선형', '균형형', 'inferred', '구조적접근형', '균형형');
    m.saveProfile(p);
    m.setDefaultHost('ask');
    expect(m.resolveDefaultHost()).toBe('ask');
  });

  it('explicit override 가 profile.default_host 보다 우선', async () => {
    const m = await reload();
    const p = m.createProfile('default', '균형형', '확인 우선형', '균형형', 'inferred', '구조적접근형', '균형형');
    m.saveProfile(p);
    m.setDefaultHost('codex');
    expect(m.resolveDefaultHost('claude')).toBe('claude');
    expect(m.resolveDefaultHost('codex')).toBe('codex');
  });

  it('profile 없을 때 setDefaultHost → false', async () => {
    const m = await reload();
    expect(m.setDefaultHost('codex')).toBe(false);
  });

  it('setDefaultHost 가 metadata.updated_at 갱신', async () => {
    const m = await reload();
    const p = m.createProfile('default', '균형형', '확인 우선형', '균형형', 'inferred', '구조적접근형', '균형형');
    p.metadata.updated_at = '2020-01-01T00:00:00Z';
    m.saveProfile(p);
    m.setDefaultHost('codex');
    const after = m.loadProfile();
    expect(after?.metadata.updated_at).not.toBe('2020-01-01T00:00:00Z');
  });
});
