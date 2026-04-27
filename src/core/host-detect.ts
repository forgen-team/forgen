/**
 * Host detection — feat/codex-support Phase 1
 *
 * `forgen install` interactive 의 prerequisite — 사용자 환경에 어떤 host (Claude/Codex)
 * 가 가용한지 탐지. spec §10 Phase 1 + interview R3.
 *
 * 탐지 신호 (각 host 별):
 *   - binary 가 PATH 에 있음 (`which claude` / `which codex`)
 *   - host 디렉토리 존재 (~/.claude/ / ~/.codex/)
 *   - (Codex 만) `~/.codex/auth.json` 존재 (로그인 흔적)
 *
 * detect 결과는 *추론* 만. install 강제 안 함.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import type { HostId } from './trust-layer-intent.js';

export interface HostAvailability {
  readonly host: HostId;
  /** binary 가 PATH 에 있음. */
  readonly binaryFound: boolean;
  /** binary 절대경로 (없으면 null). */
  readonly binaryPath: string | null;
  /** host home 디렉토리 존재 (~/.claude/ 또는 ~/.codex/). */
  readonly homeExists: boolean;
  /** host home 절대경로. */
  readonly homePath: string;
  /** Codex 의 경우 auth.json 존재 (로그인 흔적). Claude 는 항상 null. */
  readonly authPresent: boolean | null;
  /**
   * 종합 판단 — *install 후보로 적합한가*.
   * - binaryFound 또는 homeExists 중 하나 이상이면 true.
   * - 둘 다 없으면 false (사용자가 host 를 안 쓸 가능성 높음).
   */
  readonly available: boolean;
}

export interface HostDetectionResult {
  readonly claude: HostAvailability;
  readonly codex: HostAvailability;
  /** 둘 다 사용 가능. */
  readonly bothAvailable: boolean;
  /** 하나도 사용 가능하지 않음 (warn). */
  readonly noneAvailable: boolean;
}

function which(binary: string): string | null {
  try {
    const out = execFileSync('which', [binary], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function detectClaude(): HostAvailability {
  const binaryPath = which('claude');
  const homePath = path.join(os.homedir(), '.claude');
  const homeExists = fs.existsSync(homePath);
  const binaryFound = binaryPath !== null;
  return {
    host: 'claude',
    binaryFound,
    binaryPath,
    homeExists,
    homePath,
    authPresent: null, // Claude 는 별도 auth.json 패턴이 없음 (subscription 통합)
    available: binaryFound || homeExists,
  };
}

function detectCodex(): HostAvailability {
  const binaryPath = which('codex');
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const homeExists = fs.existsSync(codexHome);
  const binaryFound = binaryPath !== null;
  const authPresent = fs.existsSync(path.join(codexHome, 'auth.json'));
  return {
    host: 'codex',
    binaryFound,
    binaryPath,
    homeExists,
    homePath: codexHome,
    authPresent,
    available: binaryFound || homeExists,
  };
}

export function detectAvailableHosts(): HostDetectionResult {
  const claude = detectClaude();
  const codex = detectCodex();
  return {
    claude,
    codex,
    bothAvailable: claude.available && codex.available,
    noneAvailable: !claude.available && !codex.available,
  };
}
