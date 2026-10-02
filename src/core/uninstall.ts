import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hasManagedSkillMarker, listDevGuideSkillNames, removeSkillFile } from '../host/managed-marker.js';
import {
  SETTINGS_PATH,
  acquireLock,
  releaseLock,
  atomicWriteFileSync,
} from './settings-lock.js';
/** 플러그인 제거 (plugin-installer.ts 삭제 후 인라인) */
function uninstallPlugin(): boolean {
  const pluginDir = path.join(os.homedir(), '.claude', 'plugins', 'forgen');
  try {
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (Array.isArray(settings.plugins)) {
        settings.plugins = (settings.plugins as string[]).filter(p => !p.includes('forgen'));
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** 플러그인 관련 아티팩트 정리 */
function cleanPluginArtifacts(): void {
  const claudeDir = path.join(os.homedir(), '.claude');
  const pluginsDir = path.join(claudeDir, 'plugins');

  // 1. ~/.claude/plugins/cache/forgen-local/ 삭제
  try {
    const cacheDir = path.join(pluginsDir, 'cache', 'forgen-local');
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      console.log('  ✓ Removed plugin cache (~/.claude/plugins/cache/forgen-local/)');
    }
  } catch (e) {
    console.error('  ✗ Failed to remove plugin cache:', e instanceof Error ? e.message : String(e));
  }

  // 2. ~/.claude/plugins/installed_plugins.json에서 forgen@forgen-local 제거
  try {
    const installedPluginsPath = path.join(pluginsDir, 'installed_plugins.json');
    if (fs.existsSync(installedPluginsPath)) {
      const data = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf-8'));
      if (data.plugins && 'forgen@forgen-local' in data.plugins) {
        delete data.plugins['forgen@forgen-local'];
        fs.writeFileSync(installedPluginsPath, JSON.stringify(data, null, 2));
        console.log('  ✓ Removed forgen@forgen-local from installed_plugins.json');
      }
    }
  } catch (e) {
    console.error('  ✗ Failed to update installed_plugins.json:', e instanceof Error ? e.message : String(e));
  }

  // 3. ~/.claude/plugins/forgen/ 삭제 (plugin-installer 경로)
  try {
    const removed = uninstallPlugin();
    if (removed) {
      console.log('  ✓ Removed plugin directory (~/.claude/plugins/forgen/)');
    }
  } catch (e) {
    console.error('  ✗ Failed to remove plugin directory:', e instanceof Error ? e.message : String(e));
  }
}

/** ~/.claude/commands/forgen/ 슬래시 명령 파일 제거 */
function cleanSlashCommands(): void {
  const commandsDir = path.join(os.homedir(), '.claude', 'commands', 'forgen');
  if (!fs.existsSync(commandsDir)) {
    console.log('  - No slash command directory found');
    return;
  }

  let removed = 0;
  for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md'))) {
    const filePath = path.join(commandsDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.includes('<!-- forgen-managed -->')) {
      fs.unlinkSync(filePath);
      removed++;
    }
  }

  // 디렉토리가 비었으면 삭제
  try {
    const remaining = fs.readdirSync(commandsDir);
    if (remaining.length === 0) {
      fs.rmdirSync(commandsDir);
    }
  } catch { /* ignore */ }

  if (removed > 0) {
    console.log(`  ✓ Removed ${removed} slash command(s) (~/.claude/commands/forgen/)`);
  } else {
    console.log('  - No forgen-managed slash commands found');
  }
}

/** ADR-016 D3 — ~/.claude/skills/verify 제거 (forgen-managed 마커가 있는 것만; 사용자 스킬은 보존) */
export function cleanVerifySkill(homeDir: string = os.homedir()): boolean {
  const dir = path.join(homeDir, '.claude', 'skills', 'verify');
  const file = path.join(dir, 'SKILL.md');
  try {
    if (fs.lstatSync(dir).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink()) return false;
    if (!hasManagedSkillMarker(fs.readFileSync(file, 'utf-8'))) return false;
    fs.unlinkSync(file);
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* ignore */ }
    return true;
  } catch {
    return false; // 없음
  }
}

/**
 * ADR-016 D4 — `~/.claude/skills/forgen-<stack>-<skill>/` dev-guide 스킬 제거.
 * 패키지가 실제로 제공하는 이름만 지운다 (사용자가 만든 `forgen-react-mine` 같은 스킬은 보존).
 */
export function cleanDevGuideSkills(pkgRoot: string, homeDir: string = os.homedir()): number {
  const skillsDir = path.join(homeDir, '.claude', 'skills');
  let removed = 0;
  for (const name of listDevGuideSkillNames(pkgRoot)) {
    if (removeSkillFile(skillsDir, name, false)) removed += 1;
  }
  return removed;
}

/**
 * ADR-016 D4 — `~/.claude.json` 의 `mcpServers["forgen-compound"]` 제거. install 은 settings.json 이 아니라
 * 여기에 등록하는데 uninstall 은 settings.json 만 정리하고 있었다. forgen 서버 경로를 가리킬 때만 지운다.
 */
export function cleanClaudeJsonMcp(homeDir: string = os.homedir()): boolean {
  const claudeJsonPath = path.join(homeDir, '.claude.json');
  try {
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as { mcpServers?: Record<string, { args?: unknown }> };
    const entry = data.mcpServers?.['forgen-compound'];
    if (!entry) return false;
    const args = Array.isArray(entry.args) ? entry.args : [];
    const isForgenServer = args.some((a) => typeof a === 'string' && /[\\/]dist[\\/]mcp[\\/]server\.js$/.test(a));
    if (!isForgenServer) return false; // 사용자가 같은 이름으로 다른 서버를 등록
    delete data.mcpServers?.['forgen-compound'];
    if (data.mcpServers && Object.keys(data.mcpServers).length === 0) delete data.mcpServers;
    atomicWriteFileSync(claudeJsonPath, `${JSON.stringify(data, null, 2)}\n`);
    return true;
  } catch {
    return false; // 파일 없음 / 파싱 실패 — 건드리지 않는다
  }
}

/** 사용자에게 y/n 확인 */
function confirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${message} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

/** settings.json에서 CH 관련 항목 제거 */
function cleanSettings(): void {
  if (!fs.existsSync(SETTINGS_PATH)) return;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    console.error('[forgen] Failed to parse settings.json — skipping.');
    return;
  }

  // Audit fix #7 (2026-04-21): env 정리가 `COMPOUND_` 접두어만 검사해서
  // install이 주입한 `FORGEN_*` 키(예: FORGEN_HARNESS, FORGEN_CWD)가
  // uninstall 후에도 settings.json에 영구 잔존했다. 이제 둘 다 정리.
  const env = settings.env as Record<string, string> | undefined;
  if (env) {
    for (const key of Object.keys(env)) {
      if (key.startsWith('COMPOUND_') || key.startsWith('FORGEN_')) delete env[key];
    }
    if (Object.keys(env).length === 0) {
      delete settings.env;
    }
  }

  // hooks에서 forgen 관련 엔트리 제거
  const hookMarkers = ['forgen', 'compound-harness'];
  function isCHCommand(cmd: string): boolean {
    return hookMarkers.some(m => cmd.includes(m));
  }
  function isCHHookEntry(entry: Record<string, unknown>): boolean {
    // 직접 형식: { type, command }
    if (typeof entry.command === 'string' && isCHCommand(entry.command)) return true;
    // 래핑 형식: { matcher, hooks: [{ command }] }
    const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(innerHooks)) {
      return innerHooks.some(h => typeof h.command === 'string' && isCHCommand(h.command));
    }
    return false;
  }

  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (hooks) {
    for (const [hookType, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;
      const filtered = entries.filter(
        (h) => !isCHHookEntry(h as Record<string, unknown>)
      );
      if (filtered.length === 0) {
        delete hooks[hookType];
      } else {
        hooks[hookType] = filtered;
      }
    }
    if (Object.keys(hooks).length === 0) {
      delete settings.hooks;
    }
  }

  // statusLine이 forgen이 설치한 command 중 하나면 제거.
  //
  // Audit fix #7 (2026-04-21): 이전 체크는 `'forgen status'`만 인식했지만
  // 실제 install은 `settings-injector.ts:59`에서 `'forgen me'`를 주입한다.
  // command 문자열이 `forgen`으로 시작하는 경우를 모두 forgen 소유로 보고
  // 제거 — 사용자 커스텀 statusLine(예: `custom-cli ...`)은 건드리지 않음.
  const statusLine = settings.statusLine as Record<string, unknown> | undefined;
  if (
    typeof statusLine?.command === 'string' &&
    /^forgen(\s|$)/.test(statusLine.command.trim())
  ) {
    delete settings.statusLine;
  }

  // enabledPlugins에서 forgen@forgen-local 제거
  const enabledPlugins = settings.enabledPlugins as Record<string, unknown> | undefined;
  if (enabledPlugins && 'forgen@forgen-local' in enabledPlugins) {
    delete enabledPlugins['forgen@forgen-local'];
    if (Object.keys(enabledPlugins).length === 0) {
      delete settings.enabledPlugins;
    }
  }

  // mcpServers에서 forgen-compound 제거
  const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
  if (mcpServers && 'forgen-compound' in mcpServers) {
    delete mcpServers['forgen-compound'];
    if (Object.keys(mcpServers).length === 0) {
      delete settings.mcpServers;
    }
  }

  acquireLock();
  try {
    atomicWriteFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } finally {
    releaseLock();
  }
  console.log('  ✓ Removed CH entries from settings.json');
}

/** 프로젝트 .claude/agents/ch-*.md 삭제 (커스터마이즈된 파일은 보호) */
function cleanAgents(cwd: string): void {
  const agentsDir = path.join(cwd, '.claude', 'agents');
  if (!fs.existsSync(agentsDir)) return;

  let removed = 0;
  let preserved = 0;
  for (const file of fs.readdirSync(agentsDir)) {
    if (file.startsWith('ch-') && file.endsWith('.md')) {
      const filePath = path.join(agentsDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      if (!content.includes('<!-- forgen-managed -->')) {
        // 사용자가 커스터마이즈한 파일 → 보존
        preserved++;
        continue;
      }
      fs.unlinkSync(filePath);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`  ✓ Removed ${removed} agent file(s) (.claude/agents/ch-*.md)`);
  }
  if (preserved > 0) {
    console.log(`  ⚠ Preserved ${preserved} customized agent file(s) (manual deletion required)`);
  }
  if (removed === 0 && preserved === 0) {
    console.log('  - No agent files found');
  }
}

/** .claude/rules/ 의 forgen 규칙 파일 및 레거시 compound-rules.md 제거 */
function cleanCompoundRules(cwd: string): void {
  const ruleFiles = [
    // v4.1+ consolidated
    'project-context.md',
    'routing.md',
    // v0.5.0+ project-scoped (ADR-010 W1-3)
    'v1-rules.md',
    'forge-behavioral.md',
    'user-profile.md',
    // legacy (v4.0 and earlier)
    'security.md',
    'golden-principles.md',
    'anti-pattern.md',
    'compound.md',
  ];
  const rulesDir = path.join(cwd, '.claude', 'rules');
  let removedCount = 0;

  for (const file of ruleFiles) {
    const p = path.join(rulesDir, file);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      removedCount++;
    }
  }

  // 레거시 경로
  const legacyPath = path.join(cwd, '.claude', 'compound-rules.md');
  if (fs.existsSync(legacyPath)) {
    fs.unlinkSync(legacyPath);
    removedCount++;
  }

  // 레거시 글로벌 사이드채널 (ADR-010 W1-3 이전 버전이 ~/.claude/rules/ 에 씀).
  // 새 세션이 열리기 전에 uninstall 하는 경우 harness 마이그레이션이 못 지우므로
  // 여기서도 회수한다 — 방치 시 언인스톨 후에도 전 세션에 주입된다.
  const legacyGlobalBehavioral = path.join(os.homedir(), '.claude', 'rules', 'forge-behavioral.md');
  if (fs.existsSync(legacyGlobalBehavioral)) {
    fs.unlinkSync(legacyGlobalBehavioral);
    removedCount++;
  }

  if (removedCount > 0) {
    console.log(`  ✓ Removed ${removedCount} rule file(s)`);
  } else {
    console.log('  - No rule files found');
  }
}

/** CLAUDE.md에서 forgen 블록 제거 */
function cleanClaudeMd(cwd: string): void {
  const claudeMdPath = path.join(cwd, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) return;

  const content = fs.readFileSync(claudeMdPath, 'utf-8');
  const marker = '<!-- forgen:start -->';
  const endMarker = '<!-- forgen:end -->';

  if (!content.includes(marker)) {
    console.log('  - No CH block found in CLAUDE.md');
    return;
  }

  const regex = new RegExp(`\\n?${marker}[\\s\\S]*?${endMarker}\\n?`, 'g');
  const cleaned = content.replace(regex, '\n');
  fs.writeFileSync(claudeMdPath, `${cleaned.replace(/\n{3,}/g, '\n\n').trim()}\n`);
  console.log('  ✓ Removed CH block from CLAUDE.md');
}

/** forgen uninstall 메인 */
export async function handleUninstall(cwd: string, options: { force?: boolean; purge?: boolean }): Promise<void> {
  console.log('\n[forgen] Uninstalling Forgen\n');
  console.log('The following items will be cleaned up:');
  console.log('  1. Remove CH env vars/hooks/statusLine/enabledPlugins from ~/.claude/settings.json');
  console.log('  2. Delete .claude/agents/ch-*.md agent files');
  console.log('  3. Delete .claude/rules/ rule files (project-context, routing, forge-*)');
  console.log('  4. Remove forgen block from CLAUDE.md');
  console.log('  5. Remove slash commands (~/.claude/commands/forgen/) and the forgen-managed verify skill (~/.claude/skills/verify/)');
  console.log('  6. Remove plugin artifacts (cache, installed_plugins.json, plugin directory), dev-guide skills, and the forgen-compound MCP entry in ~/.claude.json');
  console.log('  7. Codex (if $CODEX_HOME or ~/.codex exists): forgen hooks in hooks.json, the MCP/notify blocks in config.toml, forgen skills, ch-*.toml agents, and the AGENTS.md blocks (every project recorded at install time) — hooks and files from other tools are kept');
  console.log('     OpenCode (if its config dir exists): the forgen plugin, the forgen-compound MCP entry, AGENTS.md blocks');
  if (options.purge) {
    console.log('  8. --purge: Delete ~/.forgen/ entirely (rules, me/, state/, solutions/, behavior/)');
    console.log('     WARNING: this erases all accumulated corrections, rules, drift, and lifecycle history.');
  } else {
    console.log('');
    console.log('Note: ~/.forgen/ directory is preserved. Use --purge to also delete it.');
    console.log('      (manual: rm -rf ~/.forgen)');
  }
  console.log('');

  if (!options.force) {
    if (!process.stdin.isTTY) {
      console.error('[forgen] Use --force flag in non-interactive environments.');
      process.exit(1);
    }
    const ok = await confirm('Do you want to continue?');
    if (!ok) {
      console.log('Cancelled.');
      return;
    }
    console.log('');
  }

  cleanSettings();
  cleanAgents(cwd);
  cleanCompoundRules(cwd);
  cleanClaudeMd(cwd);
  cleanSlashCommands();
  if (cleanVerifySkill()) console.log('  ✓ Removed forgen verify skill (~/.claude/skills/verify/)');
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const devGuide = cleanDevGuideSkills(pkgRoot);
  if (devGuide > 0) console.log(`  ✓ Removed ${devGuide} dev-guide skill(s) (~/.claude/skills/forgen-*)`);
  if (cleanClaudeJsonMcp()) console.log('  ✓ Removed forgen-compound MCP server from ~/.claude.json');
  // ADR-016 D4 — Codex 에 등록한 것도 되돌린다 (다른 도구의 훅과 그 신뢰는 보존)
  try {
    const { planCodexUninstall, renderCodexUninstall } = await import('../host/uninstall-codex.js');
    for (const line of renderCodexUninstall(planCodexUninstall({ pkgRoot }))) console.log(line);
  } catch (e) {
    console.error('  ✗ Codex cleanup failed:', e instanceof Error ? e.message : String(e));
  }
  try {
    const { planOpencodeUninstall, renderOpencodeUninstall } = await import('../host/uninstall-opencode.js');
    for (const line of renderOpencodeUninstall(planOpencodeUninstall({ pkgRoot }))) console.log(line);
  } catch (e) {
    console.error('  ✗ OpenCode cleanup failed:', e instanceof Error ? e.message : String(e));
  }
  cleanPluginArtifacts();

  if (options.purge) {
    try {
      const { FORGEN_HOME } = await import('./paths.js');
      const forgenHome = FORGEN_HOME;
      if (fs.existsSync(forgenHome)) {
        fs.rmSync(forgenHome, { recursive: true, force: true });
        console.log('  ✓ Deleted ~/.forgen/ (all rules, state, solutions, behavior)');
      } else {
        console.log('  ✓ ~/.forgen/ already absent');
      }
    } catch (e) {
      console.log(`  ✗ ~/.forgen/ deletion failed: ${(e as Error).message}`);
    }
  }

  console.log('\n[forgen] Uninstall complete. Restart Claude Code (and Codex) for a clean state.\n');
}
