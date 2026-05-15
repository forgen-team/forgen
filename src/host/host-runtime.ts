/**
 * HostRuntime — Multi-Host Core Design Phase 2
 *
 * `runtime === 'codex'` 분기를 core 에서 제거하기 위한 host-specific 표면 모듈.
 * spec §3.3 / §5.3 의 비대칭 경계: core 는 Claude semantics 알아도 됨, Codex 표면만 모름.
 *
 * 본 모듈이 노출하는 host-specific 표면:
 *   - launcher binary 이름 (codex / claude)
 *   - 사용자 표시 라벨 (Codex / Claude)
 *   - hook command wrapping (Codex 는 codex-adapter 경유)
 *   - 미설치 시 에러 메시지 (host 별 안내)
 *
 * core 측 코드는 본 모듈의 `getHostRuntime(runtime)` 만 호출하여 동작 분기를 위임.
 */

import type { RuntimeHost } from '../core/types.js';

export interface HostRuntime {
  readonly id: RuntimeHost;
  /** 사용자에게 노출되는 표시명 (UI 라벨, 로그). */
  readonly displayName: string;
  /** 실 실행 binary 이름 또는 절대경로. PATH 에서 찾으면 됨. */
  readonly launcher: string;
  /** 미설치 ENOENT 시 사용자에게 노출할 안내. */
  readonly missingInstallMessage: string;
  /**
   * Hook command 래핑.
   * Claude: `node "${pluginRoot}/${script}" ${args}`
   * Codex: `node "${pluginRoot}/host/codex-adapter.js" "${pluginRoot}/${script}" ${args}` (sandbox 호환 + projection)
   */
  wrapHookCommand(pluginRoot: string, scriptPath: string, args: string): string;
  /**
   * settings hook injection strategy.
   *   - 'generate': generateHooksJson({runtime}) 호출 (Codex 등, host-aware wrapping 필요)
   *   - 'pre-baked-file': pkgRoot/hooks/hooks.json 읽고 ${CLAUDE_PLUGIN_ROOT} 치환 (Claude — 빌드 산출물 재사용)
   */
  readonly hookInjectionStrategy: 'generate' | 'pre-baked-file';
  /**
   * 권한 전수 우회용 CLI 플래그 (fgx 등 dangerously-skip 모드에서 사용).
   * Claude: --dangerously-skip-permissions
   * Codex:  --dangerously-bypass-approvals-and-sandbox
   */
  readonly dangerousSkipFlag: string;
}

function quoteArg(raw: string): string {
  return `"${raw.replace(/"/g, '\\"')}"`;
}

const claudeRuntime: HostRuntime = {
  id: 'claude',
  displayName: 'Claude',
  launcher: 'claude',
  missingInstallMessage: 'Claude Code is not installed. npm install -g @anthropic-ai/claude-code',
  wrapHookCommand(pluginRoot, scriptPath, args) {
    const fullScript = `${pluginRoot}/${scriptPath}`;
    return args ? `node ${quoteArg(fullScript)} ${args}` : `node ${quoteArg(fullScript)}`;
  },
  hookInjectionStrategy: 'pre-baked-file',
  dangerousSkipFlag: '--dangerously-skip-permissions',
};

const codexRuntime: HostRuntime = {
  id: 'codex',
  displayName: 'Codex',
  launcher: 'codex',
  missingInstallMessage: 'Codex is not installed.',
  wrapHookCommand(pluginRoot, scriptPath, args) {
    const adapterPath = `${pluginRoot}/host/codex-adapter.js`;
    const fullScript = `${pluginRoot}/${scriptPath}`;
    const base = `node ${quoteArg(adapterPath)} ${quoteArg(fullScript)}`;
    return args ? `${base} ${args}` : base;
  },
  hookInjectionStrategy: 'generate',
  dangerousSkipFlag: '--dangerously-bypass-approvals-and-sandbox',
};

const RUNTIMES: Record<RuntimeHost, HostRuntime> = {
  claude: claudeRuntime,
  codex: codexRuntime,
};

export function getHostRuntime(runtime: RuntimeHost): HostRuntime {
  const r = RUNTIMES[runtime];
  if (!r) throw new Error(`Unknown runtime host: ${runtime}`);
  return r;
}
