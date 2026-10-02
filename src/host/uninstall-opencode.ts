/**
 * OpenCode uninstall — ADR-016 0.5.9
 *
 * `forgen install opencode` 가 쓴 것을 되돌린다: `plugins/forgen.ts`, config(JSONC) 의 `mcp.forgen-compound`,
 * AGENTS.md 블록. 사용자 소유물(마커 없는 plugin, 같은 이름의 다른 MCP 서버, 파싱 불가 config)은 건드리지 않는다.
 * MCP 제거는 다른 키와 값을 보존하지만, forgen 항목에 붙어 있던 주석과 주변 포맷은 바뀔 수 있다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import { removeForgenRulesEverywhere, resolveAgentsMdPath } from './install-codex.js';
import { MCP_SERVER_NAME, PLUGIN_FILENAME, PLUGIN_MARKER, resolveOpencodeConfigDir } from './install-opencode.js';

export interface OpencodeUninstallOptions {
  pkgRoot: string;
  /** ~/.config/opencode override (격리 테스트용). */
  opencodeConfigDir?: string;
  /** AGENTS.md 위치 override (격리 테스트용). */
  agentsMdPath?: string;
  dryRun?: boolean;
}

export interface OpencodeUninstallResult {
  configDir: string;
  /** config 디렉토리가 없으면 false — 나머지는 전부 false/빈 값 */
  present: boolean;
  pluginRemoved: boolean;
  /** 설치 때 백업해 둔 사용자 plugin(`forgen.ts.bak`)을 되돌렸는가 */
  pluginRestoredFromBackup: boolean;
  mcpRemoved: boolean;
  /** config 가 유효한 JSONC 가 아니라 건드리지 않음 */
  mcpSkippedUnparseable: boolean;
  agentsMdCleanedPaths: string[];
  errors: string[];
}

/** forgen 이 등록한 MCP 항목인가: command 에 `…/dist/mcp/server.js` 와 `--host=opencode` 가 있다. */
function isForgenMcpEntry(entry: unknown): boolean {
  const command = (entry as { command?: unknown } | null)?.command;
  if (!Array.isArray(command)) return false;
  return command.some((a) => typeof a === 'string' && /[\\/]dist[\\/]mcp[\\/]server\.js$/.test(a))
    && command.includes('--host=opencode');
}

/** config 텍스트에서 `mcp.forgen-compound` 를 제거. 다른 키·서버는 보존, `mcp` 가 비면 그 키도 제거. */
export function removeOpencodeMcp(currentText: string): { content: string; removed: boolean; unparseable: boolean } {
  if (currentText.trim().length === 0) return { content: currentText, removed: false, unparseable: false };
  const errors: { error: number; offset: number; length: number }[] = [];
  const parsed = parseJsonc(currentText, errors, { allowTrailingComma: true }) as { mcp?: Record<string, unknown> } | undefined;
  if (errors.length > 0 || parsed === undefined || parsed === null || typeof parsed !== 'object') {
    return { content: currentText, removed: false, unparseable: true };
  }
  if (!isForgenMcpEntry(parsed.mcp?.[MCP_SERVER_NAME])) return { content: currentText, removed: false, unparseable: false };
  const opts = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  let out = applyEdits(currentText, modify(currentText, ['mcp', MCP_SERVER_NAME], undefined, opts));
  if (Object.keys(parsed.mcp ?? {}).length === 1) out = applyEdits(out, modify(out, ['mcp'], undefined, opts));

  // 쓰기 전 검증: forgen 항목만 사라지고 다른 키/서버는 그대로여야 한다. (중복 `mcp` 키 같은 퇴화 입력에서
  // 편집기가 다른 객체를 건드릴 수 있다 — 그러면 아무것도 쓰지 않는다.)
  const after = parseJsonc(out, [], { allowTrailingComma: true }) as { mcp?: Record<string, unknown> } | undefined;
  const expected = JSON.parse(JSON.stringify(parsed)) as { mcp?: Record<string, unknown> };
  if (expected.mcp) {
    delete expected.mcp[MCP_SERVER_NAME];
    if (Object.keys(expected.mcp).length === 0) delete expected.mcp;
  }
  if (JSON.stringify(after) !== JSON.stringify(expected)) return { content: currentText, removed: false, unparseable: true };
  return { content: out, removed: true, unparseable: false };
}

/**
 * plugin 파일이 forgen 것인가: **첫 줄**이 `// forgen-managed` 로 시작해야 한다 (배포 자산의 형태).
 * 본문 어딘가에 문자열이 있다는 것만으로는 소유로 보지 않는다 (`// NOT forgen-managed: my fork` 같은 사용자 파일 보호).
 */
function isManagedPlugin(content: string): boolean {
  return content.split('\n', 1)[0].trimStart().startsWith(`// ${PLUGIN_MARKER}`);
}

export function planOpencodeUninstall(opts: OpencodeUninstallOptions): OpencodeUninstallResult {
  const configDir = resolveOpencodeConfigDir({ pkgRoot: opts.pkgRoot, opencodeConfigDir: opts.opencodeConfigDir });
  const dryRun = opts.dryRun ?? false;
  const result: OpencodeUninstallResult = {
    configDir,
    present: fs.existsSync(configDir),
    pluginRemoved: false,
    pluginRestoredFromBackup: false,
    mcpRemoved: false,
    mcpSkippedUnparseable: false,
    agentsMdCleanedPaths: [],
    errors: [],
  };
  if (!result.present) return result;
  const step = (label: string, fn: () => void): void => {
    try { fn(); } catch (e) { result.errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  // 1) plugin — forgen-managed 마커가 있는 것만. 설치가 백업한 사용자 plugin 이 있으면 되돌린다.
  step('plugin', () => {
    const pluginPath = path.join(configDir, 'plugins', PLUGIN_FILENAME);
    if (!fs.existsSync(pluginPath)) return;
    if (fs.lstatSync(pluginPath).isSymbolicLink() || !isManagedPlugin(fs.readFileSync(pluginPath, 'utf-8'))) return;
    const bak = `${pluginPath}.bak`;
    result.pluginRemoved = true;
    // `.bak` 은 설치가 사용자 plugin 을 백업한 것일 때만 되돌린다 — forgen-managed 내용이면 사용자 원본이 아니다.
    result.pluginRestoredFromBackup = fs.existsSync(bak) && !isManagedPlugin(fs.readFileSync(bak, 'utf-8'));
    if (dryRun) return;
    if (result.pluginRestoredFromBackup) fs.renameSync(bak, pluginPath);
    else fs.unlinkSync(pluginPath);
  });

  // 2) MCP — opencode.jsonc 와 opencode.json 둘 다 본다 (설치 후에 .jsonc 가 생겼을 수 있다)
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    step(name, () => {
      const configPath = path.join(configDir, name);
      if (!fs.existsSync(configPath)) return;
      const current = fs.readFileSync(configPath, 'utf-8');
      const r = removeOpencodeMcp(current);
      if (r.removed) result.mcpRemoved = true;
      if (r.unparseable) result.mcpSkippedUnparseable = true;
      if (!dryRun && r.removed) fs.writeFileSync(configPath, r.content, 'utf-8');
    });
  }

  // 3) AGENTS.md — 설치 때 기록된 프로젝트 전부 + 지금의 cwd
  step('AGENTS.md', () => {
    const cwdAgentsMdPath = opts.agentsMdPath ?? resolveAgentsMdPath(opts.pkgRoot);
    const r = removeForgenRulesEverywhere({ hostDir: configDir, cwdAgentsMdPath, dryRun });
    result.agentsMdCleanedPaths = r.cleaned;
    for (const f of r.failed) result.errors.push(`AGENTS.md ${f.path}: ${f.error} (kept in the install record — fix and re-run uninstall)`);
  });

  return result;
}

export function renderOpencodeUninstall(r: OpencodeUninstallResult): string[] {
  if (!r.present) return [];
  const lines: string[] = [];
  if (r.pluginRemoved) {
    lines.push(r.pluginRestoredFromBackup
      ? '  ✓ Removed forgen OpenCode plugin and restored your original plugins/forgen.ts from the install-time backup'
      : '  ✓ Removed forgen OpenCode plugin (plugins/forgen.ts)');
  }
  if (r.mcpRemoved) lines.push('  ✓ Removed forgen-compound MCP entry from the OpenCode config');
  if (r.mcpSkippedUnparseable) lines.push('  ⚠ OpenCode config is not valid JSONC — left untouched (remove mcp.forgen-compound by hand)');
  if (r.agentsMdCleanedPaths.length > 0) lines.push(`  ✓ Removed forgen block from ${r.agentsMdCleanedPaths.length} AGENTS.md file(s) (OpenCode installs)`);
  for (const e of r.errors) lines.push(`  ✗ OpenCode cleanup — ${e}`);
  return lines;
}
