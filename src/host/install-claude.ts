/**
 * Claude InstallPlan — `forgen install claude` 와 npm postinstall 이 공유하는 단일 설치 경로 (D1 설치 일원화).
 *
 * 작업:
 *   1. 고정 shim: <FORGEN_HOME>/bin/forgen-run 작성 (node·패키지 경로는 shim 내용에만)
 *   2. Slash commands: ~/.claude/commands/forgen/*.md (forgen-managed marker)
 *   3. settings.json: hook 전체 + statusLine 을 shim 경유로. 사용자 hook·statusLine 보존, 멱등, 구형 절대경로 교체,
 *      래퍼가 남긴 FORGEN_* env 와 forgen@forgen-local 플러그인 잔재 정리
 *   4. MCP: ~/.claude.json mcpServers.forgen-compound (shim 경유)
 *   5. Dev-guide skills, verify skill, 전역 ch-* agents (~/.claude/agents, forgen 표식 있는 파일만 관리)
 *
 * 플러그인 등록(캐시·installed_plugins·enabledPlugins)은 만들지 않는다 — 마켓플레이스가 없어 로드 실패하고 hook 만 겹쳤다.
 * shim 을 못 쓰는 환경(Windows)은 기존 절대경로 유지. 한 단계가 실패해도 나머지는 진행하고 사유를 errors 로 돌려준다.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateHooksJson } from '../hooks/hooks-generator.js';
import { applyStatusLineAuto, forgenStatuslineCommand } from '../core/statusline-install.js';
import { ensureForgenRunShim, forgenRunShimPath, isForgenRunCommand, shimSupported } from './claude-shim.js';
import { hasManagedSkillMarker, installSkillFile, removeOwnedDevGuideSkills } from './managed-marker.js';
import { HOOK_REGISTRY } from '../hooks/hook-registry.js';
import { FileLockError, withFileLockSync } from '../hooks/shared/file-lock.js';

export interface ClaudeInstallOptions {
  pkgRoot: string;
  /** Override home dir (default: os.homedir()). 격리 테스트용. */
  homeDir?: string;
  /** Dry-run: 파일 미작성, 결과만 반환. */
  dryRun?: boolean;
  /** MCP forgen-compound 등록 여부 (default true). */
  registerMcp?: boolean;
  /** ADR-016 D3: user-level `verify` 스킬 설치 여부 (default true). */
  installVerifySkill?: boolean;
}

/** ADR-016 D3 — `~/.claude/skills/verify` 설치 결과. */
export type VerifySkillStatus =
  /** forgen-managed 스킬을 새로 썼거나 갱신함 */
  | 'installed'
  /** 사용자가 직접 만든 `verify` 스킬이 있어 건드리지 않음 */
  | 'user-owned'
  /** --no-verify-skill 또는 자산 부재 */
  | 'skipped';

export interface ClaudeInstallResult {
  homeDir: string;
  /** 고정 shim 경로. 쓰지 못했으면 null(절대경로 폴백). */
  shimPath: string | null;
  shimStatus: string;
  slashCommandsPath: string;
  slashCommandsCount: number;
  settingsPath: string;
  hooksInjected: number;
  statusLine: 'installed' | 'updated' | 'unchanged' | 'custom';
  mcpRegistered: boolean;
  mcpAlreadyPresent: boolean;
  skillsPath: string;
  skillsInstalled: number;
  skillsRemoved: number;
  verifySkill: VerifySkillStatus;
  agentsPath: string;
  agentsInstalled: number;
  agentsRemoved: number;
  /** forgen@forgen-local 플러그인 잔재를 정리했는가. */
  legacyPluginCleaned: boolean;
  /** 단계별 실패 사유. 비어 있지 않으면 설치가 일부만 됐다. */
  errors: string[];
}

const PLUGIN_KEY = 'forgen@forgen-local';
const FORGEN_MANAGED_MARKER = '<!-- forgen-managed -->';
/** 래퍼가 과거에 settings.env 에 써 넣던 키. 이제는 자식 프로세스 env 로만 넘긴다. */
const LEGACY_WRAPPER_ENV_KEYS = ['FORGEN_HARNESS', 'FORGEN_CWD', 'FORGEN_V1', 'FORGEN_RUNTIME', 'FORGEN_SESSION_ID', 'COMPOUND_HARNESS', 'COMPOUND_CWD'];

type Json = Record<string, unknown>;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** JSON 객체 파일 읽기. 없으면 {}, 파싱 실패면 `.corrupt-<ts>` 로 보존하고 throw — 덮어써서 사용자 설정을 잃지 않는다. */
function readJsonObject(file: string): Json {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Json;
    throw new Error('not a JSON object');
  } catch (e) {
    const corrupt = `${file}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(file, corrupt); } catch { /* best-effort */ }
    throw new Error(`${file} failed to parse (${errMsg(e)}); left untouched, copy at ${corrupt}`);
  }
}

/** 내용이 바뀐 경우에만 원자적으로 쓴다(tmp+rename). 바뀌지 않으면 파일을 건드리지 않는다. */
function writeJsonIfChanged(file: string, before: string, data: Json): boolean {
  if (JSON.stringify(data) === before) return false;
  // 사용자가 읽기 전용으로 잠근 파일은 rename 으로 몰래 교체하지 않는다
  if (fs.existsSync(file)) {
    try { fs.accessSync(file, fs.constants.W_OK); } catch { throw new Error(`${file} is read-only (EACCES); not modified`); }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return true;
}

// ── 1. 플러그인 잔재 정리 ──────────────────────────────────────────────

/** 과거 postinstall 이 만든 forgen@forgen-local 캐시·installed_plugins 항목을 지운다. 지운 것이 있으면 true. */
function cleanLegacyPluginFiles(homeDir: string): boolean {
  let cleaned = false;
  const pluginsDir = path.join(homeDir, '.claude', 'plugins');
  const cacheDir = path.join(pluginsDir, 'cache', 'forgen-local');
  if (fs.existsSync(cacheDir) || isDanglingLink(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    cleaned = true;
  }
  const installedPath = path.join(pluginsDir, 'installed_plugins.json');
  if (fs.existsSync(installedPath)) {
    const data = JSON.parse(fs.readFileSync(installedPath, 'utf-8')) as { plugins?: Json };
    if (data.plugins && PLUGIN_KEY in data.plugins) {
      delete data.plugins[PLUGIN_KEY];
      fs.writeFileSync(installedPath, `${JSON.stringify(data, null, 2)}\n`);
      cleaned = true;
    }
  }
  return cleaned;
}

function isDanglingLink(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
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

// ── 3. Settings (hooks · statusLine · 잔재 정리) ───────────────────────

let hookScriptsCache: Set<string> | null = null;
function forgenHookScripts(): Set<string> {
  if (!hookScriptsCache) {
    hookScriptsCache = new Set(HOOK_REGISTRY.map((h) => path.basename(h.script.split(/\s+/)[0]))); // script 에 인자가 붙을 수 있다(`hooks/x.js start`)
    // 등록에서 빠졌지만 구버전 settings 에 남아 있을 수 있는 이름.
    for (const legacy of ['pre-tool-use.js', 'post-tool-use.js', 'stop-guard.js', 'session-recovery.js']) hookScriptsCache.add(legacy);
  }
  return hookScriptsCache;
}

/** settings.json hook 명령이 forgen 소유인가 — 새 shim 형식과 구형 절대경로·플러그인 변수 형식 모두. */
export function isForgenHookCommand(cmd: string, pkgRoot: string): boolean {
  if (isForgenRunCommand(cmd)) return true;
  if (cmd.includes('/forgen-local/forgen/')) return true;
  // 다른 플러그인 hook 을 지우지 않게, forgen 이 실제로 쓰는 hook 스크립트 이름까지 일치해야 한다.
  const script = /[\\/]dist[\\/]hooks[\\/]([^"\s\\/]+\.js)/.exec(cmd)?.[1];
  if (!script || !(forgenHookScripts().has(script) || script.includes('forgen'))) return false;
  if (cmd.includes('CLAUDE_PLUGIN_ROOT')) return true;
  return (cmd.includes(pkgRoot) || /@wooojin[\\/]forgen|[\\/]forgen[^\\/\s"]*[\\/]|tenetx|compound-harness/.test(cmd));
}

export interface SettingsApplyResult {
  hooks: number;
  statusLine: ClaudeInstallResult['statusLine'];
}

/**
 * settings 객체에 forgen 설정을 제자리 반영한다(설치·래퍼 공용, 순수 함수).
 * hook 은 forgen 것만 갈아끼우고 사용자 hook 은 그룹 안에서도 보존한다. 같은 입력이면 결과가 같아 멱등이다.
 */
export function removeForgenHooks(hooksConfig: Record<string, unknown[]>, pkgRoot: string): void {
  for (const [event, groups] of Object.entries(hooksConfig)) {
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const g of groups) {
      const group = g as { command?: unknown; hooks?: Array<{ command?: unknown }> };
      if (typeof group.command === 'string') {
        if (!isForgenHookCommand(group.command, pkgRoot)) kept.push(g);
        continue;
      }
      if (!Array.isArray(group.hooks)) { kept.push(g); continue; }
      const inner = group.hooks.filter((h) => !(typeof h.command === 'string' && isForgenHookCommand(h.command, pkgRoot)));
      if (inner.length === group.hooks.length) kept.push(g);
      else if (inner.length > 0) kept.push({ ...group, hooks: inner });
    }
    if (kept.length === 0) delete hooksConfig[event];
    else hooksConfig[event] = kept;
  }
}

export function applyForgenSettings(settings: Json, pkgRoot: string, shimPath: string | null): SettingsApplyResult {
  const hooksConfig = (settings.hooks as Record<string, unknown[]>) ?? {};
  removeForgenHooks(hooksConfig, pkgRoot);

  // settings.json 컨텍스트는 ${CLAUDE_PLUGIN_ROOT} 를 풀지 않는다. shim 이 있으면 그 경로, 없으면 절대경로.
  const generated = generateHooksJson({
    pluginRoot: path.join(pkgRoot, 'dist'),
    runtime: 'claude',
    releaseMode: true,
    ...(shimPath ? { shimPath } : {}),
  });
  let count = 0;
  for (const [event, entries] of Object.entries(generated.hooks)) {
    if (!hooksConfig[event]) hooksConfig[event] = [];
    hooksConfig[event].push(...entries);
    for (const g of entries) count += g.hooks.length;
  }
  settings.hooks = hooksConfig;

  const statusLine = applyStatusLineAuto(settings, forgenStatuslineCommand(shimPath));

  // 플러그인 등록 잔재와 래퍼가 남긴 env, 구형 settings.mcpServers 항목 정리
  const enabled = settings.enabledPlugins as Json | undefined;
  if (enabled && PLUGIN_KEY in enabled) {
    delete enabled[PLUGIN_KEY];
    if (Object.keys(enabled).length === 0) delete settings.enabledPlugins;
  }
  const env = settings.env as Json | undefined;
  if (env) {
    for (const k of LEGACY_WRAPPER_ENV_KEYS) delete env[k];
    if (Object.keys(env).length === 0) delete settings.env;
  }
  const legacyMcp = settings.mcpServers as Json | undefined;
  if (legacyMcp && 'forgen-compound' in legacyMcp) {
    delete legacyMcp['forgen-compound'];
    if (Object.keys(legacyMcp).length === 0) delete settings.mcpServers;
  }
  return { hooks: count, statusLine };
}

function installSettings(opts: { pkgRoot: string; settingsPath: string; shimPath: string | null; dryRun: boolean }): SettingsApplyResult {
  const update = (): SettingsApplyResult => {
    const settings = readJsonObject(opts.settingsPath);
    const before = JSON.stringify(settings);
    const r = applyForgenSettings(settings, opts.pkgRoot, opts.shimPath);
    if (!opts.dryRun) writeJsonIfChanged(opts.settingsPath, before, settings);
    return r;
  };
  if (opts.dryRun) return update();
  // 래퍼·실행 중인 세션과 read-modify-write 가 겹치면 한쪽이 유실된다.
  try {
    return withFileLockSync(opts.settingsPath, update);
  } catch (e) {
    if (e instanceof FileLockError) return update();
    throw e;
  }
}

// ── 4. MCP register ────────────────────────────────────────────────────

interface McpRegisterOutcome {
  registered: boolean;
  alreadyPresent: boolean;
}

function registerMcpInClaudeJson(opts: { pkgRoot: string; claudeJsonPath: string; shimPath: string | null; dryRun: boolean }): McpRegisterOutcome {
  const { pkgRoot, claudeJsonPath, shimPath, dryRun } = opts;
  const desired = shimPath
    ? { command: shimPath, args: ['mcp/server.js'] }
    : { command: 'node', args: [path.join(pkgRoot, 'dist', 'mcp', 'server.js')] };

  const claudeJson = readJsonObject(claudeJsonPath);
  const before = JSON.stringify(claudeJson);
  const mcpServers = (claudeJson.mcpServers as Json) ?? {};
  const existing = mcpServers['forgen-compound'] as { command?: unknown; args?: unknown } | undefined;
  const alreadyPresent =
    existing !== undefined &&
    existing.command === desired.command &&
    JSON.stringify(existing.args) === JSON.stringify(desired.args);

  if (!dryRun && !alreadyPresent) {
    mcpServers['forgen-compound'] = { ...(existing ?? {}), ...desired };
    claudeJson.mcpServers = mcpServers;
    writeJsonIfChanged(claudeJsonPath, before, claudeJson);
  }
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

  // stale 정리 — forgen 이 설치한 dev-guide 스킬만 (패키지가 제공하는 이름 / dev-guide 를 가리키는 심링크).
  // 이전엔 `forgen-*` 디렉토리를 이름만 보고 재귀 삭제해 사용자가 만든 스킬까지 지웠다 (ADR-016 0.5.9).
  const removed = removeOwnedDevGuideSkills(skillsDir, pkgRoot);

  // 설치 — 이미 있는 것(사용자 심링크 디렉토리, 남아 있는 SKILL.md)은 덮어쓰지 않는다.
  let installed = 0;
  for (const { name, src } of entries) {
    if (installSkillFile(src, skillsDir, name)) installed += 1;
  }

  return { skillsPath: skillsDir, skillsInstalled: installed, skillsRemoved: removed };
}

// ── 6. verify skill (ADR-016 D3) ───────────────────────────────────────

/** `<skillsDir>/verify` 가 사용자 소유인가 (심링크 / 마커 없는 SKILL.md / SKILL.md 없이 다른 파일만 있음). */
export function isUserOwnedVerifySkill(skillsDir: string): boolean {
  const dir = path.join(skillsDir, 'verify');
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return true;
  } catch {
    return false; // 없음
  }
  const file = path.join(dir, 'SKILL.md');
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return true;
    return !hasManagedSkillMarker(fs.readFileSync(file, 'utf-8'));
  } catch {
    // SKILL.md 없음 — 디렉토리에 다른 것이 있으면 사용자가 만들던 것
    try { return fs.readdirSync(dir).length > 0; } catch { return true; }
  }
}

/**
 * Claude Code 2.1.286+ 는 project/user 스킬에 `verify` 가 있으면 커밋 직전에 실행하라고 모델에 안내한다
 * (플러그인 스킬 `forgen:verify` 는 해당 없음). 그래서 user 레벨에 un-namespaced 로 설치한다.
 * 사용자 소유 스킬은 절대 덮어쓰지 않는다.
 */
function installVerifySkill(opts: { pkgRoot: string; skillsDir: string; dryRun: boolean }): VerifySkillStatus {
  const src = path.join(opts.pkgRoot, 'assets', 'claude', 'skills', 'verify', 'SKILL.md');
  if (!fs.existsSync(src)) return 'skipped';
  if (isUserOwnedVerifySkill(opts.skillsDir)) return 'user-owned';
  if (opts.dryRun) return 'installed';
  const dir = path.join(opts.skillsDir, 'verify');
  fs.mkdirSync(dir, { recursive: true });
  // 심링크가 아니라 복사 — 마커로 소유를 판정하고, npm 경로가 바뀌어도 깨지지 않게.
  fs.copyFileSync(src, path.join(dir, 'SKILL.md'));
  return 'installed';
}

function ensureShimPathOnly(homeDir: string): string | null {
  return shimSupported() ? forgenRunShimPath(homeDir) : null;
}

// ── 7. 전역 ch-* agents ────────────────────────────────────────────────

/** 설치할 agent 내용 — frontmatter 바로 뒤에 forgen 표식을 넣는다(소유 판정은 hasManagedSkillMarker 와 같은 위치 규칙). */
function withManagedMarker(content: string): string {
  const text = content.replace(/\r\n/g, '\n');
  const close = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1;
  if (close === -1) return text;
  return `${text.slice(0, close + 5)}\n${FORGEN_MANAGED_MARKER}\n${text.slice(close + 5).replace(/^\n+/, '\n')}`;
}

/**
 * assets/claude/agents/*.md → ~/.claude/agents/ch-*.md. 표식이 있는 forgen 파일만 갱신·정리하고,
 * 사용자가 만들었거나 수정해 표식이 없는 파일, 심링크는 건드리지 않는다.
 */
export function installGlobalAgents(opts: { pkgRoot: string; agentsDir: string; dryRun?: boolean }): { installed: number; removed: number } {
  const { pkgRoot, agentsDir } = opts;
  const dryRun = opts.dryRun ?? false;
  const sourceDir = path.join(pkgRoot, 'assets', 'claude', 'agents');
  if (!fs.existsSync(sourceDir)) return { installed: 0, removed: 0 };
  const valid = new Set<string>();
  let installed = 0;
  if (!dryRun) fs.mkdirSync(agentsDir, { recursive: true });
  for (const file of fs.readdirSync(sourceDir).filter((f) => f.endsWith('.md'))) {
    const name = `ch-${file}`;
    valid.add(name);
    const dest = path.join(agentsDir, name);
    const content = withManagedMarker(fs.readFileSync(path.join(sourceDir, file), 'utf-8'));
    try {
      if (fs.lstatSync(dest).isSymbolicLink()) continue;
      const cur = fs.readFileSync(dest, 'utf-8');
      if (cur === content) continue;
      if (!hasManagedSkillMarker(cur)) continue; // 사용자 파일
    } catch { /* 없음 — 설치 */ }
    if (!dryRun) fs.writeFileSync(dest, content);
    installed += 1;
  }
  let removed = 0;
  try {
    for (const name of fs.readdirSync(agentsDir)) {
      if (!name.startsWith('ch-') || !name.endsWith('.md') || valid.has(name)) continue;
      const f = path.join(agentsDir, name);
      if (fs.lstatSync(f).isSymbolicLink() || !hasManagedSkillMarker(fs.readFileSync(f, 'utf-8'))) continue;
      if (!dryRun) fs.unlinkSync(f);
      removed += 1;
    }
  } catch { /* 디렉토리 없음 */ }
  return { installed, removed };
}

// ── public ─────────────────────────────────────────────────────────────

export function planClaudeInstall(opts: ClaudeInstallOptions): ClaudeInstallResult {
  if (!opts.pkgRoot || !fs.existsSync(opts.pkgRoot)) {
    throw new Error(`planClaudeInstall: invalid pkgRoot ${opts.pkgRoot}`);
  }
  const homeDir = opts.homeDir ?? os.homedir();
  const dryRun = opts.dryRun ?? false;
  const registerMcp = opts.registerMcp ?? true;
  const { pkgRoot } = opts;

  const claudeDir = path.join(homeDir, '.claude');
  const slashCommandsDir = path.join(claudeDir, 'commands', 'forgen');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const claudeJsonPath = path.join(homeDir, '.claude.json');
  const skillsDir = path.join(claudeDir, 'skills');
  const agentsDir = path.join(claudeDir, 'agents');

  const errors: string[] = [];
  const step = <T>(label: string, fallback: T, fn: () => T): T => {
    try { return fn(); } catch (e) { errors.push(`${label}: ${errMsg(e)}`); return fallback; }
  };

  // 1. shim (dry-run 이면 경로만 계산)
  let shimPath: string | null = null;
  let shimStatus = 'unsupported';
  if (dryRun) {
    const probe = ensureShimPathOnly(homeDir);
    shimPath = probe;
    shimStatus = probe ? 'dry-run' : 'unsupported';
  } else {
    const shim = ensureForgenRunShim(pkgRoot, homeDir);
    shimPath = shim.path;
    shimStatus = shim.status;
    if (shim.status === 'foreign' || shim.status === 'error') {
      errors.push(`shim: ${shim.status === 'foreign' ? 'a user file already exists at the shim path' : 'could not write the shim'}; falling back to absolute paths`);
    }
  }

  const legacyPluginCleaned = dryRun ? false : step('legacy plugin cleanup', false, () => cleanLegacyPluginFiles(homeDir));
  const slashCommandsCount = step('slash commands', 0, () => writeSlashCommands({ pkgRoot, targetDir: slashCommandsDir, dryRun }));
  const settings = step<SettingsApplyResult>('settings.json', { hooks: 0, statusLine: 'unchanged' }, () =>
    installSettings({ pkgRoot, settingsPath, shimPath, dryRun }));
  const mcp = registerMcp
    ? step<McpRegisterOutcome>('~/.claude.json MCP', { registered: false, alreadyPresent: false }, () =>
      registerMcpInClaudeJson({ pkgRoot, claudeJsonPath, shimPath, dryRun }))
    : { registered: false, alreadyPresent: false };
  const skills = step<SkillsInstallOutcome>('dev-guide skills', { skillsPath: skillsDir, skillsInstalled: 0, skillsRemoved: 0 }, () =>
    installDevGuideSkills({ pkgRoot, skillsDir, dryRun }));
  const verifySkill: VerifySkillStatus = (opts.installVerifySkill ?? true)
    ? step<VerifySkillStatus>('verify skill', 'skipped', () => installVerifySkill({ pkgRoot, skillsDir, dryRun }))
    : 'skipped';
  const agents = step('agents', { installed: 0, removed: 0 }, () => installGlobalAgents({ pkgRoot, agentsDir, dryRun }));

  return {
    homeDir,
    shimPath,
    shimStatus,
    slashCommandsPath: slashCommandsDir,
    slashCommandsCount,
    settingsPath,
    hooksInjected: settings.hooks,
    statusLine: settings.statusLine,
    mcpRegistered: mcp.registered,
    mcpAlreadyPresent: mcp.alreadyPresent,
    skillsPath: skills.skillsPath,
    skillsInstalled: skills.skillsInstalled,
    skillsRemoved: skills.skillsRemoved,
    verifySkill,
    agentsPath: agentsDir,
    agentsInstalled: agents.installed,
    agentsRemoved: agents.removed,
    legacyPluginCleaned,
    errors,
  };
}
