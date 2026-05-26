/**
 * Preflight check for forgen initialization state.
 *
 * Detects "hooks wired but no profile" — a user who ran `forgen install`
 * but never completed onboarding via `forgen`. Emits a one-time warning
 * per session so the user knows personalization is disabled.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { FORGEN_HOME, STATE_DIR } from '../../core/paths.js';

const ME_DIR = path.join(FORGEN_HOME, 'me');
const PROFILE_PATH = path.join(ME_DIR, 'forge-profile.json');

export function checkForgenInitialized(): { initialized: boolean; message?: string } {
  try {
    if (!fs.existsSync(FORGEN_HOME)) {
      return {
        initialized: false,
        message: '[forgen] ~/.forgen not found — run `forgen` to complete setup.',
      };
    }
    if (!fs.existsSync(PROFILE_PATH)) {
      return {
        initialized: false,
        message: '[forgen] Profile not found — run `forgen` to complete onboarding. Hooks are active but personalization is disabled.',
      };
    }
    return { initialized: true };
  } catch {
    return { initialized: true };
  }
}

/** Returns true if a preflight warning has already been emitted this session */
export function hasPreflightWarned(sessionId: string): boolean {
  try {
    return fs.existsSync(path.join(STATE_DIR, `preflight-warned-${sessionId}`));
  } catch {
    return true;
  }
}

/** Mark that a preflight warning has been emitted for this session */
export function markPreflightWarned(sessionId: string): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, `preflight-warned-${sessionId}`), '1');
  } catch {
    // fail-open
  }
}
