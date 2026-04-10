import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FORGEN_HOME, LAB_DIR, ME_BEHAVIOR, ME_DIR, ME_PHILOSOPHY, ME_SOLUTIONS, ME_RULES, PACKS_DIR, SESSIONS_DIR, STATE_DIR } from './paths.js';

/** ~/.claude/projects/ — Claude Code 세션 저장 경로 */
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function check(label: string, condition: boolean, hint?: string): void {
  const icon = condition ? '✓' : '✗';
  const hintStr = !condition && hint ? ` — ${hint}` : '';
  console.log(`  ${icon} ${label}${hintStr}`);
}

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function commandExists(cmd: string): boolean {
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(checker, [cmd], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(): Promise<void> {
  console.log('\n  Forgen — Diagnostics\n');

  console.log('  [Tools]');
  check('claude CLI', commandExists('claude'));
  check('tmux', commandExists('tmux'));
  check('git', commandExists('git'));
  check('gh (GitHub CLI)', commandExists('gh'), 'Required for team PR features: brew install gh');
  console.log();

  console.log('  [Plugins]');
  const ralphLoopInstalled = exists(
    path.join(os.homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', 'ralph-loop')
  );
  check('ralph-loop plugin', ralphLoopInstalled,
    'Required for ralph mode auto-iteration. Install: claude plugins install ralph-loop');

  // forgen 플러그인 캐시 디렉토리 확인 — 훅 실행의 필수 전제
  const pluginCacheBase = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'forgen-local', 'forgen');
  let forgenPluginCacheOk = false;
  if (exists(pluginCacheBase)) {
    const versions = fs.readdirSync(pluginCacheBase).filter(f => {
      try {
        const lstat = fs.lstatSync(path.join(pluginCacheBase, f));
        return lstat.isDirectory() || lstat.isSymbolicLink();
      } catch { return false; }
    });
    forgenPluginCacheOk = versions.length > 0;
  }
  check('forgen plugin cache', forgenPluginCacheOk,
    'Hook execution requires plugin cache. Fix: npm run build && node scripts/postinstall.js');

  // installed_plugins.json 정합성 확인
  const installedPluginsPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  let pluginRegistered = false;
  if (exists(installedPluginsPath)) {
    try {
      const installed = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf-8'));
      const entry = installed?.plugins?.['forgen@forgen-local'];
      if (Array.isArray(entry) && entry.length > 0) {
        const installPath = entry[0]?.installPath;
        pluginRegistered = !!installPath && exists(installPath);
      }
    } catch { /* ignore */ }
  }
  check('forgen plugin registered & installPath exists', pluginRegistered,
    'Plugin registered but installPath missing on disk. Fix: npm run build && node scripts/postinstall.js');
  console.log();

  console.log('  [Directories]');
  check('~/.forgen/', exists(FORGEN_HOME));
  check('~/.forgen/me/', exists(ME_DIR));
  check('~/.forgen/me/solutions/', exists(ME_SOLUTIONS));
  check('~/.forgen/me/behavior/', exists(ME_BEHAVIOR));
  check('~/.forgen/me/rules/', exists(ME_RULES));
  check('~/.forgen/packs/', exists(PACKS_DIR));
  check('~/.forgen/sessions/', exists(SESSIONS_DIR));
  console.log();

  console.log('  [Philosophy]');
  check('philosophy.json', exists(ME_PHILOSOPHY));
  console.log();

  console.log('  [Environment]');
  check('Inside tmux session', !!process.env.TMUX);
  check('FORGEN_HARNESS env var', (process.env.FORGEN_HARNESS ?? process.env.COMPOUND_HARNESS) === '1');
  console.log();

  // 솔루션/규칙 수
  if (exists(ME_SOLUTIONS)) {
    const solutions = fs.readdirSync(ME_SOLUTIONS).filter((f) => f.endsWith('.md')).length;
    console.log(`  Personal solutions: ${solutions}`);
  }
  if (exists(ME_BEHAVIOR)) {
    const behavior = fs.readdirSync(ME_BEHAVIOR).filter((f) => f.endsWith('.md')).length;
    console.log(`  Behavioral patterns: ${behavior}`);
  }
  if (exists(ME_RULES)) {
    const rules = fs.readdirSync(ME_RULES).filter((f) => f.endsWith('.md')).length;
    console.log(`  Personal rules: ${rules}`);
  }
  console.log();

  console.log('  [Log Locations]');
  console.log(`  Session logs: ${SESSIONS_DIR}`);

  if (exists(SESSIONS_DIR)) {
    const sessionCount = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).length;
    console.log(`  Saved sessions: ${sessionCount}`);
  }

  console.log(`  Claude Code sessions: ${CLAUDE_PROJECTS_DIR}`);
  console.log();

  console.log();

  // v1: 팀 팩 시스템 제거. 개인 모드만 지원.
  console.log('  [Pack Connections]');
  console.log('  v1: Personal mode only (team packs removed)');
  console.log();

  // Lab 데이터 정리
  const labExpDir = path.join(LAB_DIR, 'experiments');
  if (exists(labExpDir)) {
    const expFiles = fs.readdirSync(labExpDir).filter(f => f.endsWith('.json'));
    // 1차 필터: 0바이트 또는 50바이트 미만 파일 (빠른 stat 기반)
    const emptyFiles = expFiles.filter(f => {
      try {
        const stat = fs.statSync(path.join(labExpDir, f));
        if (stat.size < 50) return true;
        // --clean-experiments 플래그가 있을 때만 내용 파싱 (성능 보호)
        if (!process.argv.includes('--clean-experiments')) return false;
        const content = JSON.parse(fs.readFileSync(path.join(labExpDir, f), 'utf-8'));
        return content.variants?.every((v: { sessionIds?: string[] }) => !v.sessionIds?.length);
      } catch { return false; }
    });
    if (emptyFiles.length > 0) {
      console.log(`  [Lab Cleanup]`);
      console.log(`  Empty experiment files: ${emptyFiles.length} / ${expFiles.length}`);
      if (process.argv.includes('--clean-experiments')) {
        let cleaned = 0;
        for (const f of emptyFiles) {
          try { fs.unlinkSync(path.join(labExpDir, f)); cleaned++; } catch { /* skip */ }
        }
        console.log(`  → Cleaned ${cleaned} empty experiment files`);
      } else {
        console.log(`  Run \`forgen doctor --clean-experiments\` to remove them`);
      }
      console.log();
    }
  }

  // 훅 에러 카운트
  console.log('  [Hook Health]');
  const hookErrorPath = path.join(STATE_DIR, 'hook-errors.json');
  if (fs.existsSync(hookErrorPath)) {
    try {
      const errors: Record<string, { count: number; lastAt: string }> = JSON.parse(fs.readFileSync(hookErrorPath, 'utf-8'));
      const entries = Object.entries(errors);
      if (entries.length === 0) {
        console.log('  No hook errors recorded');
      } else {
        for (const [hookName, { count, lastAt }] of entries) {
          const icon = count === 0 ? '✓' : '⚠';
          const lastDate = lastAt ? lastAt.split('T')[0] : 'unknown';
          console.log(`  ${icon} ${hookName}: ${count} error${count !== 1 ? 's' : ''}${count > 0 ? ` (last: ${lastDate})` : ''}`);
        }
      }
    } catch {
      console.log('  (hook-errors.json read failed)');
    }
  } else {
    console.log('  No hook errors recorded');
  }
  console.log();

  // 현재 디렉토리 git 정보
  console.log('  [Git]');
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf-8', stdio: 'pipe' }).trim();
    console.log(`  remote (origin): ${remote}`);
  } catch {
    // git 저장소가 아니거나 origin이 없으면 표시하지 않음
    console.log('  git remote: (none)');
  }
  console.log();
}
