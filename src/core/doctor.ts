import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FORGEN_HOME, LAB_DIR, ME_BEHAVIOR, ME_DIR, ME_SOLUTIONS, ME_RULES, ME_SKILLS, PACKS_DIR, SESSIONS_DIR, STATE_DIR, V1_SESSIONS_DIR } from './paths.js';
import { getTimingStats } from '../hooks/shared/hook-timing.js';
import { countSessionScopedFiles, pruneState } from './state-gc.js';
import { summarizeAllByHost } from '../store/host-mismatch.js';
import { readForgeLoopState } from '../hooks/shared/forge-loop-state.js';
import { effortAdvisory } from './effort-advisory.js';

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

/** parity-result.json 내용에서 경과 시간을 사람이 읽기 좋은 문자열로 변환 */
function relativeTime(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours === 0) {
      const diffMins = Math.floor(diffMs / (1000 * 60));
      return `${diffMins}m ago`;
    }
    return `${diffHours}h ago`;
  }
  return `${diffDays}d ago`;
}

/** [Codex Parity] 섹션 렌더링 — ~/.forgen/state/parity-result.json 신선도 검사 */
function renderCodexParity(): void {
  console.log('  [Codex Parity]');
  const parityPath = path.join(STATE_DIR, 'parity-result.json');

  if (!fs.existsSync(parityPath)) {
    console.log('  △ Codex parity 미실행 — tests/e2e/codex/run-parity.sh 또는 forgen parity codex');
    return;
  }

  let data: { passed?: boolean | null; at?: string; version?: string; result?: string; note?: string };
  try {
    data = JSON.parse(fs.readFileSync(parityPath, 'utf-8'));
  } catch {
    console.log('  ✗ Codex parity — parity-result.json 파싱 실패');
    return;
  }

  if (data.passed === null || data.passed === undefined) {
    console.log('  △ Codex parity dry-run only — 실 실행 필요');
    return;
  }

  if (!data.passed) {
    const timeStr = data.at ? relativeTime(data.at) : 'unknown';
    const detail = data.result ?? data.note ?? 'no detail';
    console.log(`  ✗ Codex parity FAILED (at: ${timeStr}, detail: ${detail})`);
    return;
  }

  // passed === true
  const timeStr = data.at ? relativeTime(data.at) : 'unknown';
  const version = data.version ? ` version ${data.version}` : '';
  const diffMs = data.at ? Date.now() - new Date(data.at).getTime() : Infinity;
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  if (diffMs > sevenDaysMs) {
    console.log(`  △ Codex parity green but stale (last run: ${timeStr}) — 재실행 권장`);
  } else {
    console.log(`  ✓ Codex parity green (last run: ${timeStr},${version})`);
  }
}

export interface DoctorOptions {
  /** When true, delete stale session-scoped state files instead of just
   *  reporting bloat. Triggered by `forgen doctor --prune-state`. */
  pruneState?: boolean;
  /**
   * When true, auto-fix recoverable failures (e.g. missing plugin cache /
   * stale installPath) by running `node scripts/postinstall.js` inside the
   * forgen install directory (`npm run build` 는 dist 부재 시에만 — W1-4).
   * Triggered by `forgen doctor --repair`.
   *
   * v0.4.8 (E3) — 이전엔 안내문만 출력. fail-open: repair 실패해도 doctor
   * 흐름은 정상 종료. W1-4 (ADR-010) — 실행 사실이 아니라 재검증 결과를 보고.
   */
  repair?: boolean;
  /** When true, run only essential checks (Tools + Plugins + Directories +
   *  Initialization Status) for fast onboarding verification. ~10 lines output. */
  quick?: boolean;
  /** W1-1 (ADR-010): tenetx/legacy 규칙 스프롤 스캔 (dry-run — 삭제는
   *  `forgen migrate tenetx` 가 수행). native /doctor 가 비용을 flag 하면
   *  forgen 이 provenance 로 안전하게 회수하는 보완 관계. */
  reclaim?: boolean;
}

/** plugin cache 디렉토리에 버전 엔트리가 하나 이상 있는가 (check + repair 재검증 공용) */
export function pluginCacheOk(): boolean {
  const pluginCacheBase = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'forgen-local', 'forgen');
  if (!exists(pluginCacheBase)) return false;
  try {
    return fs.readdirSync(pluginCacheBase).some(f => {
      try {
        const lstat = fs.lstatSync(path.join(pluginCacheBase, f));
        return lstat.isDirectory() || lstat.isSymbolicLink();
      } catch { return false; }
    });
  } catch { return false; }
}

/** installed_plugins.json 의 forgen entry 가 존재하며 installPath 가 살아있는가 */
export function pluginRegisteredOk(): boolean {
  const installedPluginsPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  if (!exists(installedPluginsPath)) return false;
  try {
    const installed = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf-8'));
    const entry = installed?.plugins?.['forgen@forgen-local'];
    if (Array.isArray(entry) && entry.length > 0) {
      const installPath = entry[0]?.installPath;
      return !!installPath && exists(installPath);
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * v0.4.8 (E3): plugin cache / installPath 진단이 실패했을 때 자동 복구.
 * 실패해도 doctor 자체는 계속 진행 (fail-open).
 *
 * W1-4 수정 (ADR-010, 실측 2026-07-16): 이전 구현은 무조건 `npm run build` 를
 * 먼저 실행했는데, 글로벌 설치엔 devDeps(tsc)가 없어 MODULE_NOT_FOUND 로 실패
 * → postinstall 에 도달하지 못해 캐시가 영원히 복구되지 않았다. published
 * 패키지는 dist 가 이미 있으므로 build 는 dist 부재(dev checkout)시에만 시도.
 * 또한 "실행했다"가 아니라 "복구됐다"를 재검증 후 보고한다.
 */
function attemptPluginRepair(): boolean {
  try {
    // forgen 패키지 루트 = 현재 파일에서 dist/core/doctor.js 위치 → pkgRoot.
    // dev (src/) 와 prod (dist/) 양쪽 모두 path.resolve(...,'..','..') 로 도달.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgRoot = path.resolve(here, '..', '..');
    console.log(`\n  [Repair] forgen 패키지 자가복구 시도 — ${pkgRoot}`);
    if (!exists(path.join(pkgRoot, 'dist', 'cli.js'))) {
      // dev checkout 등 dist 부재 시에만 build (devDeps 가 있는 환경)
      execFileSync('npm', ['run', 'build'], { cwd: pkgRoot, stdio: 'inherit' });
    }
    execFileSync('node', ['scripts/postinstall.js'], { cwd: pkgRoot, stdio: 'inherit' });

    // 결과 재검증 — 성공 주장은 검증된 상태에만 한다.
    const ok = pluginCacheOk() && pluginRegisteredOk();
    if (ok) {
      console.log('  [Repair] ✓ 복구 확인 — plugin cache/registry 재검증 통과');
    } else {
      console.warn('  [Repair] ✗ postinstall 은 실행됐지만 재검증 실패 — 수동 확인 필요');
      console.warn('  [Repair] 수동 복구: cd <forgen pkgRoot> && node scripts/postinstall.js');
    }
    return ok;
  } catch (e) {
    console.warn(`  [Repair] 실패: ${e instanceof Error ? e.message : String(e)}`);
    console.warn('  [Repair] 수동 복구: cd <forgen pkgRoot> && node scripts/postinstall.js (dist 부재 시 npm run build 선행)');
    return false;
  }
}

/** W1-1: --reclaim 스캔 (읽기 전용) — full/quick 양쪽에서 재사용 */
async function runReclaimScan(): Promise<void> {
  try {
    const { runReclaim, printReclaimResult } = await import('./migrate-tenetx.js');
    printReclaimResult(runReclaim({ cwd: process.cwd(), dryRun: true }));
    console.log('    실제 회수: forgen migrate tenetx [--yes] [--apply-settings]');
  } catch (e) {
    console.warn(`  [reclaim] 스캔 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log();
}

/** W1-4: repair 성공 시 Summary 에서 걷어내는 대상 — check() 라벨과 단일 소스 */
const REPAIRABLE_PLUGIN_LABELS = Object.freeze({
  cache: 'forgen plugin cache',
  registered: 'forgen plugin registered & installPath exists',
});

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

  // forgen 플러그인 캐시 / registry 정합성 — 훅 실행의 필수 전제
  const forgenPluginCacheOk = pluginCacheOk();
  check(REPAIRABLE_PLUGIN_LABELS.cache, forgenPluginCacheOk,
    opts.repair
      ? 'Hook execution requires plugin cache. Attempting auto-repair (--repair)…'
      : 'Hook execution requires plugin cache. Fix: node scripts/postinstall.js in the forgen package (or rerun with --repair)');

  const pluginRegistered = pluginRegisteredOk();
  check(REPAIRABLE_PLUGIN_LABELS.registered, pluginRegistered,
    opts.repair
      ? 'Plugin registered but installPath missing on disk. Attempting auto-repair (--repair)…'
      : 'Plugin registered but installPath missing on disk. Fix: node scripts/postinstall.js in the forgen package (or rerun with --repair)');

  // v0.4.8 (E3) + W1-4: plugin cache 또는 installPath 가 깨졌고 --repair 가
  // 켜져 있으면 자가복구. 재검증까지 통과하면 failedChecks 에서 해당 항목을
  // 걷어내 Summary 가 복구된 상태를 정직하게 반영하게 한다.
  if (opts.repair && (!forgenPluginCacheOk || !pluginRegistered)) {
    const repaired = attemptPluginRepair();
    if (repaired) {
      const pluginLabels = new Set<string>(Object.values(REPAIRABLE_PLUGIN_LABELS));
      failedChecks = failedChecks.filter(f => !pluginLabels.has(f.label));
    }
  }
  console.log();

  section('Directories');
  check('~/.forgen/', exists(FORGEN_HOME));
  check('~/.forgen/me/', exists(ME_DIR));
  check('~/.forgen/me/solutions/', exists(ME_SOLUTIONS));
  check('~/.forgen/me/behavior/', exists(ME_BEHAVIOR));
  check('~/.forgen/me/rules/', exists(ME_RULES));
  check('~/.forgen/packs/', exists(PACKS_DIR));
  check('~/.forgen/sessions/ (session logs)', exists(SESSIONS_DIR));
  check('~/.forgen/state/sessions/ (v1 effective state)', exists(V1_SESSIONS_DIR));

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

  section('Initialization Status');
  const profilePath = path.join(ME_DIR, 'forge-profile.json');
  const profileOk = exists(profilePath);
  check('Profile exists (forge-profile.json)', profileOk,
    'No profile — run `forgen` to complete onboarding');
  const hooksWired = forgenPluginCacheOk || pluginRegistered;
  if (hooksWired && !profileOk) {
    check('Hooks wired + profile ready', false,
      'Hooks are active but personalization is disabled — run `forgen` to onboard');
  } else if (hooksWired && profileOk) {
    check('Hooks wired + profile ready', true);
  }
  console.log();

  if (opts.quick) {
    // --reclaim 은 읽기 전용 스캔이라 --quick 과 조합 가능 (silent-ignore 방지)
    if (opts.reclaim) await runReclaimScan();
    console.log();
    if (failedChecks.length === 0) {
      console.log('  All essential checks passed.\n');
    } else {
      console.log(`  ${failedChecks.length} issue(s) found. Run \`forgen doctor\` for full diagnostics.\n`);
    }
    return;
  }

  section('Environment');
  check('Inside tmux session', !!process.env.TMUX,
    'FORGEN auto-compound relies on tmux. Launch: tmux new -s forgen');
  check('FORGEN_HARNESS env var', (process.env.FORGEN_HARNESS ?? process.env.COMPOUND_HARNESS) === '1',
    'Set by `forgen` / `fgx` launcher. Hooks assume harness mode is active.');
  console.log();

  // v0.4.1 파일 확장자 버그 수정: rules 는 .json, behavior 도 대부분 .json 포맷.
  // 이전에 .md 만 count 해서 실 rules 4개인데 0 으로 표시되는 incident 관찰.
  // (compound-export countFiles 와 동일 결함 — 일관된 수정).
  const isKnowledgeFile = (f: string) => f.endsWith('.md') || f.endsWith('.json');
  if (exists(ME_SOLUTIONS)) {
    const solutions = fs.readdirSync(ME_SOLUTIONS).filter(isKnowledgeFile).length;
    console.log(`  Personal solutions: ${solutions}`);
  }
  if (exists(ME_BEHAVIOR)) {
    const behavior = fs.readdirSync(ME_BEHAVIOR).filter(isKnowledgeFile).length;
    console.log(`  Behavioral patterns: ${behavior}`);
  }
  if (exists(ME_RULES)) {
    // v0.4.1 정확도: removed 상태 rule 은 "학습된 규칙" 에서 제외하고 별도 표시.
    // 이전에는 디렉터리 파일 수만 세어 이미 제거된 rule 도 count 되어 판매 관점
    // "살아있는 규칙" 수치가 부풀려짐. 실제 구매자 가치는 active + suppressed.
    const ruleFiles = fs.readdirSync(ME_RULES).filter(isKnowledgeFile);
    let active = 0, suppressed = 0, removed = 0;
    for (const f of ruleFiles) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(ME_RULES, f), 'utf-8')) as { status?: string };
        if (d.status === 'active') active++;
        else if (d.status === 'suppressed') suppressed++;
        else if (d.status === 'removed' || d.status === 'superseded') removed++;
      } catch { /* skip */ }
    }
    const live = active + suppressed;
    const removedTag = removed > 0 ? ` (${removed} removed/superseded)` : '';
    console.log(`  Personal rules: ${live}  [active:${active} suppressed:${suppressed}]${removedTag}`);
  }
  console.log();

  console.log('  [Log Locations]');
  console.log(`  Session logs:       ${SESSIONS_DIR}`);
  if (exists(SESSIONS_DIR)) {
    const sessionCount = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).length;
    console.log(`  Saved sessions:     ${sessionCount}`);
  }
  // v0.4.8 (A3): v1 effective state directory 도 가시화 — 두 dir 책임 다름.
  console.log(`  V1 effective state: ${V1_SESSIONS_DIR}`);
  if (exists(V1_SESSIONS_DIR)) {
    const stateCount = fs.readdirSync(V1_SESSIONS_DIR).filter((f) => f.endsWith('.json')).length;
    console.log(`  V1 state count:     ${stateCount}`);
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
    console.log(`  ${'-'.repeat(56)}`);
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

    // 0.4.6 #14 — append-only jsonl 회전 (10MB cap)
    try {
      const { rotateAppendOnlyLogs } = await import('./state-gc.js');
      const rot = rotateAppendOnlyLogs();
      if (rot.rotated > 0) {
        console.log(`  → Rotated ${rot.rotated}/${rot.scanned} append-only log(s): ${rot.sample.join(', ')}`);
      }
    } catch { /* fail-open */ }

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
  // P4 셀프 가드: fix:feat 비율 30% 초과 시 회귀 패턴 의심 경고.
  try {
    const { computeFixFeatRatio, formatFixRatio, computeRegressMap } = await import('./git-stats.js');
    const ratio = computeFixFeatRatio();
    if (ratio.available) {
      console.log(`  ${formatFixRatio(ratio)}`);
      if (ratio.exceedsThreshold) {
        console.log('  ⚠ fix:feat 비율이 임계값을 초과했습니다. "이거 고치면 저거 버그난다" 패턴 의심 — 검증 레이어 invariant 점검 권장.');
        const map = computeRegressMap(process.cwd(), 30, 3);
        if (map.available && map.hotspots.length > 0) {
          const top = map.hotspots.map((h) => `${h.path} (${h.fixHits})`).join(', ');
          console.log(`  → 진앙 후보 top 3: ${top}`);
          console.log('  → 전체 보기: forgen regress-map');
        }
      }
    }
  } catch { /* fail-open */ }
  console.log();

  // [Multi-Host] — host 별 evidence 분포
  console.log('  [Multi-Host]');
  try {
    const hostStats = summarizeAllByHost();
    if (hostStats.total === 0) {
      console.log('  No evidence recorded yet.');
    } else {
      const claudePct = hostStats.total > 0 ? Math.round((hostStats.claude / hostStats.total) * 100) : 0;
      const codexPct = hostStats.total > 0 ? Math.round((hostStats.codex / hostStats.total) * 100) : 0;
      console.log(`  Registered hosts: claude, codex`);
      console.log(`  Evidence by host: claude:${hostStats.claude} (${claudePct}%)  codex:${hostStats.codex} (${codexPct}%)  total:${hostStats.total}`);
      // 한 host 가 80% 이상이면 skew 경고
      const maxShare = Math.max(claudePct, codexPct);
      if (hostStats.total >= 5 && maxShare >= 80) {
        const dominant = claudePct >= codexPct ? 'claude' : 'codex';
        console.log(`  ⚠ evidence 가 ${dominant} 에 ${maxShare}% 집중됨 — 다른 host 에서 학습 데이터 부족 가능`);
      }
    }
  } catch {
    console.log('  Unable to read host evidence data.');
  }
  console.log();

  // [Codex Parity] — parity-result.json 신선도 검사 (v0.4.2 패턴 확장)
  renderCodexParity();
  console.log();

  // [ψ-long] — within-conversation compound 효과 측정 (v0.4.10)
  // 측정 시간이 길어 ship-gate 는 advisory. 신선도(<= 14d) + psiLong > 0 만 확인.
  console.log('  [ψ-long compound]');
  try {
    const psiLongPath = path.join(STATE_DIR, 'psi-long-result.json');
    if (!fs.existsSync(psiLongPath)) {
      console.log('  ○ no measurement yet — `pnpm --filter @wooojin/forgen-eval psi:long` 권장');
    } else {
      const raw = fs.readFileSync(psiLongPath, 'utf-8');
      const data = JSON.parse(raw) as { passed?: boolean; psiLong?: number; at?: string; N?: number };
      const ageMs = data.at ? Date.now() - new Date(data.at).getTime() : Number.POSITIVE_INFINITY;
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      const psiLong = data.psiLong ?? 0;
      const passed = !!data.passed;
      const freshTag = ageDays <= 14 ? 'fresh' : `${ageDays}d stale`;
      const gateLabel = passed ? '✓ PASS' : '✗ FAIL';
      console.log(`  ${gateLabel}  ψ_long=${psiLong.toFixed(3)}  N=${data.N ?? '?'}  (${freshTag})`);
      if (!passed) {
        console.log('  ⚠ within-session compound 효과 미관측 — correction injection / rule trigger 경로 점검');
      } else if (ageDays > 14) {
        console.log('  △ 측정 14일 초과 — 재측정 권장 (`pnpm --filter @wooojin/forgen-eval psi:long`)');
      }
    }
  } catch (e) {
    console.log(`  Unable to read psi-long state: ${e instanceof Error ? e.message : 'unknown'}`);
  }
  console.log();

  // [Effort (Opus 4.8)] — ADR-009 §5. nudge-only: forgen 은 effort 를 직접 설정할 수
  // 없으므로 long-running 컨텍스트(forge-loop)에서 xhigh/ultracode 를 권고만 한다.
  console.log('  [Effort (Opus 4.8)]');
  try {
    const loopActive = !!readForgeLoopState()?.active;
    const adv = effortAdvisory({ longRunningActive: loopActive });
    const icon = adv.recommend === 'xhigh' ? '→' : '✓';
    console.log(`  ${icon} recommend: ${adv.recommend}`);
    console.log(`    ${adv.reason}`);
  } catch {
    console.log('  Unable to compute effort advisory.');
  }
  console.log();

  // W1-1 (ADR-010): --reclaim → legacy 규칙 스프롤 스캔 (읽기 전용).
  if (opts.reclaim) await runReclaimScan();

  // [Summary] — 최종 상태 요약과 복구 액션을 한눈에 보이게
  console.log('  [Summary]');
  if (failedChecks.length === 0) {
    console.log('  ✓ All diagnostics passed. Forgen is ready.');
  } else {
    console.log(`  ✗ ${failedChecks.length} check(s) failed:\n`);
    const bySection = new Map<string, FailedCheck[]>();
    for (const f of failedChecks) {
      if (!bySection.has(f.section)) bySection.set(f.section, []);
      bySection.get(f.section)?.push(f);
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
