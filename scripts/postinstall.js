#!/usr/bin/env node
/**
 * Forgen — postinstall script
 *
 * npm i -g forgen 시 자동 실행.
 * forgen CLI(harness)를 거치지 않고 claude를 직접 실행해도
 * 슬래시 명령, 훅, 디렉토리 구조가 모두 동작하도록 보장합니다.
 *
 * 크로스 플랫폼 지원: Windows, macOS, Linux (sudo 포함)
 *
 * 설계 결정:
 *   - forge overlay 없이 기본 스킬만 설치 (overlay는 harness 실행 시 적용)
 *   - 사용자가 수정한 파일(<!-- forgen-managed --> 마커 없음)은 보존
 *   - settings.json의 기존 non-forgen 설정은 보존
 *   - 실패해도 npm install을 깨뜨리지 않음 (사유는 출력)
 *   - Claude 설치는 dist/host/install-claude.js 의 planClaudeInstall 을 호출 (`forgen install claude` 와 동일 경로)
 */

import { readdirSync, writeFileSync, mkdirSync, existsSync, symlinkSync, cpSync, lstatSync, statSync, copyFileSync, renameSync, readlinkSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const IS_WINDOWS = platform() === 'win32';
/** package.json engines.node 와 같게 유지 (tests/node-engine 이 대조). */
const MIN_NODE_MAJOR = 22;

/** SUDO_USER 유효성 검증 — 커맨드 인젝션 방지 */
const SAFE_USERNAME_RE = /^[a-zA-Z0-9_-]+$/;
function getSafeSudoUser() {
  const sudoUser = process.env.SUDO_USER;
  if (!sudoUser) return null;
  if (!SAFE_USERNAME_RE.test(sudoUser)) return null;
  return sudoUser;
}

/**
 * sudo npm i -g 시 homedir()이 /root를 반환하는 문제 해결.
 * SUDO_USER가 있으면 실제 유저의 홈 디렉토리를 찾는다.
 * Windows에서는 sudo가 없으므로 homedir() 그대로 사용.
 *
 * 보안: execFileSync를 사용하여 쉘 보간 없이 실행.
 */
function resolveHome() {
  if (IS_WINDOWS) return homedir();

  const sudoUser = getSafeSudoUser();
  if (sudoUser && process.getuid?.() === 0) {
    try {
      if (platform() === 'darwin') {
        const out = execFileSync('dscl', ['.', '-read', `/Users/${sudoUser}`, 'NFSHomeDirectory'], { encoding: 'utf-8' });
        const home = out.trim().split(':').pop()?.trim();
        if (home) return home;
      } else {
        const out = execFileSync('getent', ['passwd', sudoUser], { encoding: 'utf-8' });
        const home = out.trim().split(':')[5];
        if (home) return home;
      }
    } catch { /* fallback */ }
    return platform() === 'darwin'
      ? join('/Users', sudoUser)
      : join('/home', sudoUser);
  }
  return homedir();
}

/**
 * sudo로 생성된 파일/디렉토리를 실제 유저 소유로 변경.
 * 이렇게 하지 않으면 유저가 나중에 settings.json 등을 수정할 수 없음.
 *
 * 보안: execFileSync를 사용하여 쉘 보간 없이 실행.
 */
function fixOwnership(...paths) {
  if (IS_WINDOWS) return;
  const sudoUser = getSafeSudoUser();
  if (!sudoUser || process.getuid?.() !== 0) return;

  try {
    const uid = execFileSync('id', ['-u', sudoUser], { encoding: 'utf-8' }).trim();
    const gid = execFileSync('id', ['-g', sudoUser], { encoding: 'utf-8' }).trim();
    for (const p of paths) {
      if (existsSync(p)) {
        execFileSync('chown', ['-R', `${uid}:${gid}`, p], { stdio: 'ignore' });
      }
    }
  } catch { /* best effort */ }
}

const HOME = resolveHome();

// ── Paths ──
const CLAUDE_DIR = join(HOME, '.claude');
const COMPOUND_HOME = join(HOME, '.forgen');

// ── 0.5. Migrate legacy storage (~/.tenetx/, ~/.compound/) → ~/.forgen/ ──
function migrateLegacyStorage() {
  const legacyDirs = [join(HOME, '.tenetx'), join(HOME, '.compound')];
  for (const legacyHome of legacyDirs) {
    try { if (lstatSync(legacyHome).isSymbolicLink()) continue; } catch { continue; }
    if (!existsSync(legacyHome) || !statSync(legacyHome).isDirectory()) continue;

    mkdirSync(COMPOUND_HOME, { recursive: true });
    try {
      for (const entry of readdirSync(legacyHome, { withFileTypes: true })) {
        const src = join(legacyHome, entry.name);
        const dest = join(COMPOUND_HOME, entry.name);
        if (existsSync(dest)) continue;
        if (entry.isDirectory()) cpSync(src, dest, { recursive: true });
        else if (entry.isFile()) copyFileSync(src, dest);
      }
    } catch { /* ignore copy errors */ }

    const backupPath = legacyHome + '.bak';
    try {
      if (!existsSync(backupPath)) {
        renameSync(legacyHome, backupPath);
        symlinkSync(COMPOUND_HOME, legacyHome, 'dir');
      }
    } catch { /* ignore symlink errors */ }
  }
}

// ── 1. Ensure directories ──
function ensureDirectories() {
  const dirs = [
    COMPOUND_HOME,
    join(COMPOUND_HOME, 'me'),
    join(COMPOUND_HOME, 'me', 'solutions'),
    join(COMPOUND_HOME, 'me', 'behavior'),
    join(COMPOUND_HOME, 'me', 'rules'),
    join(COMPOUND_HOME, 'me', 'skills'),
    join(COMPOUND_HOME, 'sessions'),
    join(COMPOUND_HOME, 'state'),
    join(COMPOUND_HOME, 'handoffs'),
    join(COMPOUND_HOME, 'lab'),
    CLAUDE_DIR,
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

// ── 1.5. Starter Knowledge Pack ──
// 새 사용자(솔루션 < 5개)에게 범용 개발 패턴 솔루션을 기본 제공
function installStarterPack() {
  const solutionsDir = join(COMPOUND_HOME, 'me', 'solutions');
  const starterDir = join(PKG_ROOT, 'starter-pack', 'solutions');

  if (!existsSync(starterDir)) return 0;

  // 기존 솔루션이 5개 이상이면 설치하지 않음 (이미 사용 중인 유저)
  let existing = 0;
  if (existsSync(solutionsDir)) {
    existing = readdirSync(solutionsDir).filter(f => f.endsWith('.md')).length;
  }
  if (existing >= 5) return 0;

  mkdirSync(solutionsDir, { recursive: true });
  const starterFiles = readdirSync(starterDir).filter(f => f.endsWith('.md'));
  let installed = 0;

  for (const file of starterFiles) {
    const dest = join(solutionsDir, file);
    if (!existsSync(dest)) {
      cpSync(join(starterDir, file), dest);
      installed++;
    }
  }

  return installed;
}

/**
 * forgen 이 설치한 dev-guide 스킬만 정리한다 (src/host/managed-marker.ts 의 removeOwnedDevGuideSkills 와 같은 규칙).
 *
 * 이전엔 `forgen-*` 디렉토리를 이름만 보고 재귀 삭제해, 사용자가 만든 `forgen-notes` / `forgen-react-mine`
 * 같은 스킬이 npm install 때마다 사라졌다. 소유 근거: (a) 패키지가 현재 제공하는 이름, 또는
 * (b) SKILL.md 가 `…/assets/dev-guide/…` 를 가리키는 심링크(이전 버전이 설치한 것).
 * SKILL.md 한 파일과 빈 디렉토리만 지운다.
 */
function removeOwnedDevGuideSkills(skillsDir, devGuideRoot) {
  const known = new Set();
  try {
    for (const tier of readdirSync(devGuideRoot)) {
      const base = join(devGuideRoot, tier, 'skills');
      if (!existsSync(base)) continue;
      for (const stack of readdirSync(base)) {
        const stackDir = join(base, stack);
        if (!statSync(stackDir).isDirectory()) continue;
        for (const skill of readdirSync(stackDir)) {
          if (existsSync(join(stackDir, skill, 'SKILL.md'))) known.add(`forgen-${stack}-${skill}`);
        }
      }
    }
  } catch { /* 자산 없음 */ }

  let removed = 0;
  let entries = [];
  try { entries = readdirSync(skillsDir); } catch { return 0; }
  for (const name of entries) {
    if (!name.startsWith('forgen-')) continue;
    const dir = join(skillsDir, name);
    const file = join(dir, 'SKILL.md');
    let owned = known.has(name);
    if (!owned) {
      try { owned = /[\\/]assets[\\/]dev-guide[\\/]/.test(readlinkSync(file)); } catch { owned = false; }
    }
    if (!owned) continue;
    try {
      if (lstatSync(dir).isSymbolicLink()) continue;
      lstatSync(file); // 없으면 throw
      unlinkSync(file);
      try { if (readdirSync(dir).length === 0) rmdirSync(dir); } catch { /* ignore */ }
      removed++;
    } catch { /* best-effort */ }
  }
  return removed;
}

/**
 * dev-guide 스킬 한 개 설치 (src/host/managed-marker.ts installSkillFile 과 같은 규칙).
 * 이미 있는 것은 덮어쓰지 않는다: 심링크된 스킬 디렉토리는 따라 들어가지 않고, 남아 있는 SKILL.md 는 건드리지 않는다
 * (rmSync/cpSync 는 심링크를 관통해 사용자 dotfiles 의 파일을 지우거나 덮어쓴다). 반환: 설치했는가.
 */
function installSkillFile(src, skillsDir, name) {
  const dir = join(skillsDir, name);
  const file = join(dir, 'SKILL.md');
  try {
    try { if (lstatSync(dir).isSymbolicLink()) return false; } catch { /* 없음 */ }
    mkdirSync(dir, { recursive: true });
    try { lstatSync(file); return false; } catch { /* 없음 — 설치 */ }
    try { symlinkSync(src, file, 'file'); } catch { copyFileSync(src, file); }
    return true;
  } catch {
    return false;
  }
}

/**
 * v0.4.9: dev-guide 14 skills → ~/.codex/skills/forgen-<stack>-<skill>/SKILL.md
 * forgen 자체 commands(forgen-compound 등) 와 prefix 겹치지 않도록
 * stale 정리는 removeOwnedDevGuideSkills (forgen 소유만).
 */

function installDevGuideSkillsToCodex(home) {
  const devGuideRoot = join(PKG_ROOT, 'assets', 'dev-guide');
  if (!existsSync(devGuideRoot)) {
    console.log('[forgen] dev-guide assets not found — codex skill install skipped');
    return 0;
  }

  const codexSkillsDir = join(home, '.codex', 'skills');
  mkdirSync(codexSkillsDir, { recursive: true });

  // 1. forgen 이 설치한 dev-guide 스킬 정리 (forgen 자체 commands 와 사용자 스킬은 보존)
  const removed = removeOwnedDevGuideSkills(codexSkillsDir, devGuideRoot);

  // 2. assets/dev-guide/{tier}/skills/{stack}/{skill}/SKILL.md 수집
  let installed = 0;
  for (const tier of readdirSync(devGuideRoot)) {
    const sideSkillsDir = join(devGuideRoot, tier, 'skills');
    if (!existsSync(sideSkillsDir)) continue;
    for (const stack of readdirSync(sideSkillsDir)) {
      const stackDir = join(sideSkillsDir, stack);
      if (!statSync(stackDir).isDirectory()) continue;
      for (const skill of readdirSync(stackDir)) {
        const skillFile = join(stackDir, skill, 'SKILL.md');
        if (!existsSync(skillFile)) continue;

        // 이미 있는 사용자 것은 덮어쓰지 않는다
        if (installSkillFile(skillFile, codexSkillsDir, `forgen-${stack}-${skill}`)) installed++;
      }
    }
  }

  fixOwnership(codexSkillsDir);
  console.log(`[forgen] codex dev-guide skills: ${installed} installed${removed > 0 ? ` (${removed} stale removed)` : ''}`);
  return installed;
}

// ── Main ──

/**
 * 한 번에 설치 완료: Claude(hook·MCP·statusLine·commands·skills·verify·agents)는 dist 의 planClaudeInstall 을 호출해
 * `forgen install claude` 와 같은 경로를 쓴다. hook/MCP/statusLine 은 고정 shim(~/.forgen/bin/forgen-run)만 가리키므로
 * Node 전환·재설치 때 settings 는 바뀌지 않는다. 어떤 단계가 실패해도 npm install 은 성공으로 끝내되 사유를 출력한다.
 */
async function main() {
  if (process.env.FORGEN_SKIP_POSTINSTALL === '1') return;
  // 저장소 체크아웃에서 `npm install` 하면 INIT_CWD 가 PKG_ROOT 와 같아진다. 개발자 실제 홈을 바꾸면 안 된다.
  if (existsSync(join(PKG_ROOT, '.git')) && process.env.FORGEN_FORCE_POSTINSTALL !== '1') {
    console.log('[forgen] 저장소 체크아웃이라 사용자 설정을 건드리지 않습니다. 설치하려면: forgen install claude');
    return;
  }
  // pnpm·yarn 전역 설치는 npm_config_global 이 없다. 패키지 위치로 판별한다.
  const globalByPath = /[\\/](pnpm[\\/]global|\.pnpm-global|yarn[\\/]global|\.config[\\/]yarn[\\/]global)[\\/]/.test(PKG_ROOT);
  // W-V2: 프로젝트 의존성으로 설치할 때는 사용자 홈에 hook 을 심지 않는다.
  if (!process.env.npm_config_global && !globalByPath && process.env.INIT_CWD && process.env.INIT_CWD !== PKG_ROOT) {
    console.log('[forgen] 프로젝트 의존성으로 설치되어 hook 을 등록하지 않았습니다. 등록하려면: npx forgen install claude');
    return;
  }
  const problems = [];
  const attempt = (label, fn) => {
    try { return fn(); } catch (err) { problems.push(`${label}: ${err?.message ?? err}`); return undefined; }
  };

  // Node 엔진 미달 경고 (설치는 막지 않는다)
  if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR) {
    console.error(`[forgen] WARNING: Node ${process.versions.node} is below the supported range (>=${MIN_NODE_MAJOR}). Some features may fail; use: nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}`);
  }

  attempt('legacy storage migration', migrateLegacyStorage);
  attempt('directories', ensureDirectories);

  // ── Claude: 단일 설치 경로 ──
  let claude = null;
  try {
    const mod = await import(join(PKG_ROOT, 'dist', 'host', 'install-claude.js'));
    claude = mod.planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: HOME });
    for (const e of claude.errors) problems.push(e);
  } catch (err) {
    problems.push(`claude install: ${err?.message ?? err} (is dist/ built?)`);
  }

  // ── Codex 훅 shim 갱신 — 이미 쓰고 있으면 새 node/패키지 경로로 내용만 재작성(hooks.json 불변 → trust 유지) ──
  try {
    const shimMod = await import(join(PKG_ROOT, 'dist', 'host', 'codex-hook-shim.js'));
    const codexHome = process.env.CODEX_HOME || join(HOME, '.codex');
    const shimFile = shimMod.codexHookShimPath(codexHome);
    if (existsSync(shimFile)) {
      const r = shimMod.writeCodexHookShim(PKG_ROOT, process.execPath, shimFile);
      if (r === 'written') console.log('[forgen] Codex hook shim updated → no /hooks re-trust needed.');
    } else {
      // 이전 형식(node + 절대경로) forgen 훅 → shim 형식으로 자동 전환 (forgen 훅 명령만, 순서·사용자 훅 보존).
      const r = shimMod.migrateCodexHooksToShim(codexHome, PKG_ROOT, process.execPath);
      if (r.status === 'migrated') {
        console.log(`[forgen] Codex: ${r.rewritten} forgen hooks switched to a stable shim (backup: hooks.json.bak-pre-shim).`);
        console.log('[forgen]   Approve once in Codex (/hooks → trust all). Future upgrades and nvm switches keep the trust.');
      }
    }
  } catch { /* dist 없음(dev) 또는 실패 — 다음 forgen install codex 가 처리 */ }

  // ── Stop 룰 발동 조건 재조정 1회 마이그레이션 (2026-10-07, v0.6.7~) ──
  // 룰별 발동 조건·critic 실행 증거 판정은 룰 파일에 구워져 있어 업그레이드만으론 반영되지 않는다.
  // 사용자 룰만 대상(프로젝트 룰은 git 소스라 건드리지 않음). 마커로 1회만.
  try {
    const forgenHome = process.env.FORGEN_HOME || join(HOME, '.forgen');
    // v2(0.6.8): mock 제외에 표 행 추가 — 트리거가 바뀌면 마커 버전을 올려야 재적용된다.
    const marker = join(forgenHome, 'state', 'stop-retune-v2.done');
    if (existsSync(join(forgenHome, 'me', 'rules')) && !existsSync(marker)) {
      process.env.FORGEN_HOME = forgenHome;
      process.env.FORGEN_DISABLE_PROJECT_RULES = '1';
      const mod = await import(join(PKG_ROOT, 'dist', 'engine', 'enforce-classifier.js'));
      const n = await mod.applyStopRetuneToUserRules();
      mkdirSync(join(forgenHome, 'state'), { recursive: true });
      writeFileSync(marker, `${new Date().toISOString()} changed=${n}\n`);
      if (n > 0) console.log(`[forgen] Stop rules retuned: ${n} rule(s) now fire on their own claim (forgen rule classify --stop-only to review).`);
    }
  } catch (err) { console.error(`[forgen] Stop rule retune skipped: ${err?.message ?? err}`); }

  // ── Starter Knowledge Pack (솔루션 < 5개일 때만) ──
  const starterInstalled = attempt('starter pack', installStarterPack) ?? 0;

  // ── dev-guide 스킬 (codex) ──
  attempt('codex dev-guide skills', () => installDevGuideSkillsToCodex(HOME));

  // sudo 실행 시 파일 소유권을 실제 유저로 변경
  fixOwnership(join(HOME, '.claude'), join(HOME, '.forgen'), join(HOME, '.claude.json'));

  // ── Self-check: 설치 산출물이 현재 Node 에서 실제로 로드되는지 확인 ──
  // 0.4.4 이전 빌드는 Node 20.0-20.9 에서 모든 훅이 SyntaxError 로 깨졌다. 설치 직후에 노출하기 위한 점검.
  let selfCheckErr = '';
  try {
    const mod = await import(new URL('../dist/hooks/hook-registry.js', import.meta.url).href);
    if (!Array.isArray(mod?.HOOK_REGISTRY) || mod.HOOK_REGISTRY.length === 0) selfCheckErr = 'HOOK_REGISTRY is empty or not an array';
  } catch (err) {
    selfCheckErr = err?.message ?? String(err);
  }
  if (selfCheckErr) problems.push(`hook self-check failed on Node ${process.version}: ${selfCheckErr}`);

  // ── 요약 ──
  if (claude) {
    const parts = [
      claude.shimPath ? `shim ${claude.shimPath}` : 'absolute-path hooks (no shim)',
      `${claude.hooksInjected} hooks`,
      claude.mcpAlreadyPresent || claude.mcpRegistered ? 'MCP' : null,
      `statusLine ${claude.statusLine}`,
      `${claude.slashCommandsCount} commands`,
      `${claude.skillsInstalled} skills`,
      `verify ${claude.verifySkill}`,
      `${claude.agentsInstalled} agents`,
      starterInstalled > 0 ? `${starterInstalled} starter solutions` : null,
    ].filter(Boolean);
    console.log(`[forgen] Installed: ${parts.join(', ')} → ${HOME}`);
    if (claude.statusLine === 'custom') {
      console.log('[forgen] statusLine is set to another command (e.g. claude-hud) — left untouched.');
      console.log('[forgen]   To switch to forgen (backup kept in statusLine_backup): forgen statusline install --force');
      console.log('[forgen]   To keep it AND show forgen\'s line after it (chain, original kept in statusLine_backup): forgen statusline install --chain');
    }
  }
  if (problems.length > 0) {
    console.error('');
    console.error('[forgen] Setup was incomplete — the package itself is installed:');
    for (const p of problems) console.error(`[forgen]   - ${p}`);
    console.error('[forgen]   Retry after fixing the cause: forgen install claude');
    console.error('');
  } else {
    console.log('[forgen] Next: run `forgen` to finish onboarding, then `forgen doctor --quick`. Codex: `forgen install codex`.');
  }
}

main().catch((err) => {
  // postinstall 실패가 npm install을 깨뜨리지 않되, 원인은 표시
  console.error(`[forgen] postinstall warning: ${err?.message ?? err}`);
});
