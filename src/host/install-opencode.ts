/**
 * install-opencode — forgen 을 OpenCode host 에 설치 (W3-3 P1).
 *
 * OpenCode 는 in-process TS plugin + opencode.json MCP + AGENTS.md 를 쓴다:
 *   1. plugin: `~/.config/opencode/plugins/forgen.ts` (assets/opencode/forgen.ts 배포).
 *      이 plugin 이 `tool.execute.before` 를 `forgen opencode-guard` 로 브릿지(block-tool-use).
 *   2. MCP: `~/.config/opencode/opencode.json` 의 `mcp.forgen-compound` (local, node server).
 *   3. AGENTS.md: cwd 의 forgen rules block (Codex 와 동일 헬퍼 재사용).
 *
 * subprocess-hook(Claude/Codex)과 달리 hooks.json 이 없다 — OpenCode 는 plugin 이 hook 표면이다.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger } from '../core/logger.js';
import { resolveAgentsMdPath, upsertForgenRulesInAgentsMd } from './install-codex.js';

const log = createLogger('install-opencode');

const PLUGIN_FILENAME = 'forgen.ts';
const MCP_SERVER_NAME = 'forgen-compound';

export interface OpencodeInstallOptions {
  pkgRoot: string;
  dryRun?: boolean;
  registerMcp?: boolean;
  /** ~/.config/opencode override (격리 테스트용). */
  opencodeConfigDir?: string;
  /** AGENTS.md 위치 override (격리 테스트용). */
  agentsMdPath?: string;
}

export interface OpencodeInstallResult {
  configDir: string;
  pluginPath: string;
  pluginInstalled: boolean;
  mcpRegistered: boolean;
  mcpAlreadyPresent: boolean;
  agentsMdInjected: boolean;
}

export function resolveOpencodeConfigDir(opts: OpencodeInstallOptions): string {
  return opts.opencodeConfigDir ?? path.join(os.homedir(), '.config', 'opencode');
}

/** opencode.json 의 mcp.forgen-compound 블록을 upsert. JSON 병합(TOML 아님). */
function upsertOpencodeMcp(
  currentJson: string,
  pkgRoot: string,
): { content: string; alreadyPresent: boolean } {
  const serverPath = path.join(pkgRoot, 'dist', 'mcp', 'server.js');
  const desired = {
    type: 'local',
    command: ['node', serverPath, '--host=opencode'],
    enabled: true,
  };

  let config: Record<string, unknown> = {};
  if (currentJson.trim()) {
    try {
      config = JSON.parse(currentJson) as Record<string, unknown>;
    } catch {
      // 파싱 실패 시 덮어쓰지 않고 새 config 로 시작(사용자 파일 보존 위해 백업은 호출측 책임)
      config = {};
    }
  }
  if (!config.$schema) config.$schema = 'https://opencode.ai/config.json';
  const mcp = (config.mcp && typeof config.mcp === 'object' ? config.mcp : {}) as Record<string, unknown>;
  const existing = JSON.stringify(mcp[MCP_SERVER_NAME] ?? null);
  const alreadyPresent = existing === JSON.stringify(desired);
  mcp[MCP_SERVER_NAME] = desired;
  config.mcp = mcp;
  return { content: `${JSON.stringify(config, null, 2)}\n`, alreadyPresent };
}

export function planOpencodeInstall(opts: OpencodeInstallOptions): OpencodeInstallResult {
  const configDir = resolveOpencodeConfigDir(opts);
  const pluginsDir = path.join(configDir, 'plugins');
  const pluginPath = path.join(pluginsDir, PLUGIN_FILENAME);
  const configJsonPath = path.join(configDir, 'opencode.json');
  const registerMcp = opts.registerMcp ?? true;

  // 1) plugin 소스 로드 (assets/opencode/forgen.ts)
  const pluginSrcPath = path.join(opts.pkgRoot, 'assets', 'opencode', PLUGIN_FILENAME);
  let pluginSrc = '';
  let pluginInstalled = false;
  try {
    pluginSrc = fs.readFileSync(pluginSrcPath, 'utf-8');
  } catch (e) {
    log.debug('opencode plugin asset 읽기 실패', e);
  }

  // 2) MCP upsert
  let mcpRegistered = false;
  let mcpAlreadyPresent = false;
  let mcpContent: string | null = null;
  if (registerMcp) {
    const current = fs.existsSync(configJsonPath) ? fs.readFileSync(configJsonPath, 'utf-8') : '';
    const { content, alreadyPresent } = upsertOpencodeMcp(current, opts.pkgRoot);
    mcpAlreadyPresent = alreadyPresent;
    mcpRegistered = !alreadyPresent;
    mcpContent = content;
  }

  // 3) 실제 쓰기 (dryRun skip)
  if (!opts.dryRun) {
    if (pluginSrc) {
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(pluginPath, pluginSrc, 'utf-8');
      pluginInstalled = true;
    }
    if (mcpContent !== null) {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configJsonPath, mcpContent, 'utf-8');
    }
  } else {
    pluginInstalled = Boolean(pluginSrc);
  }

  // 4) AGENTS.md rules block (Codex 헬퍼 재사용 — OpenCode 도 AGENTS.md read)
  const agentsMdPath = opts.agentsMdPath ?? resolveAgentsMdPath(opts.pkgRoot);
  const agentsResult = upsertForgenRulesInAgentsMd({
    agentsMdPath,
    pkgRoot: opts.pkgRoot,
    dryRun: opts.dryRun ?? false,
  });

  return {
    configDir,
    pluginPath,
    pluginInstalled,
    mcpRegistered,
    mcpAlreadyPresent,
    agentsMdInjected: agentsResult.injected,
  };
}
