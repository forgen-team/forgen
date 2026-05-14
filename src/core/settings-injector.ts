/**
 * Settings Injection — Claude Code settings.json manipulation
 *
 * Extracted from harness.ts (B9 decomposition).
 * Handles reading, merging hooks, trust policy, and atomic write.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateHooksJson } from '../hooks/hooks-generator.js';
import { getHostRuntime } from '../host/host-runtime.js';
import { ConfigError } from './errors.js';
import { createLogger } from './logger.js';
import {
  acquireLock,
  atomicWriteFileSync,
  CLAUDE_DIR,
  readSettingsSafely,
  releaseLock,
  rollbackSettings,
  SETTINGS_BACKUP_PATH,
  SETTINGS_PATH,
} from './settings-lock.js';
import type { RuntimeHost } from './types.js';
import type { V1BootstrapResult } from './v1-bootstrap.js';

const log = createLogger('settings-injector');

const FORGEN_PERMISSION_RULES = new Set([
  '# forgen-managed',
  'Bash(rm -rf *)',
  'Bash(git push --force*)',
  'Bash(git reset --hard*)',
]);

function stripForgenManagedRules(rules: string[]): string[] {
  return rules.filter((r) => !FORGEN_PERMISSION_RULES.has(r));
}

/**
 * Read settings.json + create forgen-backup of the valid content.
 *
 * Parse-failure handling moved to `readSettingsSafely` in settings-lock.ts
 * (2026-04-21 audit fix #2): prior silent `{}` fallback would let the
 * caller write merged forgen settings over the user's malformed-but-
 * original file, losing their data. We now preserve the corrupt file to
 * `.corrupt-<ts>` and propagate the error — `injectSettings` releases
 * the lock and the harness bails out of writing.
 */
function readSettingsWithBackup(): Record<string, unknown> {
  const settings = readSettingsSafely();
  if (Object.keys(settings).length > 0 && fs.existsSync(SETTINGS_PATH)) {
    try {
      fs.copyFileSync(SETTINGS_PATH, SETTINGS_BACKUP_PATH);
    } catch (e) {
      log.debug(
        'settings.json backup 복사 실패 (쓰기는 계속 진행)',
        new ConfigError('settings.json backup failed', { configPath: SETTINGS_PATH, cause: e }),
      );
    }
  }
  return settings;
}

/** Apply forgen statusLine only if user hasn't set a custom one.
 *  Migration: 'forgen me' → 'forgen statusline' (multi-line dump → compact HUD). */
function applyStatusLine(settings: Record<string, unknown>): void {
  const existing = settings.statusLine as { type?: string; command?: string } | undefined;
  // 기존에 'forgen me'로 주입된 경우 → 'forgen statusline'으로 자동 마이그레이션
  if (existing?.command === 'forgen me') {
    settings.statusLine = { type: 'command', command: 'forgen statusline' };
    return;
  }
  const isForgenOwned = !existing || !existing.command || existing.command.startsWith('forgen');
  if (isForgenOwned) {
    settings.statusLine = { type: 'command', command: 'forgen statusline' };
  }
}

/** Check if a settings.json hook entry was installed by forgen. */
function isForgenHookEntry(entry: Record<string, unknown>, pkgRoot: string): boolean {
  const distHooksPath = path.join(pkgRoot, 'dist', 'hooks');
  const matchesPath = (cmd: string) =>
    cmd.includes(distHooksPath) || /[\\/]dist[\\/]hooks[\\/].*\.js/.test(cmd);
  if (typeof entry.command === 'string' && matchesPath(entry.command)) return true;
  const hooks = entry.hooks as Array<Record<string, unknown>> | undefined;
  return (
    Array.isArray(hooks) &&
    hooks.some((h) => typeof h.command === 'string' && matchesPath(h.command))
  );
}

/** Strip existing forgen hooks from settings, merge fresh hooks.json. */
function mergeHooksIntoSettings(
  settings: Record<string, unknown>,
  runtime: RuntimeHost,
  cwd: string,
  pkgRoot: string,
): void {
  const hooksConfig = (settings.hooks as Record<string, unknown[]>) ?? {};

  // Remove existing forgen hooks (clean slate before re-inject)
  for (const [event, entries] of Object.entries(hooksConfig)) {
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter(
      (h) => !isForgenHookEntry(h as Record<string, unknown>, pkgRoot),
    );
    if (filtered.length === 0) delete hooksConfig[event];
    else hooksConfig[event] = filtered;
  }

  try {
    const host = getHostRuntime(runtime);
    if (host.hookInjectionStrategy === 'generate') {
      const generated = generateHooksJson({ cwd, runtime, pluginRoot: path.join(pkgRoot, 'dist') });
      for (const [event, handlers] of Object.entries(generated.hooks)) {
        if (!hooksConfig[event]) hooksConfig[event] = [];
        (hooksConfig[event] as unknown[]).push(...handlers);
      }
    } else {
      // 'pre-baked-file': pkgRoot/hooks/hooks.json 읽고 ${CLAUDE_PLUGIN_ROOT} 치환
      const hooksJsonPath = path.join(pkgRoot, 'hooks', 'hooks.json');
      if (fs.existsSync(hooksJsonPath)) {
        const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
        const hooksData = hooksJson.hooks as Record<string, unknown[]> | undefined;
        if (hooksData) {
          const resolved = JSON.parse(
            JSON.stringify(hooksData).replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pkgRoot),
          ) as Record<string, unknown[]>;
          for (const [event, handlers] of Object.entries(resolved)) {
            if (!hooksConfig[event]) hooksConfig[event] = [];
            (hooksConfig[event] as unknown[]).push(...handlers);
          }
        }
      }
    }
  } catch (e) {
    log.debug('hooks.json 로드 실패', e);
  }

  settings.hooks = Object.keys(hooksConfig).length > 0 ? hooksConfig : undefined;
  if (settings.hooks && Object.keys(settings.hooks as Record<string, unknown>).length === 0) {
    delete settings.hooks;
  }
}

/** Apply v1 trust policy → permissions (deny/ask lists). */
function applyTrustPolicyPermissions(
  settings: Record<string, unknown>,
  v1Result: V1BootstrapResult,
): void {
  if (!v1Result.session) return;
  const trust = v1Result.session.effective_trust_policy;
  const permissions = (settings.permissions as Record<string, string[]>) ?? {};
  const existingDeny = stripForgenManagedRules(permissions.deny ?? []);

  if (trust === '가드레일 우선') {
    permissions.deny = [
      ...existingDeny,
      '# forgen-managed',
      'Bash(rm -rf *)',
      'Bash(git push --force*)',
      'Bash(git reset --hard*)',
    ];
  } else if (trust === '승인 완화') {
    const existingAsk = stripForgenManagedRules(permissions.ask ?? []);
    permissions.ask = [
      ...existingAsk,
      '# forgen-managed',
      'Bash(rm -rf *)',
      'Bash(git push --force*)',
    ];
    permissions.deny = existingDeny.length > 0 ? existingDeny : (undefined as unknown as string[]);
  }
  // '완전 신뢰 실행': 추가 제한 없음

  if (!permissions.deny?.length) delete permissions.deny;
  if (!permissions.ask?.length) delete permissions.ask;
  if (Object.keys(permissions).length > 0) settings.permissions = permissions;
}

/**
 * Inject forgen settings into Claude Code settings.json.
 * Coordinates: read/backup → env merge → statusLine → hooks → trust policy → atomic write.
 */
export function injectSettings(
  env: Record<string, string>,
  v1Result: V1BootstrapResult,
  runtime: RuntimeHost,
  cwd: string,
  pkgRoot: string,
): void {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  acquireLock();

  const settings = readSettingsWithBackup();

  // Merge env vars
  settings.env = { ...((settings.env as Record<string, string>) ?? {}), ...env };

  applyStatusLine(settings);
  mergeHooksIntoSettings(settings, runtime, cwd, pkgRoot);
  applyTrustPolicyPermissions(settings, v1Result);

  try {
    atomicWriteFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch (err) {
    rollbackSettings();
    throw err;
  } finally {
    releaseLock();
  }
}
