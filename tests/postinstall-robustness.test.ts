/**
 * V6: postinstall robustness — 실제 사용자 환경에서 발견될 수 있는 다양한 기존
 * settings.json 형태에 대해 postinstall 이 (a) crash 하지 않고 (b) data loss 없고
 * (c) idempotent 한지 실측.
 *
 * postinstall 정책 (audit fix #10 에서 확정):
 *   - valid JSON 이면 non-forgen 필드 보존하며 hooks 주입
 *   - invalid JSON (corrupt / BOM / trailing comma) 이면 원본 보존 + .corrupt-<ts>
 *     백업 + hooks 주입 skip (data loss 방지 우선)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const TEST_HOME = `/tmp/forgen-test-postinstall-${process.pid}`;
const POSTINSTALL = path.resolve('scripts/postinstall.js');

function runPostinstall(homeDir: string) {
  return spawnSync('node', [POSTINSTALL], {
    env: { ...process.env, HOME: homeDir, FORGEN_POSTINSTALL_PKG_ROOT: path.resolve('.') },
    encoding: 'utf-8',
    timeout: 30000,
  });
}

function setupBaseClaude(homeDir: string, settingsContent: string) {
  const claudeDir = path.join(homeDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), settingsContent);
}

function safeReadSettings(homeDir: string): { raw: string; parsed: unknown | null } {
  const p = path.join(homeDir, '.claude', 'settings.json');
  if (!fs.existsSync(p)) return { raw: '', parsed: null };
  const raw = fs.readFileSync(p, 'utf-8');
  try { return { raw, parsed: JSON.parse(raw.replace(/^﻿/, '')) }; }
  catch { return { raw, parsed: null }; }
}

function listCorruptBackups(homeDir: string): string[] {
  const claudeDir = path.join(homeDir, '.claude');
  if (!fs.existsSync(claudeDir)) return [];
  return fs.readdirSync(claudeDir).filter((f) => f.includes('corrupt'));
}

describe('V6: postinstall robustness on real-world settings.json', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('empty-dir: fresh install — P1-6b 옵션 Y 신규 사용자 모드 (host 인젝션 skip + banner)', () => {
    // P1-6b (2026-04-28): 신규 사용자 = settings.json 에 forgen entry 없음 → 자동
    // 인젝션 안 함. forgen install 로 명시 register 가 정책. 검증: banner 출력 +
    // forgen hooks 미인젝션.
    fs.mkdirSync(TEST_HOME, { recursive: true });
    const r = runPostinstall(TEST_HOME);
    expect(r.status).toBe(0);
    const combined = (r.stdout ?? '') + (r.stderr ?? '');
    expect(combined).toMatch(/forgen install|register forgen/i);
    const { parsed } = safeReadSettings(TEST_HOME);
    if (parsed !== null && (parsed as Record<string, unknown>).hooks) {
      const hooks = (parsed as { hooks: Record<string, unknown[]> }).hooks;
      const allCommands = Object.values(hooks).flatMap((events) =>
        (events as Array<{ hooks?: Array<{ command?: string }> }>).flatMap(
          (g) => (g.hooks ?? []).map((h) => h.command ?? ''),
        ),
      );
      const forgenHooks = allCommands.filter((c) =>
        c.includes('CLAUDE_PLUGIN_ROOT') || c.includes('forgen-local'),
      );
      expect(forgenHooks.length).toBe(0);
    }
  });

  it('corrupt JSON: exit 0 + .corrupt backup + original preserved (data loss 방지)', () => {
    setupBaseClaude(TEST_HOME, '{ broken json,, /');
    const r = runPostinstall(TEST_HOME);
    expect(r.status).toBe(0);
    const combined = (r.stdout ?? '') + (r.stderr ?? '');
    expect(combined.toLowerCase()).toMatch(/preserved|corrupt/);
    expect(listCorruptBackups(TEST_HOME).length).toBeGreaterThanOrEqual(1);
    // 원본은 그대로 보존 — user 가 직접 수정해야 injection 적용됨
    const { raw } = safeReadSettings(TEST_HOME);
    expect(raw).toContain('broken json');
  });

  it('trailing commas (semi-JSON): corrupt 로 분류, 원본 보존', () => {
    const semiJson = '{\n  "hooks": {},\n}\n';
    setupBaseClaude(TEST_HOME, semiJson);
    const r = runPostinstall(TEST_HOME);
    expect(r.status).toBe(0);
    const { raw } = safeReadSettings(TEST_HOME);
    // 원본 보존
    expect(raw).toBe(semiJson);
    expect(listCorruptBackups(TEST_HOME).length).toBeGreaterThanOrEqual(1);
  });

  it('UTF-8 BOM: crash 없이 exit 0 (BOM → parse 실패 → corrupt 경로)', () => {
    const withBOM = '﻿' + JSON.stringify({ hooks: {} });
    setupBaseClaude(TEST_HOME, withBOM);
    const r = runPostinstall(TEST_HOME);
    expect(r.status).toBe(0);
    // BOM 파일은 parse 실패 — corrupt 경로로 가거나 BOM strip 후 진행.
    // 어느 쪽이든 crash 없이 끝나면 OK.
    const { raw, parsed } = safeReadSettings(TEST_HOME);
    expect(raw.length).toBeGreaterThan(0);
    // BOM 처리되어 valid JSON 이 돼있거나, 원본 BOM 파일 보존되어 있어야 함
    expect(parsed !== null || raw.startsWith('﻿')).toBe(true);
  });

  it('preexisting non-forgen hook: valid JSON 이면 보존하며 forgen hook 병합', () => {
    const existing = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-audit.sh' }] },
        ],
      },
      permissions: { allow: ['Bash(git *)'] },
    };
    setupBaseClaude(TEST_HOME, JSON.stringify(existing, null, 2));
    const r = runPostinstall(TEST_HOME);
    expect(r.status).toBe(0);
    const { parsed } = safeReadSettings(TEST_HOME);
    expect(parsed).not.toBeNull();
    const s = parsed as Record<string, any>;
    expect(s.permissions).toEqual({ allow: ['Bash(git *)'] });
    // 기존 custom hook 이 유실되지 않음
    expect(JSON.stringify(s.hooks?.PreToolUse ?? [])).toContain('my-audit.sh');
  });

  it('idempotent: 2회 실행 시 기존 사용자 필드 보존 + forgen hook 수량 일정', () => {
    const existing = {
      env: { CUSTOM: 'keep-me' },
      permissions: { allow: ['Bash(npm *)'] },
    };
    setupBaseClaude(TEST_HOME, JSON.stringify(existing, null, 2));

    const r1 = runPostinstall(TEST_HOME);
    expect(r1.status).toBe(0);
    const { parsed: s1 } = safeReadSettings(TEST_HOME);
    expect(s1).not.toBeNull();

    const r2 = runPostinstall(TEST_HOME);
    expect(r2.status).toBe(0);
    const { parsed: s2 } = safeReadSettings(TEST_HOME);
    expect(s2).not.toBeNull();

    const a = s1 as Record<string, any>;
    const b = s2 as Record<string, any>;
    // 사용자 env.CUSTOM 보존 (postinstall 이 FORGEN_ 계열 env 추가하는 건 정상)
    expect(b.env?.CUSTOM).toBe('keep-me');
    expect(b.permissions).toEqual(existing.permissions);
    // hook 중복 등록 없음: 1회 vs 2회 결과의 PreToolUse hook 개수 동일
    const h1Count = JSON.stringify(a.hooks ?? {}).match(/"command"/g)?.length ?? 0;
    const h2Count = JSON.stringify(b.hooks ?? {}).match(/"command"/g)?.length ?? 0;
    expect(h2Count).toBe(h1Count);
  });

  it('readable-only settings: postinstall exit 0', () => {
    setupBaseClaude(TEST_HOME, JSON.stringify({ hooks: {} }));
    const r = runPostinstall(TEST_HOME);
    expect(r.status).toBe(0);
  });
});
