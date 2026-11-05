/**
 * Settings Injection — Claude Code settings.json manipulation
 *
 * Extracted from harness.ts (B9 decomposition).
 * Handles reading, merging hooks, trust policy, and atomic write.
 */

import * as fs from 'node:fs';
import { ensureForgenRunShim } from '../host/claude-shim.js';
import { applyForgenSettings } from '../host/install-claude.js';
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

// 주의(2026-08-04 버그수정): '# forgen-managed' 는 **더 이상 주입하지 않는다** — JSON
// permissions 배열엔 주석이 데이터 원소가 되어 Claude Code 가 malformed deny 룰로 경고했다.
// strip-set 에는 남겨둬, 이전 버그로 오염된 사용자 settings 가 재주입 시 self-heal 되게 한다.
// 멱등성은 마커가 아니라 아래 실제 룰 문자열의 정확일치 제거로 이미 보장된다.
const FORGEN_PERMISSION_RULES = new Set([
  '# forgen-managed', // legacy 오염 정리용 (신규 주입 안 함)
  'Bash(rm -rf *)',
  'Bash(git push --force*)',
  'Bash(git reset --hard*)',
]);
/** 신규 주입할 forgen deny 룰 (마커 없음). */
const FORGEN_DENY_RULES = ['Bash(rm -rf *)', 'Bash(git push --force*)', 'Bash(git reset --hard*)'];
const FORGEN_ASK_RULES = ['Bash(rm -rf *)', 'Bash(git push --force*)'];

export function stripForgenManagedRules(rules: string[]): string[] {
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

/** Apply v1 trust policy → permissions (deny/ask lists). */
export function applyTrustPolicyPermissions(
  settings: Record<string, unknown>,
  v1Result: V1BootstrapResult,
): void {
  if (!v1Result.session) return;
  const trust = v1Result.session.effective_trust_policy;
  const permissions = (settings.permissions as Record<string, string[]>) ?? {};
  const existingDeny = stripForgenManagedRules(permissions.deny ?? []);

  if (trust === '가드레일 우선') {
    permissions.deny = [...existingDeny, ...FORGEN_DENY_RULES];
  } else if (trust === '승인 완화') {
    const existingAsk = stripForgenManagedRules(permissions.ask ?? []);
    permissions.ask = [...existingAsk, ...FORGEN_ASK_RULES];
    permissions.deny = existingDeny.length > 0 ? existingDeny : (undefined as unknown as string[]);
  }
  // '완전 신뢰 실행': 추가 제한 없음

  if (!permissions.deny?.length) delete permissions.deny;
  if (!permissions.ask?.length) delete permissions.ask;
  if (Object.keys(permissions).length > 0) settings.permissions = permissions;
}

/**
 * Inject forgen settings into Claude Code settings.json.
 * Coordinates: read/backup → shim → hooks/statusLine (install-claude 와 같은 함수) → trust policy → atomic write.
 *
 * 세션 env(FORGEN_CWD 등)는 settings.json 에 쓰지 않는다 — 래퍼가 자식 프로세스 env 로 넘긴다(spawn.ts).
 * 이전 버전이 남긴 FORGEN_* env 는 applyForgenSettings 가 지운다. 내용이 바뀐 경우에만 쓴다.
 */
export function injectSettings(
  _env: Record<string, string>,
  v1Result: V1BootstrapResult,
  _runtime: RuntimeHost,
  _cwd: string,
  pkgRoot: string,
): void {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  acquireLock();

  try {
    const settings = readSettingsWithBackup();
    const before = JSON.stringify(settings);

    const shim = ensureForgenRunShim(pkgRoot);
    applyForgenSettings(settings, pkgRoot, shim.path);
    applyTrustPolicyPermissions(settings, v1Result);

    if (JSON.stringify(settings) !== before || !fs.existsSync(SETTINGS_PATH)) {
      try {
        atomicWriteFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
      } catch (err) {
        rollbackSettings();
        throw err;
      }
    }
  } finally {
    releaseLock();
  }
}
