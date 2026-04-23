import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FORGEN_HOME, LAB_DIR, ME_BEHAVIOR, ME_DIR, ME_SOLUTIONS, ME_RULES, ME_SKILLS, PACKS_DIR, SESSIONS_DIR, STATE_DIR } from './paths.js';
import { getTimingStats } from '../hooks/shared/hook-timing.js';
import { countSessionScopedFiles, pruneState } from './state-gc.js';

/** ~/.claude/projects/ — Claude Code 세션 저장 경로 */
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

interface FailedCheck {
  section: string;
  label: string;
  hint?: string;
}

let currentSection = '';
let failedChecks: FailedCheck[] = [];

function section(name: string): void {
  currentSection = name;
  console.log(`  [${name}]`);
}

function check(label: string, condition: boolean, hint?: string): void {
  const icon = condition ? '✓' : '✗';
  const hintStr = !condition && hint ? ` — ${hint}` : '';
  console.log(`  ${icon} ${label}${hintStr}`);
  if (!condition) {
    failedChecks.push({ section: currentSection, label, hint });
  }
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

export interface DoctorOptions {
  /** When true, delete stale session-scoped state files instead of just
   *  reporting bloat. Triggered by `forgen doctor --prune-state`. */
  pruneState?: boolean;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<void> {
  failedChecks = [];
  console.log('\n  Forgen — Diagnostics\n');

  section('Tools');
  check('claude CLI', commandExists('claude'));
  check('tmux', commandExists('tmux'));
  check('git', commandExists('git'));
  check('gh (GitHub CLI)', commandExists('gh'), 'Required for team PR features: brew install gh');
  console.log();

  section('Plugins');
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

  section('Directories');
  check('~/.forgen/', exists(FORGEN_HOME));
  check('~/.forgen/me/', exists(ME_DIR));
  check('~/.forgen/me/solutions/', exists(ME_SOLUTIONS));
  check('~/.forgen/me/behavior/', exists(ME_BEHAVIOR));
  check('~/.forgen/me/rules/', exists(ME_RULES));
  check('~/.forgen/packs/', exists(PACKS_DIR));
  check('~/.forgen/sessions/', exists(SESSIONS_DIR));

  // R9-IA5: warn if a user dropped rule files at ~/.forgen/rules/ by mistake.
  // That path is NOT loaded — personal rules live at ~/.forgen/me/rules/.
  const legacyRulesPath = path.join(FORGEN_HOME, 'rules');
  if (exists(legacyRulesPath) && legacyRulesPath !== ME_RULES) {
    try {
      const files = fs.readdirSync(legacyRulesPath).filter((f) => f.endsWith('.json'));
      if (files.length > 0) {
        check(
          `~/.forgen/rules/ (${files.length} orphan file(s))`,
          false,
          `This path is NOT loaded. Move files to ~/.forgen/me/rules/ or delete them.`,
        );
      }
    } catch {
      // permission / symlink issue — diagnostics must not crash
    }
  }
  console.log();

  section('Environment');
  check('Inside tmux session', !!process.env.TMUX,
    'FORGEN auto-compound relies on tmux. Launch: tmux new -s forgen');
  check('FORGEN_HARNESS env var', (process.env.FORGEN_HARNESS ?? process.env.COMPOUND_HARNESS) === '1',
    'Set by `forgen` / `fgx` launcher. Hooks assume harness mode is active.');
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

  // Hook Health: recent error tracking
  console.log('  [Hook Health]');
  try {
    const hookErrorsPath = path.join(STATE_DIR, 'hook-errors.jsonl');
    if (exists(hookErrorsPath)) {
      const content = fs.readFileSync(hookErrorsPath, 'utf-8');
      const entries = content.trim().split('\n')
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
      const byHook = new Map<string, number>();
      for (const e of entries) {
        byHook.set(e.hook, (byHook.get(e.hook) ?? 0) + 1);
      }
      if (byHook.size === 0) {
        console.log('  No hook errors recorded.');
      } else {
        for (const [hook, count] of [...byHook.entries()].sort((a, b) => b[1] - a[1])) {
          console.log(`  ${hook}: ${count} error(s)`);
        }
      }
    } else {
      console.log('  No hook errors recorded.');
    }
  } catch {
    console.log('  Unable to read hook error log.');
  }
  console.log();

  // Hook Timing: performance stats
  console.log('  [Hook Timing]');
  const timingStats = getTimingStats();
  if (timingStats.length === 0) {
    console.log('  No timing data collected yet.');
  } else {
    console.log('  Hook                  Count   p50ms   p95ms   max ms');
    console.log('  ' + '-'.repeat(56));
    for (const s of timingStats) {
      const hook = s.hook.padEnd(22);
      const count = String(s.count).padStart(5);
      const p50 = String(s.p50).padStart(7);
      const p95 = String(s.p95).padStart(7);
      const max = String(s.max).padStart(8);
      console.log(`  ${hook}${count}${p50}${p95}${max}`);
    }
  }
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

  // Harness Maturity section
  console.log('  [Harness Maturity]');
  const cwd = process.cwd();

  // 1. Preparation
  const hasClaude = fs.existsSync(path.join(cwd, 'CLAUDE.md'));
  let rulesCount = 0;
  try {
    const rulesDir = path.join(cwd, '.claude', 'rules');
    if (fs.existsSync(rulesDir)) {
      rulesCount = fs.readdirSync(rulesDir).filter(f => f.endsWith('.md')).length;
    }
  } catch { /* fail-open */ }
  let hooksActive = 0;
  try {
    const hooksJsonPath = path.join(cwd, 'hooks', 'hooks.json');
    if (fs.existsSync(hooksJsonPath)) {
      const hooksData = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
      if (hooksData.hooks && typeof hooksData.hooks === 'object') {
        for (const eventHooks of Object.values(hooksData.hooks)) {
          if (Array.isArray(eventHooks)) {
            for (const group of eventHooks) {
              if (Array.isArray((group as { hooks?: unknown[] }).hooks)) {
                hooksActive += ((group as { hooks: unknown[] }).hooks).length;
              }
            }
          }
        }
      }
    }
  } catch { /* fail-open */ }
  const prepL = hasClaude && rulesCount >= 3 && hooksActive > 0 ? 'L3' : hasClaude && hooksActive > 0 ? 'L2' : hasClaude ? 'L1' : 'L0';

  // 2. Context
  let solutionsCount = 0;
  try {
    if (exists(ME_SOLUTIONS)) solutionsCount = fs.readdirSync(ME_SOLUTIONS).filter(f => f.endsWith('.md')).length;
  } catch { /* fail-open */ }
  let behaviorCount = 0;
  try {
    if (exists(ME_BEHAVIOR)) behaviorCount = fs.readdirSync(ME_BEHAVIOR).filter(f => f.endsWith('.md')).length;
  } catch { /* fail-open */ }
  const ctxL = solutionsCount >= 5 && behaviorCount >= 3 ? 'L3' : solutionsCount >= 3 || behaviorCount >= 1 ? 'L2' : solutionsCount > 0 || behaviorCount > 0 ? 'L1' : 'L0';

  // 3. Execution
  const hasSkills = exists(ME_SKILLS);
  const execL = hasSkills ? 'L2' : 'L1';

  // 4. Validation
  const hasTests = fs.existsSync(path.join(cwd, 'tests'));
  const hasCI = fs.existsSync(path.join(cwd, '.github', 'workflows'));
  const validL = hasTests && hasCI ? 'L3' : hasTests ? 'L2' : 'L1';

  // 5. Improvement: reflection rate from solutions
  let reflectionRate = 0;
  try {
    if (exists(ME_SOLUTIONS)) {
      const solFiles = fs.readdirSync(ME_SOLUTIONS).filter(f => f.endsWith('.md'));
      if (solFiles.length > 0) {
        let reflected = 0;
        for (const f of solFiles) {
          try {
            const content = fs.readFileSync(path.join(ME_SOLUTIONS, f), 'utf-8');
            const match = content.match(/reflected:\s*(\d+)/);
            if (match && parseInt(match[1], 10) > 0) reflected++;
          } catch { /* skip */ }
        }
        reflectionRate = Math.round((reflected / solFiles.length) * 100);
      }
    }
  } catch { /* fail-open */ }
  const improvL = reflectionRate > 0 ? 'L3' : solutionsCount > 0 ? 'L2' : 'L1';

  const levelIcon = (l: string) => l === 'L3' ? '✓' : l === 'L2' ? '✓' : l === 'L1' ? '✗' : '✗';

  console.log(`  Axis               Level  Detail`);
  console.log(`  ${'─'.repeat(55)}`);
  console.log(`  ${levelIcon(prepL)} Preparation        ${prepL}     CLAUDE.md:${hasClaude ? 'yes' : 'no'}, rules:${rulesCount}, hooks:${hooksActive}`);
  console.log(`  ${levelIcon(ctxL)} Context            ${ctxL}     solutions:${solutionsCount}, behavior:${behaviorCount}`);
  console.log(`  ${levelIcon(execL)} Execution          ${execL}     skills:${hasSkills ? 'yes' : 'no'}`);
  console.log(`  ${levelIcon(validL)} Validation         ${validL}     tests:${hasTests ? 'yes' : 'no'}, CI:${hasCI ? 'yes' : 'no'}`);
  console.log(`  ${levelIcon(improvL)} Improvement        ${improvL}     reflection:${reflectionRate}%`);
  console.log();

  // Quick wins: suggest for lowest scoring axes
  const axes = [
    { name: 'Preparation', level: prepL, hint: 'Add CLAUDE.md + .claude/rules/ files' },
    { name: 'Context', level: ctxL, hint: 'Run /compound to accumulate solutions' },
    { name: 'Execution', level: execL, hint: 'Promote solutions to skills' },
    { name: 'Validation', level: validL, hint: 'Add tests/ dir and .github/workflows' },
    { name: 'Improvement', level: improvL, hint: 'Reflect on existing solutions' },
  ];
  const quickWins = axes.filter(a => a.level === 'L0' || a.level === 'L1').slice(0, 3);
  if (quickWins.length > 0) {
    console.log('  Quick Wins (Top 3):');
    for (const win of quickWins) {
      console.log(`  → ${win.name}: ${win.hint}`);
    }
    console.log();
  }

  // State bloat check — session-scoped files accumulate until pruned.
  console.log('  [State Hygiene]');
  const sessionFiles = countSessionScopedFiles();
  if (sessionFiles === 0) {
    console.log('  ✓ no session-scoped state files');
  } else if (sessionFiles < 500) {
    console.log(`  ✓ ${sessionFiles} session-scoped files (under threshold)`);
  } else {
    console.log(`  ⚠ ${sessionFiles} session-scoped files (bloat threshold 500)`);
    console.log('    Run: forgen doctor --prune-state   (removes files older than 7 days)');
  }
  if (opts.pruneState) {
    const report = pruneState({ dryRun: false });
    const mb = (report.bytesFreed / 1024 / 1024).toFixed(2);
    console.log(`  → Pruned ${report.pruned}/${report.scanned} files (${mb} MB freed, >${report.retentionDays}d old)`);

    // ADR-002 T4 — 90d 미주입 rule retire. pruneState 와 함께 "하루 한번 정돈" 의미 공유.
    try {
      const { runDailyT4Decay } = await import('./state-gc.js');
      const t4 = await runDailyT4Decay({ dryRun: false });
      if (t4.retired > 0) {
        console.log(`  → Retired ${t4.retired} rule(s) (T4 time-decay): ${t4.sample.join(', ')}`);
      }
    } catch { /* fail-open */ }
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

  // [Summary] — 최종 상태 요약과 복구 액션을 한눈에 보이게
  console.log('  [Summary]');
  if (failedChecks.length === 0) {
    console.log('  ✓ All diagnostics passed. Forgen is ready.');
  } else {
    console.log(`  ✗ ${failedChecks.length} check(s) failed:\n`);
    const bySection = new Map<string, FailedCheck[]>();
    for (const f of failedChecks) {
      if (!bySection.has(f.section)) bySection.set(f.section, []);
      bySection.get(f.section)!.push(f);
    }
    for (const [sec, items] of bySection) {
      console.log(`    [${sec}]`);
      for (const item of items) {
        console.log(`      • ${item.label}`);
        if (item.hint) console.log(`        → ${item.hint}`);
      }
    }
    console.log('\n  Run `forgen doctor` again after applying the fixes above.');
  }
  console.log();
}
