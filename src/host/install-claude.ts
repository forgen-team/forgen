/**
 * Claude InstallPlan — feat/codex-support Phase 1 (P1-2)
 *
 * `npm install` postinstall.js 의 *Claude 측* 5 작업을 module 로 분리.
 * `forgen install claude` CLI 가 호출 + (P1-6 에서) postinstall.js 도 위임.
 *
 * 5 작업:
 *   1. Plugin cache: ~/.claude/plugins/cache/forgen-local/forgen/<ver>/ 작성 + installed_plugins.json 등록
 *   2. Slash commands: ~/.claude/commands/forgen/*.md 생성 (forgen-managed marker)
 *   3. Settings hooks injection: ~/.claude/settings.json 의 hooks 머지 (forgen entry idempotent)
 *   4. MCP register: ~/.claude.json 에 mcpServers.forgen-compound 추가
 *   5. Dev-guide skills: ~/.claude/skills/forgen-<stack>-<skill>/ 설치 (forgen-managed only)
 *
 * 사용자 비-forgen 자산 보존 + 재실행 idempotent.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateHooksJson } from '../hooks/hooks-generator.js';

export interface ClaudeInstallOptions {
  pkgRoot: string;
  /** Override home dir (default: os.homedir()). 격리 테스트용. */
  homeDir?: string;
  /** Dry-run: 파일 미작성, 결과만 반환. */
  dryRun?: boolean;
  /** MCP forgen-compound 등록 여부 (default true). */
  registerMcp?: boolean;
}

export interface ClaudeInstallResult {
  homeDir: string;
  pluginCachePath: string;
  pluginCacheWritten: boolean;
  slashCommandsPath: string;
  slashCommandsCount: number;
  settingsPath: string;
  hooksInjected: number;
  mcpRegistered: boolean;
  mcpAlreadyPresent: boolean;
  skillsPath: string;
  skillsInstalled: number;
  skillsRemoved: number;
}

const PLUGIN_KEY = 'forgen@forgen-local';
const FORGEN_MANAGED_MARKER = '<!-- forgen-managed -->';

function readPkgVersion(pkgRoot: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ── 1. Plugin cache ────────────────────────────────────────────────────

function writePluginCache(opts: { pkgRoot: string; cacheDir: string; pluginsDir: string; version: string; dryRun: boolean }): boolean {
  const { pkgRoot, cacheDir, pluginsDir, version, dryRun } = opts;
  if (dryRun) return false;

  const cacheParent = path.dirname(cacheDir);
  // 이전 잔재 제거 + 디렉토리 작성
  try { fs.rmSync(cacheParent, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(cacheParent, { recursive: true });

  // 1차: symlink 시도 (개발 환경)
  // Why warn on fallback: Windows 비관리자 / macOS SIP 환경에서 symlink 가 EPERM
  //   으로 거부되면 조용히 cpSync 폴백을 탔는데, 사용자는 "왜 install 이 느리지"
  //   를 알 길이 없었다. 폴백 진입을 stderr 로 알려서 진단성 확보.
  let linked = false;
  let symlinkErr: unknown = null;
  try {
    fs.symlinkSync(pkgRoot, cacheDir, 'dir');
    linked = true;
  } catch (e) {
    symlinkErr = e;
  }
  if (!linked && symlinkErr) {
    const code = (symlinkErr as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    process.stderr.write(
      `[forgen] symlink ${pkgRoot} → ${cacheDir} failed (${code}); falling back to cpSync.\n`,
    );
  }

  if (!linked) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const copyDirs = ['.claude-plugin', 'hooks', 'skills', 'assets'];
    for (const dir of copyDirs) {
      const src = path.join(pkgRoot, dir);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(cacheDir, dir), { recursive: true });
    }
    if (fs.existsSync(path.join(pkgRoot, 'dist'))) {
      fs.cpSync(path.join(pkgRoot, 'dist'), path.join(cacheDir, 'dist'), { recursive: true });
    }
    // core deps
    const coreDeps = ['js-yaml', '@modelcontextprotocol', 'zod'];
    fs.mkdirSync(path.join(cacheDir, 'node_modules'), { recursive: true });
    for (const dep of coreDeps) {
      const depSrc = path.join(pkgRoot, 'node_modules', dep);
      if (fs.existsSync(depSrc)) {
        fs.cpSync(depSrc, path.join(cacheDir, 'node_modules', dep), { recursive: true });
      }
    }
  }

  // installed_plugins.json 등록
  const installedPath = path.join(pluginsDir, 'installed_plugins.json');
  let installed: { version: number; plugins: Record<string, Array<unknown>> } = { version: 2, plugins: {} };
  if (fs.existsSync(installedPath)) {
    try { installed = JSON.parse(fs.readFileSync(installedPath, 'utf-8')); } catch { /* ignore */ }
  }
  installed.plugins = installed.plugins ?? {};
  installed.plugins[PLUGIN_KEY] = [{
    scope: 'user',
    installPath: cacheDir,
    version,
    installedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  }];
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(installedPath, `${JSON.stringify(installed, null, 2)}\n`);
  return true;
}

// ── 2. Slash commands ──────────────────────────────────────────────────

/** Build-time injected --with-codex shared snippet. Mirror of scripts/copy-assets.js. */
const WITH_CODEX_SNIPPET = `

---

## \`--with-codex\` flag (cross-model review)

If \`$ARGUMENTS\` contains any of \`--with-codex\`, \`--코덱스\`, \`with codex\`, \`코덱스 검토\`, \`코덱스로 검토\`,
then after completing the primary skill work, perform a cross-model review pass:

1. Save your primary output text to a temp file (e.g., \`/tmp/forgen-with-codex-$(date +%s).md\`).
2. Invoke codex via Bash:
   \`\`\`bash
   codex exec --json --ignore-user-config --ignore-rules --ephemeral \\
     -s read-only -c approval_policy="never" --skip-git-repo-check \\
     "$(printf 'You are a second-opinion reviewer for another AI assistant\\\\u0027s output. Read the work product below and report ONLY:\\n1. Defects, gaps, or risks the original work missed\\n2. Specific disagreements with the original\\n3. Topics that should have been covered but were not\\n\\nOutput format: prioritized bullet list (max 15 items, severity-sorted, no prose intro). If you find nothing material, say "No critical issues found."\\n\\n<work>\\n%s\\n</work>' "$(cat /tmp/forgen-with-codex-*.md)")"
   \`\`\`
3. Append the codex output under heading \`## Codex Cross-Review (--with-codex)\` in your final response.
4. If codex flags critical issues, briefly acknowledge + suggest follow-up.
5. If \`codex: command not found\`, note in response and skip the review pass (do not fail).

OPT-IN per invocation. Without the flag, skip this entire section.
`;

function writeSlashCommands(opts: { pkgRoot: string; targetDir: string; dryRun: boolean }): number {
  const { pkgRoot, targetDir, dryRun } = opts;
  const sourceDir = path.join(pkgRoot, 'assets', 'claude', 'commands');
  if (!fs.existsSync(sourceDir)) return 0;
  if (dryRun) {
    return fs.readdirSync(sourceDir).filter((f) => f.endsWith('.md')).length;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  let count = 0;
  for (const file of fs.readdirSync(sourceDir).filter((f) => f.endsWith('.md'))) {
    const skillContent = fs.readFileSync(path.join(sourceDir, file), 'utf-8');
    const descMatch = skillContent.match(/description:\s*(.+)/);
    const desc = descMatch?.[1]?.trim() ?? file.replace(/\.md$/, '');
    const skillName = file.replace(/\.md$/, '');
    const out = `# ${desc}\n\n${FORGEN_MANAGED_MARKER}\n\nActivate Forgen "${skillName}" mode for the task: $ARGUMENTS\n\n${skillContent}${WITH_CODEX_SNIPPET}`;
    const target = path.join(targetDir, file);
    if (fs.existsSync(target)) {
      const existing = fs.readFileSync(target, 'utf-8');
      if (!existing.includes(FORGEN_MANAGED_MARKER)) continue; // 사용자 작성 — skip
    }
    fs.writeFileSync(target, out);
    count += 1;
  }
  return count;
}

// ── 3. Settings hooks injection ────────────────────────────────────────

function injectHooksIntoSettings(opts: { pkgRoot: string; settingsPath: string; dryRun: boolean }): number {
  const { pkgRoot, settingsPath, dryRun } = opts;
  // settings.json 컨텍스트는 ${CLAUDE_PLUGIN_ROOT} 미해석 — 절대 경로 박제 (postinstall.js 와 동일 노하우)
  const generated = generateHooksJson({
    pluginRoot: path.join(pkgRoot, 'dist'),
    runtime: 'claude',
    releaseMode: true,
  });
  let count = 0;
  for (const events of Object.values(generated.hooks)) {
    for (const group of events) {
      const g = group as { hooks?: unknown[] };
      if (Array.isArray(g.hooks)) count += g.hooks.length;
    }
  }
  if (dryRun) return count;

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { /* fallthrough */ }
  }

  const hooksConfig = (settings.hooks as Record<string, unknown[]>) ?? {};
  // 기존 forgen hook 제거 (path 에 pkgRoot 또는 CLAUDE_PLUGIN_ROOT 포함된 entry)
  for (const [event, entries] of Object.entries(hooksConfig)) {
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter((entry) => {
      const e = entry as { hooks?: Array<{ command?: string }> };
      if (!Array.isArray(e.hooks)) return true;
      // forgen-managed entry 식별: pkgRoot 또는 CLAUDE_PLUGIN_ROOT 또는 'forgen' 포함
      return !e.hooks.some(
        (h) => typeof h.command === 'string' &&
          (h.command.includes(pkgRoot) || h.command.includes('CLAUDE_PLUGIN_ROOT') || h.command.includes('/forgen-local/forgen/')),
      );
    });
    if (filtered.length === 0) delete hooksConfig[event];
    else hooksConfig[event] = filtered;
  }
  // forgen 측 entry 추가
  for (const [event, entries] of Object.entries(generated.hooks)) {
    if (!hooksConfig[event]) hooksConfig[event] = [];
    (hooksConfig[event] as unknown[]).push(...entries);
  }
  settings.hooks = hooksConfig;

  // enabledPlugins 등록
  const enabled = (settings.enabledPlugins as Record<string, boolean>) ?? {};
  enabled[PLUGIN_KEY] = true;
  settings.enabledPlugins = enabled;

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return count;
}

// ── 4. MCP register ────────────────────────────────────────────────────

interface McpRegisterOutcome {
  registered: boolean;
  alreadyPresent: boolean;
}

function registerMcpInClaudeJson(opts: { pkgRoot: string; claudeJsonPath: string; dryRun: boolean }): McpRegisterOutcome {
  const { pkgRoot, claudeJsonPath, dryRun } = opts;
  const serverPath = path.join(pkgRoot, 'dist', 'mcp', 'server.js');
  const desired = { command: 'node', args: [serverPath] };

  let claudeJson: Record<string, unknown> = {};
  if (fs.existsSync(claudeJsonPath)) {
    try { claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')); } catch { /* ignore */ }
  }
  const mcpServers = (claudeJson.mcpServers as Record<string, unknown>) ?? {};
  const existing = mcpServers['forgen-compound'] as Record<string, unknown> | undefined;
  const alreadyPresent =
    existing !== undefined &&
    existing.command === 'node' &&
    Array.isArray((existing as { args?: unknown }).args) &&
    JSON.stringify((existing as { args: unknown[] }).args) === JSON.stringify(desired.args);

  if (dryRun) {
    return { registered: !alreadyPresent, alreadyPresent };
  }

  mcpServers['forgen-compound'] = desired;
  claudeJson.mcpServers = mcpServers;
  fs.mkdirSync(path.dirname(claudeJsonPath), { recursive: true });
  fs.writeFileSync(claudeJsonPath, `${JSON.stringify(claudeJson, null, 2)}\n`);
  return { registered: !alreadyPresent, alreadyPresent };
}

// ── 5. Dev-guide skills ────────────────────────────────────────────────

const FORGEN_SKILL_PREFIX = 'forgen-';

interface SkillsInstallOutcome {
  skillsPath: string;
  skillsInstalled: number;
  skillsRemoved: number;
}

function installDevGuideSkills(opts: { pkgRoot: string; skillsDir: string; dryRun: boolean }): SkillsInstallOutcome {
  const { pkgRoot, skillsDir, dryRun } = opts;
  const devGuideRoot = path.join(pkgRoot, 'assets', 'dev-guide');

  // Collect all SKILL.md entries: assets/dev-guide/{tier}/skills/{stack}/{skill}/SKILL.md
  const entries: Array<{ name: string; src: string }> = [];
  if (fs.existsSync(devGuideRoot)) {
    for (const tier of fs.readdirSync(devGuideRoot)) {
      const skillsBase = path.join(devGuideRoot, tier, 'skills');
      if (!fs.existsSync(skillsBase)) continue;
      for (const stack of fs.readdirSync(skillsBase)) {
        const stackDir = path.join(skillsBase, stack);
        if (!fs.statSync(stackDir).isDirectory()) continue;
        for (const skill of fs.readdirSync(stackDir)) {
          const skillMd = path.join(stackDir, skill, 'SKILL.md');
          if (fs.existsSync(skillMd)) {
            entries.push({ name: `${FORGEN_SKILL_PREFIX}${stack}-${skill}`, src: skillMd });
          }
        }
      }
    }
  }

  if (dryRun) {
    return { skillsPath: skillsDir, skillsInstalled: entries.length, skillsRemoved: 0 };
  }

  fs.mkdirSync(skillsDir, { recursive: true });

  // Remove stale forgen-* skill dirs (idempotent re-install, do not touch user's own skills)
  let removed = 0;
  for (const entry of fs.readdirSync(skillsDir)) {
    if (!entry.startsWith(FORGEN_SKILL_PREFIX)) continue;
    const fullPath = path.join(skillsDir, entry);
    if (fs.statSync(fullPath).isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed += 1;
    }
  }

  // Install each skill via symlink → cpSync fallback (mirrors plugin cache pattern)
  let installed = 0;
  for (const { name, src } of entries) {
    const targetDir = path.join(skillsDir, name);
    fs.mkdirSync(targetDir, { recursive: true });
    const targetFile = path.join(targetDir, 'SKILL.md');

    let linked = false;
    let symlinkErr: unknown = null;
    try {
      fs.symlinkSync(src, targetFile, 'file');
      linked = true;
    } catch (e) {
      symlinkErr = e;
    }
    if (!linked && symlinkErr) {
      const code = (symlinkErr as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      process.stderr.write(
        `[forgen] symlink ${src} → ${targetFile} failed (${code}); falling back to copyFile.\n`,
      );
    }
    if (!linked) {
      fs.copyFileSync(src, targetFile);
    }
    installed += 1;
  }

  return { skillsPath: skillsDir, skillsInstalled: installed, skillsRemoved: removed };
}

// ── public ─────────────────────────────────────────────────────────────

export function planClaudeInstall(opts: ClaudeInstallOptions): ClaudeInstallResult {
  if (!opts.pkgRoot || !fs.existsSync(opts.pkgRoot)) {
    throw new Error(`planClaudeInstall: invalid pkgRoot ${opts.pkgRoot}`);
  }
  const homeDir = opts.homeDir ?? os.homedir();
  const dryRun = opts.dryRun ?? false;
  const registerMcp = opts.registerMcp ?? true;
  const version = readPkgVersion(opts.pkgRoot);

  const claudeDir = path.join(homeDir, '.claude');
  const pluginsDir = path.join(claudeDir, 'plugins');
  const cacheDir = path.join(pluginsDir, 'cache', 'forgen-local', 'forgen', version);
  const slashCommandsDir = path.join(claudeDir, 'commands', 'forgen');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const claudeJsonPath = path.join(homeDir, '.claude.json');
  const skillsDir = path.join(claudeDir, 'skills');

  const pluginCacheWritten = writePluginCache({ pkgRoot: opts.pkgRoot, cacheDir, pluginsDir, version, dryRun });
  const slashCommandsCount = writeSlashCommands({ pkgRoot: opts.pkgRoot, targetDir: slashCommandsDir, dryRun });
  const hooksInjected = injectHooksIntoSettings({ pkgRoot: opts.pkgRoot, settingsPath, dryRun });
  const mcp = registerMcp
    ? registerMcpInClaudeJson({ pkgRoot: opts.pkgRoot, claudeJsonPath, dryRun })
    : { registered: false, alreadyPresent: false };
  const skills = installDevGuideSkills({ pkgRoot: opts.pkgRoot, skillsDir, dryRun });

  return {
    homeDir,
    pluginCachePath: cacheDir,
    pluginCacheWritten,
    slashCommandsPath: slashCommandsDir,
    slashCommandsCount,
    settingsPath,
    hooksInjected,
    mcpRegistered: mcp.registered,
    mcpAlreadyPresent: mcp.alreadyPresent,
    skillsPath: skills.skillsPath,
    skillsInstalled: skills.skillsInstalled,
    skillsRemoved: skills.skillsRemoved,
  };
}
