/**
 * Codex InstallPlan — Multi-Host Core Design §10 우선순위 3
 *
 * `~/.codex/hooks.json` 에 forgen hook 등록(절대경로, idempotent), `~/.codex/config.toml`
 * 에 forgen-compound MCP 등록(managed marker block). $CODEX_HOME 환경변수 존중.
 *
 * 동작 원칙:
 * - hook 등록은 generateHooksJson({runtime:'codex', pluginRoot, releaseMode}) 결과를 그대로 사용
 *   — 이미 codex-adapter wrapper + 절대경로 적용됨 (spec §18.5 결정 옵션 1).
 * - 사용자가 직접 작성한 비-forgen hook 은 보존 (`isForgenHookEntry` pattern).
 * - MCP 등록은 TOML 라이브러리 없이 marker block 으로 idempotent 관리.
 * - dryRun 시 파일을 쓰지 않고 결과만 반환 (테스트 + preview 용).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateHooksJson } from '../hooks/hooks-generator.js';

export interface CodexInstallOptions {
  /** forgen package root (build 산출물 dist/ 의 부모). 기본: 호출 시 process.cwd(). */
  pkgRoot: string;
  /** codex home (default: $CODEX_HOME ?? ~/.codex). */
  codexHome?: string;
  /** dry-run: 파일 미작성, 결과만 반환. */
  dryRun?: boolean;
  /** MCP 서버 등록 여부 (default true). */
  registerMcp?: boolean;
  /** hooks-generator releaseMode (default true: 환경 독립). */
  releaseMode?: boolean;
}

export interface CodexInstallResult {
  codexHome: string;
  hooksPath: string;
  hooksWritten: boolean;
  hooksCount: number;
  preservedUserHookCount: number;
  configTomlPath: string;
  mcpRegistered: boolean;
  mcpAlreadyPresent: boolean;
}

const MCP_MARKER_BEGIN = '# >>> forgen-managed-mcp';
const MCP_MARKER_END = '# <<< forgen-managed-mcp';

function resolveCodexHome(opts: CodexInstallOptions): string {
  return opts.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

function isForgenManagedHook(entry: unknown, pkgRoot: string): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as { hooks?: Array<{ command?: string }> };
  if (!Array.isArray(e.hooks)) return false;
  return e.hooks.some(
    (h) => typeof h.command === 'string' && h.command.includes(pkgRoot),
  );
}

function readJsonFile<T>(p: string): T | null {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function buildMcpBlock(pkgRoot: string): string {
  // forgen-mcp 는 dist/mcp/server.js. node 경로는 PATH 기반.
  const serverPath = path.join(pkgRoot, 'dist', 'mcp', 'server.js');
  return [
    MCP_MARKER_BEGIN,
    '[mcp_servers.forgen-compound]',
    'command = "node"',
    `args = [${JSON.stringify(serverPath)}]`,
    MCP_MARKER_END,
  ].join('\n');
}

function upsertMcpBlock(currentToml: string, pkgRoot: string): { content: string; alreadyPresent: boolean } {
  const block = buildMcpBlock(pkgRoot);
  // marker block 이 있으면 그 사이를 새 block 으로 교체
  const reMarker = new RegExp(
    `${MCP_MARKER_BEGIN}[\\s\\S]*?${MCP_MARKER_END}`,
    'g',
  );
  if (reMarker.test(currentToml)) {
    const replaced = currentToml.replace(reMarker, block);
    return { content: replaced, alreadyPresent: replaced === currentToml };
  }
  // 없으면 끝에 append
  const trimmed = currentToml.replace(/\s+$/, '');
  const sep = trimmed.length > 0 ? '\n\n' : '';
  return { content: `${trimmed}${sep}${block}\n`, alreadyPresent: false };
}

interface HooksFile {
  description?: string;
  hooks: Record<string, Array<unknown>>;
}

export function planCodexInstall(opts: CodexInstallOptions): CodexInstallResult {
  const codexHome = resolveCodexHome(opts);
  const hooksPath = path.join(codexHome, 'hooks.json');
  const configTomlPath = path.join(codexHome, 'config.toml');
  const releaseMode = opts.releaseMode ?? true;

  // 1) forgen 측 hook (codex-adapter wrap + 절대경로) 생성
  const generated = generateHooksJson({
    pluginRoot: path.join(opts.pkgRoot, 'dist'),
    runtime: 'codex',
    releaseMode,
  });
  const generatedHooks = generated.hooks as Record<string, unknown[]>;

  // 2) 기존 hooks.json 읽기 + forgen entry 제거 후 보존
  const existing = readJsonFile<HooksFile>(hooksPath);
  const existingHooksByEvent = (existing?.hooks ?? {}) as Record<string, unknown[]>;
  const preserved: Record<string, unknown[]> = {};
  let preservedCount = 0;
  for (const [event, entries] of Object.entries(existingHooksByEvent)) {
    if (!Array.isArray(entries)) continue;
    const userEntries = entries.filter((e) => !isForgenManagedHook(e, opts.pkgRoot));
    if (userEntries.length > 0) {
      preserved[event] = userEntries;
      preservedCount += userEntries.length;
    }
  }

  // 3) merge: user 보존 + forgen fresh.
  //    `forgenCount` 는 실제 hook 명령 개수 (matcher group 내부 hooks[] 길이의 합) 로 집계한다.
  const merged: Record<string, unknown[]> = { ...preserved };
  let forgenCount = 0;
  for (const [event, entries] of Object.entries(generatedHooks)) {
    const list = merged[event] ?? [];
    list.push(...entries);
    merged[event] = list;
    for (const group of entries) {
      const g = group as { hooks?: unknown[] };
      if (Array.isArray(g.hooks)) forgenCount += g.hooks.length;
    }
  }

  const finalHooksFile: HooksFile = {
    description: 'forgen Codex hooks (managed; user-authored entries preserved)',
    hooks: merged,
  };

  // 4) MCP 등록
  const registerMcp = opts.registerMcp ?? true;
  let mcpAlreadyPresent = false;
  let mcpRegistered = false;
  let mcpContentToWrite: string | null = null;

  if (registerMcp) {
    const currentToml = fs.existsSync(configTomlPath)
      ? fs.readFileSync(configTomlPath, 'utf-8')
      : '';
    const { content, alreadyPresent } = upsertMcpBlock(currentToml, opts.pkgRoot);
    mcpAlreadyPresent = alreadyPresent;
    mcpRegistered = !alreadyPresent;
    mcpContentToWrite = content;
  }

  // 5) 실제 쓰기 (dryRun 이면 skip)
  if (!opts.dryRun) {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(hooksPath, `${JSON.stringify(finalHooksFile, null, 2)}\n`, 'utf-8');
    if (mcpContentToWrite !== null) {
      fs.writeFileSync(configTomlPath, mcpContentToWrite, 'utf-8');
    }
  }

  return {
    codexHome,
    hooksPath,
    hooksWritten: !opts.dryRun,
    hooksCount: forgenCount,
    preservedUserHookCount: preservedCount,
    configTomlPath,
    mcpRegistered,
    mcpAlreadyPresent,
  };
}
