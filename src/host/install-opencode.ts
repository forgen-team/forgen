/**
 * install-opencode — forgen 을 OpenCode host 에 설치 (W3-3 P1).
 *
 * OpenCode 는 in-process TS plugin + opencode.json(c) MCP + AGENTS.md 를 쓴다:
 *   1. plugin: `~/.config/opencode/plugins/forgen.ts` (assets/opencode/forgen.ts 배포).
 *      GUARD_CMD 는 절대 forgen CLI 경로로 치환(런타임 PATH 비의존 — 리뷰 MED4).
 *   2. MCP: 기존 config 파일(opencode.jsonc 우선, 없으면 opencode.json)에 mcp.forgen-compound
 *      surgical 병합. **JSONC 파서(jsonc-parser)로 주석/trailing-comma 보존**, 쓰기 전 백업
 *      (리뷰 HIGH: JSON.parse 가 공식 JSONC 를 clobber 하던 데이터 손실 수정).
 *   3. AGENTS.md: cwd 의 forgen rules block (Codex 헬퍼 재사용).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import { createLogger } from '../core/logger.js';
import { resolveAgentsMdPath, upsertForgenRulesInAgentsMd } from './install-codex.js';

const log = createLogger('install-opencode');

const PLUGIN_FILENAME = 'forgen.ts';
const PLUGIN_MARKER = 'forgen-managed';
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
  /** 사용자 소유(비-managed) plugin 을 백업했으면 그 경로. */
  pluginBackupPath?: string;
  mcpRegistered: boolean;
  mcpAlreadyPresent: boolean;
  /** MCP 대상 config 파일(.jsonc 우선). */
  mcpConfigPath: string;
  /** 파싱 불가 config 라 MCP 를 건드리지 않고 abort 했으면 true(데이터 손실 방지). */
  mcpSkippedUnparseable: boolean;
  /** config 백업 경로(수정 전 .bak). */
  mcpBackupPath?: string;
  agentsMdInjected: boolean;
}

export function resolveOpencodeConfigDir(opts: OpencodeInstallOptions): string {
  if (opts.opencodeConfigDir) return opts.opencodeConfigDir;
  // OpenCode 는 XDG_CONFIG_HOME 을 존중한다(config docs). forgen 도 동일 해석해야 실제 로드
  // 위치에 배포된다 — hardcode ~/.config 이면 XDG override 사용자에게 미도달.
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'opencode');
}

/** 기존 config 파일 경로 감지 — opencode.jsonc 우선, 없으면 opencode.json (둘 다 없으면 .json 신규). */
function resolveConfigFilePath(configDir: string): string {
  const jsonc = path.join(configDir, 'opencode.jsonc');
  if (fs.existsSync(jsonc)) return jsonc;
  return path.join(configDir, 'opencode.json');
}

interface McpMergeResult {
  /** 쓸 내용. null 이면 파싱 불가로 abort(사용자 파일 보존). */
  content: string | null;
  alreadyPresent: boolean;
  unparseable: boolean;
}

/**
 * config 텍스트에 mcp.forgen-compound 를 surgical 병합. jsonc-parser 로 주석/포맷 보존.
 * 파싱 불가(errors)면 clobber 하지 않고 null 반환(데이터 손실 방지, 리뷰 HIGH).
 */
function upsertOpencodeMcp(currentText: string, pkgRoot: string): McpMergeResult {
  const serverPath = path.join(pkgRoot, 'dist', 'mcp', 'server.js');
  const desired = { type: 'local', command: ['node', serverPath, '--host=opencode'], enabled: true };

  const src = currentText.trim().length > 0 ? currentText : '{}';
  // 파싱 검증 — 유효 JSONC 가 아니면(구조 손상) abort.
  const errors: { error: number; offset: number; length: number }[] = [];
  const parsed = parseJsonc(src, errors, { allowTrailingComma: true });
  if (errors.length > 0 || parsed === undefined || (parsed !== null && typeof parsed !== 'object')) {
    return { content: null, alreadyPresent: false, unparseable: true };
  }

  const existing = (parsed as { mcp?: Record<string, unknown> })?.mcp?.[MCP_SERVER_NAME];
  const alreadyPresent = JSON.stringify(existing) === JSON.stringify(desired);
  if (alreadyPresent) return { content: src, alreadyPresent: true, unparseable: false };

  // surgical edit — 주석/기타 키/포맷 보존.
  let out = src;
  const opts = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  out = applyEdits(out, modify(out, ['mcp', MCP_SERVER_NAME], desired, opts));
  // $schema 없으면 추가(있으면 유지).
  if ((parsed as { $schema?: unknown }).$schema === undefined) {
    out = applyEdits(out, modify(out, ['$schema'], 'https://opencode.ai/config.json', opts));
  }
  return { content: out.endsWith('\n') ? out : `${out}\n`, alreadyPresent: false, unparseable: false };
}

/** 배포 plugin 소스 로드 + GUARD_CMD 를 절대 forgen CLI 경로로 치환(런타임 PATH 비의존). */
function loadPluginSource(pkgRoot: string): string | null {
  const srcPath = path.join(pkgRoot, 'assets', 'opencode', PLUGIN_FILENAME);
  let src: string;
  try {
    src = fs.readFileSync(srcPath, 'utf-8');
  } catch (e) {
    log.debug('opencode plugin asset 읽기 실패', e);
    return null;
  }
  const cliPath = path.join(pkgRoot, 'dist', 'cli.js');
  // ["forgen", "<sub>"] → ["node", "<abs cli>", "<sub>"] (PATH 비의존, 리뷰 MED4).
  const replaced = src
    .replace(/\["forgen",\s*"opencode-guard"\]/, `["node", ${JSON.stringify(cliPath)}, "opencode-guard"]`)
    .replace(/\["forgen",\s*"opencode-context"\]/, `["node", ${JSON.stringify(cliPath)}, "opencode-context"]`);
  return replaced;
}

export function planOpencodeInstall(opts: OpencodeInstallOptions): OpencodeInstallResult {
  const configDir = resolveOpencodeConfigDir(opts);
  const pluginsDir = path.join(configDir, 'plugins');
  const pluginPath = path.join(pluginsDir, PLUGIN_FILENAME);
  const mcpConfigPath = resolveConfigFilePath(configDir);
  const registerMcp = opts.registerMcp ?? true;
  const dryRun = opts.dryRun ?? false;

  const result: OpencodeInstallResult = {
    configDir,
    pluginPath,
    pluginInstalled: false,
    mcpRegistered: false,
    mcpAlreadyPresent: false,
    mcpConfigPath,
    mcpSkippedUnparseable: false,
    agentsMdInjected: false,
  };

  // ── 1) plugin 배포 (marker 확인 + 사용자 파일 백업) ──
  const pluginSrc = loadPluginSource(opts.pkgRoot);
  if (pluginSrc) {
    // 기존 plugin 이 forgen-managed 가 아니면(사용자 소유) 백업.
    if (!dryRun && fs.existsSync(pluginPath)) {
      const existing = fs.readFileSync(pluginPath, 'utf-8');
      if (!existing.includes(PLUGIN_MARKER)) {
        const bak = `${pluginPath}.bak`;
        fs.copyFileSync(pluginPath, bak);
        result.pluginBackupPath = bak;
      }
    }
    if (!dryRun) {
      fs.mkdirSync(pluginsDir, { recursive: true });
      fs.writeFileSync(pluginPath, pluginSrc, 'utf-8');
    }
    result.pluginInstalled = true;
  }

  // ── 2) MCP surgical 병합 (JSONC 안전 + 백업 + abort-on-unparseable) ──
  if (registerMcp) {
    const current = fs.existsSync(mcpConfigPath) ? fs.readFileSync(mcpConfigPath, 'utf-8') : '';
    const merge = upsertOpencodeMcp(current, opts.pkgRoot);
    if (merge.unparseable) {
      // 파싱 불가 → 사용자 config 보존, MCP 스킵 + 경고 (데이터 손실 방지).
      result.mcpSkippedUnparseable = true;
      log.debug(`opencode config 파싱 불가 — MCP 등록 스킵(사용자 파일 보존): ${mcpConfigPath}`);
    } else {
      result.mcpAlreadyPresent = merge.alreadyPresent;
      result.mcpRegistered = !merge.alreadyPresent;
      if (!dryRun && merge.content !== null && !merge.alreadyPresent) {
        fs.mkdirSync(configDir, { recursive: true });
        // 쓰기 전 백업(기존 파일이 있을 때만).
        if (current.length > 0) {
          const bak = `${mcpConfigPath}.bak`;
          fs.writeFileSync(bak, current, 'utf-8');
          result.mcpBackupPath = bak;
        }
        fs.writeFileSync(mcpConfigPath, merge.content, 'utf-8');
      }
    }
  }

  // ── 3) AGENTS.md rules (Codex 헬퍼 재사용) ──
  const agentsMdPath = opts.agentsMdPath ?? resolveAgentsMdPath(opts.pkgRoot);
  const agentsResult = upsertForgenRulesInAgentsMd({ agentsMdPath, pkgRoot: opts.pkgRoot, dryRun });
  result.agentsMdInjected = agentsResult.injected;

  return result;
}
