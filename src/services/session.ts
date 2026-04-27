/**
 * Launch-time runtime selection helpers.
 *
 * 기본 동작:
 * - --runtime claude|codex 플래그 우선
 * - 설정되지 않으면 FORGEN_RUNTIME 환경변수 사용
 * - 환경변수 미설정 시 claude 기본값
 *
 * 목표:
 * - launch context(런타임 + 정제된 args)를 단일 타입으로 통일
 * - CLI/fgx에서 수집한 런타임 값을 Harness, Spawn, Hook Generator에 일관되게 전달
 */

import { createRequire } from 'node:module';
import { type LaunchContext, type RuntimeHost } from '../core/types.js';

const localRequire = createRequire(import.meta.url);

/** 런타임 정규화: 외부 문자열을 내부 enum으로 변환 */
function parseRuntime(raw: string | undefined): RuntimeHost | null {
  if (!raw) return null;
  switch (raw.trim().toLowerCase()) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    default:
      return null;
  }
}

const DEFAULT_RUNTIME: RuntimeHost = 'claude';

/**
 * profile.default_host 를 읽어 runtime 결정.
 * 'ask' 면 별도 prompt 책임 — 본 함수는 default 'claude' 로 fallback (caller 가 --ask 처리).
 * profile-store import 가 cycle 위험이라 require 로 lazy.
 */
function readProfileDefaultRuntime(): RuntimeHost | null {
  try {
    const mod = localRequire('../store/profile-store.js') as { getDefaultHost?: () => 'claude' | 'codex' | 'ask' | undefined };
    const stored = mod.getDefaultHost?.();
    if (stored === 'claude' || stored === 'codex') return stored;
    return null; // 'ask' 또는 미설정
  } catch {
    return null;
  }
}

/**
 * CLI 인자를 파싱해 런타임 결정 + 런타임 플래그 제거
 * 우선순위 (높음→낮음):
 *   1. --runtime <claude|codex> flag
 *   2. FORGEN_RUNTIME env
 *   3. profile.default_host (P1-4)
 *   4. 'claude' fallback (legacy 호환)
 */
export function resolveLaunchContext(args: string[]): LaunchContext {
  const runtimeFromEnv = parseRuntime(process.env.FORGEN_RUNTIME);
  const runtimeFromProfile = runtimeFromEnv ? null : readProfileDefaultRuntime();
  const initial = runtimeFromEnv ?? runtimeFromProfile ?? DEFAULT_RUNTIME;
  const initialSource: LaunchContext['runtimeSource'] = runtimeFromEnv
    ? 'env'
    : runtimeFromProfile
      ? 'profile'
      : 'default';

  const result: LaunchContext = {
    runtime: initial,
    args: [],
    runtimeSource: initialSource,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--runtime') {
      const next = args[i + 1];
      const parsed = parseRuntime(next);
      if (parsed) {
        result.runtime = parsed;
        result.runtimeSource = 'flag';
        i += 1;
      }
      continue;
    }

    if (arg.startsWith('--runtime=')) {
      const parsed = parseRuntime(arg.slice('--runtime='.length));
      if (parsed) {
        result.runtime = parsed;
        result.runtimeSource = 'flag';
      }
      continue;
    }

    result.args.push(arg);
  }

  return result;
}
