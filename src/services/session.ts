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

import { type LaunchContext, type RuntimeHost } from '../core/types.js';

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
 * CLI 인자를 파싱해 런타임 결정 + 런타임 플래그 제거
 * - --runtime codex
 * - --runtime=codex
 */
export function resolveLaunchContext(args: string[]): LaunchContext {
  const runtimeFromEnv = parseRuntime(process.env.FORGEN_RUNTIME);
  const result: LaunchContext = {
    runtime: runtimeFromEnv ?? DEFAULT_RUNTIME,
    args: [],
    runtimeSource: runtimeFromEnv ? 'env' : 'default',
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
