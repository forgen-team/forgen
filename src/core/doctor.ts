import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FORGEN_HOME, LAB_DIR, ME_BEHAVIOR, ME_DIR, ME_SOLUTIONS, ME_RULES, SESSIONS_DIR, STATE_DIR, V1_SESSIONS_DIR } from './paths.js';
import { getTimingStats } from '../hooks/shared/hook-timing.js';
import { countSessionScopedFiles, pruneState } from './state-gc.js';
import { summarizeAllByHost } from '../store/host-mismatch.js';
import { readForgeLoopState } from '../hooks/shared/forge-loop-state.js';
import { effortAdvisory } from './effort-advisory.js';
import { forgenRunShimPath } from '../host/claude-shim.js';
import { collectProbes, detectHosts, type Probe } from './doctor-verify.js';

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

/** 실패로 세지 않는 정보 줄 (△) */
function info(label: string, hint?: string): void {
  console.log(`  △ ${label}${hint ? ` — ${hint}` : ''}`);
}

function printProbes(probes: Probe[]): void {
  for (const p of probes) {
    if (p.info) info(p.label, p.hint);
    else check(p.label, p.ok, p.hint);
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

/** ADR-014 D4 — [Codex Hooks] 섹션: hooks.json forgen 엔트리의 Codex trust 기록 대조 */
async function renderCodexHookTrust(): Promise<void> {
  try {
    const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const hooksPath = path.join(codexHome, 'hooks.json');
    if (!fs.existsSync(hooksPath)) return; // Codex 미설치/미등록 — 섹션 생략
    const { auditCodexHookTrust } = await import('../host/install-codex.js');
    // pkgRoot: dist/core/doctor.js → 두 단계 위. 어차피 FORGEN_HOOK_SCRIPT_MARKER fallback 이 있어 정확도 비의존.
    const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const t = auditCodexHookTrust({ hooksPath, configTomlPath: path.join(codexHome, 'config.toml'), pkgRoot });
    console.log('  [Codex Hooks]');
    if (t.total === 0) {
      console.log('  △ hooks.json 에 forgen hook 없음 — forgen install codex');
    } else if (t.trusted === t.total) {
      console.log(`  ✓ ${t.trusted}/${t.total} forgen hooks trusted by Codex`);
    } else if (t.noStateRecorded) {
      console.log(`  △ ${t.total} forgen hooks registered, Codex trust 기록 없음 — codex 안에서 /hooks 로 승인 (미승인 훅은 skip 됨)`);
    } else {
      const pending = [...t.modified.map((k) => `${k} modified`), ...t.untrusted.map((k) => `${k} new`), ...t.disabled.map((k) => `${k} disabled`)];
      console.log(`  ✗ ${pending.length}/${t.total} forgen hooks skipped by Codex (${pending.slice(0, 4).join(', ')}${pending.length > 4 ? ', …' : ''}) — codex 안에서 /hooks 로 승인`);
    }
    // ADR-016 D1 — notify 폴백이 관측한 "턴은 끝났는데 forgen 훅이 돌지 않음"
    const { readCodexHooksSilent } = await import('../host/codex-notify.js');
    const silent = readCodexHooksSilent();
    // 1회 관측은 Stop 훅이 돌지 않는 내부 서브세션(/review 등)의 notify 일 수 있다 — 연속 2회부터 표시.
    if (silent && silent.count >= 2) {
      console.log(`  ✗ notify 폴백 관측: 최근 Codex 턴 ${silent.count}회에서 forgen 훅 미발화 (마지막 ${silent.detectedAt}, session ${silent.sessionId.slice(0, 8)}) — /hooks 승인 필요`);
    }
  } catch { /* fail-open */ }
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
   *  `forgen dev migrate tenetx` 가 수행). native /doctor 가 비용을 flag 하면
   *  forgen 이 provenance 로 안전하게 회수하는 보완 관계. */
  reclaim?: boolean;
  /** W2-1 (ADR-010): hook timing 표 등 상세 진단 표시. slow-hook 감지는
   *  native /doctor 영역이라 기본 출력에서 강등됨 (수집은 유지). */
  verbose?: boolean;
}

/** 고정 shim 이 가리키는 패키지가 살아 있는가 (collectProbes 의 shim 항목과 같은 판정). */
export function shimTargetOk(homeDir: string = os.homedir()): boolean {
  try {
    const content = fs.readFileSync(forgenRunShimPath(homeDir), 'utf-8');
    const pkg = content.match(/^FORGEN_PKG='(.*)'$/m)?.[1];
    return !!pkg && exists(path.join(pkg, 'dist', 'cli.js'));
  } catch { return false; }
}

/** 실행 중인 forgen 패키지 루트 (dist/core/doctor.js 기준 두 단계 위) */
function currentPkgRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * `--repair`: 설치와 같은 경로(planClaudeInstall)로 shim·settings hook·statusLine·MCP·명령·스킬을 다시 쓴다.
 * 실행했다는 사실이 아니라 호출부가 재검증한 결과를 보고한다.
 */
async function reinstallForRepair(): Promise<boolean> {
  try {
    const { planClaudeInstall } = await import('../host/install-claude.js');
    const r = planClaudeInstall({ pkgRoot: currentPkgRoot(), homeDir: os.homedir() });
    console.log(`\n  [Repair] 재설치 경로 실행 — hooks ${r.hooksInjected}, MCP ${r.mcpRegistered ? '재등록' : '유지'}, statusLine ${r.statusLine}`);
    for (const e of r.errors) console.warn(`  [Repair] 오류: ${e}`);
    return r.errors.length === 0;
  } catch (e) {
    console.warn(`  [Repair] 실패: ${e instanceof Error ? e.message : String(e)}`);
    console.warn('  [Repair] 수동 복구: npm i -g @wooojin/forgen  (또는 forgen install claude)');
    return false;
  }
}

/** W1-1: --reclaim 스캔 (읽기 전용) — full/quick 양쪽에서 재사용 */
async function runReclaimScan(): Promise<void> {
  try {
    const { runReclaim, printReclaimResult } = await import('./migrate-tenetx.js');
    printReclaimResult(runReclaim({ cwd: process.cwd(), dryRun: true }));
    console.log('    실제 회수: forgen dev migrate tenetx [--yes] [--apply-settings]');
  } catch (e) {
    console.warn(`  [reclaim] 스캔 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log();
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  failedChecks = [];
  console.log('\n  Forgen — Diagnostics');
  // ADR-010 W2-1 경계 선언: 일반 환경 건강(컨텍스트 비용, unused skill/MCP,
  // CLAUDE.md 정리, slow hook)은 native /doctor 의 영역. 이 명령은 forgen
  // 자체 기계(hook·MCP·statusLine 실행 체인, 데이터 파일)와 효과-측정 게이트만 본다.
  console.log('  환경 전반 진단은 Claude Code native /doctor 를 사용하세요.');
  console.log('  이 명령은 forgen 자체 기계를 실제로 실행해 검사합니다.\n');

  const hosts = detectHosts(os.homedir(), currentPkgRoot());
  section('Tools');
  // Claude 에 설치하지 않은 사용자(Codex 전용·갓 설치 전)에게 claude CLI 부재는 고장이 아니다.
  if (hosts.claude) check('claude CLI', commandExists('claude'));
  else if (!commandExists('claude')) info('claude CLI 없음', 'forgen 이 Claude Code 에 설치돼 있지 않아 필수 아님');
  else info('claude CLI 있음', 'forgen 은 아직 Claude Code 에 설치되지 않음: forgen install claude');
  check('git', commandExists('git'));
  if (!commandExists('tmux')) info('tmux 없음', '선택 사항 (tmux 안에서 쓰면 auto-compound 알림이 보임)');
  if (!commandExists('gh')) info('gh (GitHub CLI) 없음', '선택 사항 (팀 PR 기능에만 필요): brew install gh');
  if (!exists(path.join(os.homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', 'ralph-loop'))) {
    info('ralph-loop 플러그인 없음', '선택 사항 (ralph 모드 자동 반복에만 필요): claude plugins install ralph-loop');
  }
  console.log();

  // 설치 체인 검증 — settings hook·MCP·statusLine·shim 을 실제로 실행해 본다.
  const verifyOpts = { homeDir: os.homedir(), forgenHome: FORGEN_HOME, pkgRoot: currentPkgRoot(), skipExec: !!opts.quick };
  let probes = await collectProbes(verifyOpts);
  if (opts.repair && probes.some((p) => !p.ok && !p.info)) {
    const before = probes.filter((p) => !p.ok && !p.info).length;
    await reinstallForRepair();
    probes = await collectProbes(verifyOpts);
    const after = probes.filter((p) => !p.ok && !p.info);
    console.log(after.length === 0
      ? `  [Repair] ✓ 복구 확인 — 재검증 통과 (실패 ${before} → 0)`
      : `  [Repair] ✗ 재검증 후에도 ${after.length}건 남음 (이전 ${before}건) — 아래 항목은 재설치로 고쳐지지 않음\n`);
  }
  const bySection = new Map<string, Probe[]>();
  for (const p of probes) bySection.set(p.section, [...(bySection.get(p.section) ?? []), p]);
  for (const name of ['Install', 'Execution', 'Statusline']) {
    const list = bySection.get(name);
    if (!list) continue;
    section(name);
    printProbes(list);
    console.log();
  }

  section('Directories');
  // Claude 설치(shim·데이터가 여기에 있음)가 있는데 없으면 고장. 아직 어느 호스트에도 안 썼거나 Codex 전용이면 첫 실행 때 만들어진다.
  if (hosts.claude) check('~/.forgen/', exists(FORGEN_HOME));
  else if (exists(FORGEN_HOME)) check('~/.forgen/', true);
  else info('~/.forgen/ 아직 없음', '첫 세션에서 만들어짐');
  // 하위 폴더는 첫 사용·첫 세션에 런타임이 만든다. 없다고 고장이 아니다.
  for (const [label, dir] of [
    ['~/.forgen/me/', ME_DIR],
    ['~/.forgen/me/solutions/', ME_SOLUTIONS],
    ['~/.forgen/me/behavior/', ME_BEHAVIOR],
    ['~/.forgen/me/rules/', ME_RULES],
    ['~/.forgen/sessions/ (session logs)', SESSIONS_DIR],
    ['~/.forgen/state/sessions/ (v1 effective state)', V1_SESSIONS_DIR],
  ] as const) {
    if (exists(dir)) check(label, true);
    else info(`${label} 아직 없음`, '첫 세션에서 만들어짐');
  }

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

  section('Data');
  printProbes(bySection.get('Data') ?? []);
  const hookHealth = bySection.get('Hook Health');
  if (hookHealth) { section('Hook Health 24h'); printProbes(hookHealth); }
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
    return failedChecks.length;
  }

  // 리뷰 SEV-3 (c): critic-review 룰의 트리거가 stale(skip-review 시그널 미포함)이면 발견 nudge.
  // "고쳤는데 기존 유저에겐 안 닿는" 상태 방지 — 재-bake 명령을 안내한다.
  section('Rules');
  try {
    const [{ loadActiveRules }, { needsCriticTriggerMigration }] = await Promise.all([
      import('../store/rule-store.js'),
      import('../engine/enforce-classifier.js'),
    ]);
    const outdated = loadActiveRules().filter(needsCriticTriggerMigration);
    check(
      'critic-review 룰 트리거 최신',
      outdated.length === 0,
      `${outdated.length}개 critic 룰이 구 트리거(skip-review 미포함) — \`forgen rule classify --apply --force\` 로 갱신 권장`,
    );
  } catch {
    /* rule-store 로드 실패는 무해 — 스킵 */
  }
  console.log();

  section('Environment');
  info(`tmux: ${process.env.TMUX ? '안에서 실행 중' : '밖에서 실행 중'}`, '정보 표시 (실패로 세지 않음)');
  info(`FORGEN_HARNESS: ${(process.env.FORGEN_HARNESS ?? process.env.COMPOUND_HARNESS) === '1' ? '설정됨' : '미설정'}`, '`forgen` / `fgx` 런처가 설정하는 값. 이 진단 셸에서는 정상적으로 비어 있을 수 있음');
  // ADR-012: auto-compound Haiku 추출 동의 상태 고지 (transcript 요약 API 전송 여부).
  try {
    const { getHaikuConsentState } = await import('./compound-consent.js');
    const s = getHaikuConsentState();
    console.log(
      `  auto-compound Haiku 추출: ${s.enabled ? 'ON' : 'OFF'} (${s.source}) — ` +
      `${s.enabled ? '세션 요약이 내 계정의 Haiku 로 전송됨(비밀키 마스킹)' : '결정론 룰 승급만(전송 없음)'}. 변경: forgen compound consent on|off`,
    );
  } catch { /* noop */ }
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

  // Hook Timing: W2-1 (ADR-010) — slow hook 감지는 native /doctor 가 하므로
  // 표시는 --verbose 로 강등. 수집(hook-timing.jsonl)은 자체 회귀 테스트용으로 유지.
  if (opts.verbose) {
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
  }

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

  // W2-1 (ADR-010): Harness Maturity / Quick Wins 섹션 제거 —
  // "CLAUDE.md 추가하세요" 류 일반 셋업 조언은 native /doctor 영역.
  // forgen 고유 진단(아래 State Hygiene, ψ-long, parity 등)만 유지한다.

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
          console.log('  → 전체 보기: forgen dev regress-map');
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

  // [Codex Hooks] — ADR-014 D4 trust 감사
  await renderCodexHookTrust();


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

  // [Effort] — ADR-009 §5 nudge-only. W2-1 (ADR-010): Sonnet 5 는 adaptive
  // thinking 으로 effort 를 자체 관리하므로, 권고가 실제로 의미 있는 상황
  // (forge-loop 활성 = long-running → xhigh 넛지)에서만 표시한다.
  try {
    const loopActive = !!readForgeLoopState()?.active;
    if (loopActive) {
      const adv = effortAdvisory({ longRunningActive: true });
      console.log('  [Effort]');
      console.log(`  → recommend: ${adv.recommend}`);
      console.log(`    ${adv.reason}`);
      console.log();
    }
  } catch { /* effort 권고 실패는 침묵 — 부가 정보일 뿐 */ }

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
  return failedChecks.length;
}
