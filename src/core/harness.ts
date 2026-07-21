/**
 * Forgen v1 — Core Harness (prepareHarness entry point)
 *
 * v1 설계: v1-bootstrap 기반 세션 오케스트레이션.
 * philosophy/scope/pack 의존 제거. Profile + Preset Manager + Rule Renderer.
 *
 * Module Structure:
 * - Lines 1-50: Imports, utility helpers
 * - Lines 50-120: Rule file injection, gitignore, compound memory
 * - Lines 120+: prepareHarness — main orchestration
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv, generateClaudeRuleFiles, registerTmuxBindings } from './config-injector.js';
import { createLogger } from './logger.js';
import { HANDOFFS_DIR, ME_BEHAVIOR, ME_DIR, ME_RULES, ME_SKILLS, ME_SOLUTIONS, SESSIONS_DIR, STATE_DIR, FORGEN_HOME } from './paths.js';
import { RULE_FILE_CAPS } from '../hooks/shared/injection-caps.js';
import { recordRenderedFiles } from './rendered-rules-manifest.js';
import type { RuntimeHost } from './types.js';
import {
  rollbackSettings,
} from './settings-lock.js';
import { bootstrapV1Session, ensureV1Directories, type V1BootstrapResult } from './v1-bootstrap.js';
import { injectSettings } from './settings-injector.js';
import { installAgents, installSlashCommands } from './installer.js';
import type { HostId } from './trust-layer-intent.js';
import { getHostCapabilities } from '../host/capabilities-registry.js';
import { getProjection } from '../host/projection.js';
import type { HostBinding, HarnessSessionContext } from '../host/host-binding.js';

const log = createLogger('harness');

/**
 * 0.4.6 — Codex hooks fast staleness check + auto-reconcile.
 *
 * 매 codex 진입 시 hooks.json 의 forgen entry 가 현재 pkgRoot 와 일치하는지
 * 검사. 불일치 또는 부재 시 planCodexInstall 을 silently 재실행.
 *
 * Staleness 판정: hooks.json 안의 첫 codex-adapter.js 경로가 현재 pkgRoot 의
 * dist/host/codex-adapter.js 와 일치 여부.
 *
 * Performance: hot-path 회피를 위해 lazy import + 단순 string match. 정상
 * 케이스에서 1ms 이내. 불일치 시 planCodexInstall (~50ms).
 */
async function ensureCodexHooksFresh(pkgRoot: string): Promise<void> {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const hooksPath = path.join(codexHome, 'hooks.json');
  const expectedAdapterPath = path.join(pkgRoot, 'dist', 'host', 'codex-adapter.js');

  let needsReinstall = false;
  if (!fs.existsSync(hooksPath)) {
    needsReinstall = true;
    log.debug('codex hooks.json 부재 — install 필요');
  } else {
    try {
      const raw = fs.readFileSync(hooksPath, 'utf-8');
      // 가장 간단한 staleness signal: 현재 pkgRoot 의 adapter 경로가 hooks.json 에 나타나는가?
      if (!raw.includes(expectedAdapterPath)) {
        needsReinstall = true;
        log.debug(`codex hooks.json stale (expected ${expectedAdapterPath} 미발견)`);
      }
    } catch (e) {
      needsReinstall = true;
      log.debug('codex hooks.json 읽기 실패 — reinstall', e);
    }
  }

  if (!needsReinstall) return;

  try {
    const { planCodexInstall } = await import('../host/install-codex.js');
    planCodexInstall({ pkgRoot, registerMcp: true });
    log.debug('codex hooks 자동 reconcile 완료');
  } catch (e) {
    log.debug('codex hooks reconcile 실패', e);
  }
}

// ── v1 HarnessContext (simplified) ──

export interface V1HarnessContext {
  cwd: string;
  inTmux: boolean;
  v1: V1BootstrapResult;
  runtime: RuntimeHost;
}

/** forgen 패키지 루트 */
function getPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** 최초 실행 여부: ~/.forgen/ 디렉토리가 없으면 true */
export function isFirstRun(): boolean {
  return !fs.existsSync(FORGEN_HOME);
}

/**
 * A5: all directories under FORGEN_HOME only. Pre-A5 this function
 * also created directories under `~/.compound/` (COMPOUND_HOME), which
 * caused a dual-reality when the migration symlink was broken. Now the
 * migration function handles reading from the old location if needed,
 * but ALL writes go under `~/.forgen/`.
 */
function ensureDirectories(): void {
  const dirs = [
    FORGEN_HOME,
    ME_DIR,
    ME_SOLUTIONS,
    ME_BEHAVIOR,
    ME_RULES,
    ME_SKILLS,
    SESSIONS_DIR,
    STATE_DIR,
    HANDOFFS_DIR,
    path.join(FORGEN_HOME, 'plans'),
    path.join(FORGEN_HOME, 'specs'),
    path.join(FORGEN_HOME, 'artifacts', 'ask'),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
  ensureV1Directories();
}

export { rollbackSettings };

// ── Rule File Injection ──

function injectClaudeRuleFiles(cwd: string, ruleFiles: Record<string, string>): void {
  const PER_RULE_CAP = RULE_FILE_CAPS.perRuleFile;
  const TOTAL_CAP = RULE_FILE_CAPS.totalRuleFiles;

  const projectRulesDir = path.join(cwd, '.claude', 'rules');
  fs.mkdirSync(projectRulesDir, { recursive: true });

  let totalWritten = 0;
  const writtenForManifest: Record<string, string> = {};
  for (const [filename, content] of Object.entries(ruleFiles)) {
    const capped = content.length > PER_RULE_CAP
      ? `${content.slice(0, PER_RULE_CAP)}\n... (capped at rule file limit)\n`
      : content;
    if (totalWritten + capped.length > TOTAL_CAP) {
      log.debug(`rules/ 총량 캡 도달, ${filename} 생략`);
      break;
    }
    // ADR-010 W1-3 (F6 수정): 모든 규칙 파일은 프로젝트 스코프로만 주입한다.
    // 이전에는 `forge-*` 파일명이 글로벌 ~/.claude/rules/ 로 라우팅되어
    // 프로젝트 맥락의 behavioral 패턴이 전 프로젝트 세션에 주입됐다.
    // 목표 상태: 글로벌 rules 디렉토리에 forgen 산출물 0개.
    const target = path.join(projectRulesDir, filename);
    fs.writeFileSync(target, capped);
    writtenForManifest[target] = capped;
    totalWritten += capped.length;
  }

  // ADR-010 W1-1: 쓴 그대로의 content-hash 를 manifest 에 기록 —
  // reclaimer 가 "forgen 산출물 그대로"와 "사용자 편집본"을 구분하는 근거.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(getPackageRoot(), 'package.json'), 'utf-8'));
    recordRenderedFiles(writtenForManifest, String(pkg.version ?? '0.0.0'));
  } catch (e) {
    log.debug('rendered-rules manifest 기록 실패 (fail-open)', e);
  }

  // 마이그레이션 (W1-3): 구버전이 글로벌에 쓴 forge-behavioral.md 회수.
  // (tenetx 계열 글로벌 잔재는 W1-1 reclaimer 의 영역)
  const legacyGlobalBehavioral = path.join(os.homedir(), '.claude', 'rules', 'forge-behavioral.md');
  if (fs.existsSync(legacyGlobalBehavioral)) {
    try { fs.unlinkSync(legacyGlobalBehavioral); } catch (e) { log.debug('레거시 글로벌 behavioral 삭제 실패', e); }
  }

  // 마이그레이션: 이전 위치 파일 제거
  const legacyPath = path.join(cwd, '.claude', 'compound-rules.md');
  if (fs.existsSync(legacyPath)) {
    try { fs.unlinkSync(legacyPath); } catch (e) { log.debug('레거시 규칙 파일 삭제 실패', e); }
  }

  // CLAUDE.md에서 이전 마커 블록 제거
  const claudeMdPath = path.join(cwd, 'CLAUDE.md');
  const marker = '<!-- forgen:start -->';
  const endMarker = '<!-- forgen:end -->';
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    if (content.includes(marker)) {
      const regex = new RegExp(`\\n*${marker}[\\s\\S]*?${endMarker}\\n*`, 'g');
      const cleaned = content
        .replace(regex, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      fs.writeFileSync(claudeMdPath, cleaned ? `${cleaned}\n` : '');
    }
  }
}

// ── Compound Memory ──

function ensureCompoundMemory(cwd: string): void {
  try {
    const sanitized = cwd.replace(/\//g, '-').replace(/^-/, '');
    const memoryDir = path.join(os.homedir(), '.claude', 'projects', sanitized, 'memory');
    if (!fs.existsSync(memoryDir)) return;

    const memoryMdPath = path.join(memoryDir, 'MEMORY.md');
    const compoundPointer = '- [Compound Knowledge](compound-index.md) — accumulated patterns/solutions from past sessions';

    if (fs.existsSync(memoryMdPath)) {
      const content = fs.readFileSync(memoryMdPath, 'utf-8');
      if (content.includes('compound-index.md')) return;
      fs.writeFileSync(memoryMdPath, `${content.trimEnd()}\n${compoundPointer}\n`);
    }

    const indexPath = path.join(memoryDir, 'compound-index.md');
    const solutionsDir = ME_SOLUTIONS;
    let solutionCount = 0;
    try {
      solutionCount = fs.readdirSync(solutionsDir).filter(f => f.endsWith('.md')).length;
    } catch { /* solutions dir may not exist */ }

    const indexContent = [
      '---',
      'name: compound-knowledge-index',
      'description: Forgen compound knowledge — use compound-search MCP tool to find relevant patterns',
      'type: reference',
      '---',
      '',
      `${solutionCount} accumulated solutions available via forgen-compound MCP tools.`,
      '',
      'Use compound-search to find relevant patterns before starting tasks.',
      'Use compound-read to get full solution content.',
    ].join('\n');
    fs.writeFileSync(indexPath, indexContent);
  } catch {
    // auto memory 접근 실패는 무시
  }
}

// ── Gitignore ──

function ensureGitignore(cwd: string): void {
  const gitignorePath = path.join(cwd, '.gitignore');
  const forgenEntries = [
    '# Forgen (auto-generated, do not commit)',
    '.claude/agents/ch-*.md',
    '.claude/agents/pack-*.md',
    '.claude/rules/project-context.md',
    '.claude/rules/routing.md',
    '.claude/rules/forge-*.md',
    '.claude/rules/v1-rules.md',
    '.compound/project-map.json',
    '.claude/commands/forgen/',
    '.compound/notepad.md',
  ];
  const marker = '.claude/agents/ch-*.md';

  try {
    let content = '';
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf-8');
      if (content.includes(marker)) return;
    }
    const newContent = `${content.trimEnd()}\n\n${forgenEntries.join('\n')}\n`;
    fs.writeFileSync(gitignorePath, newContent);
  } catch {
    // .gitignore 쓰기 실패는 무시
  }
}

// ── Main Harness ──

/** ~/.tenetx/ 및 ~/.compound/ → ~/.forgen/ 스토리지 마이그레이션 */
function migrateToForgen(): void {
  const home = os.homedir();
  if (home.startsWith('/tmp/') || home.includes('forgen-test')) return;

  const forgenHome = path.join(home, '.forgen');
  const legacyDirs = [
    path.join(home, '.tenetx'),
    path.join(home, '.compound'),
  ];

  for (const legacyHome of legacyDirs) {
    try {
      if (fs.lstatSync(legacyHome).isSymbolicLink()) continue;
    } catch { continue; }

    if (!fs.existsSync(legacyHome) || !fs.statSync(legacyHome).isDirectory()) continue;

    fs.mkdirSync(forgenHome, { recursive: true });

    try {
      const entries = fs.readdirSync(legacyHome, { withFileTypes: true });
      for (const entry of entries) {
        const src = path.join(legacyHome, entry.name);
        const dest = path.join(forgenHome, entry.name);
        if (fs.existsSync(dest)) continue;
        if (entry.isDirectory()) {
          fs.cpSync(src, dest, { recursive: true });
        } else if (entry.isFile()) {
          fs.copyFileSync(src, dest);
        }
      }
    } catch (e) {
      log.debug(`migrateToForgen: ${legacyHome} 파일 복사 중 오류`, e);
    }

    const backupPath = `${legacyHome}.bak`;
    try {
      if (!fs.existsSync(backupPath)) {
        fs.renameSync(legacyHome, backupPath);
        fs.symlinkSync(forgenHome, legacyHome, 'dir');
        log.debug(`migrateToForgen: ${legacyHome} → ~/.forgen symlink 생성 완료`);
      }
    } catch (e) {
      log.debug(`migrateToForgen: ${legacyHome} symlink 생성 실패`, e);
    }
  }

  // 레거시 디렉토리가 없으면 symlink 생성
  for (const legacyHome of legacyDirs) {
    if (!fs.existsSync(legacyHome)) {
      try { fs.symlinkSync(forgenHome, legacyHome, 'dir'); } catch { /* ignore */ }
    }
  }
}

/** 메인 하네스 준비 함수 (v1) */
// ── B9: prepareHarness sub-phases (extracted steps 11-12) ──

/** Step 11: start legacy session log (fail-open). */
async function startLegacySessionLog(cwd: string, inTmux: boolean, v1Result: V1BootstrapResult): Promise<void> {
  try {
    const { startSessionLog: legacySessionLog } = await import('./session-logger.js');
    legacySessionLog({
      philosophy: { name: 'v1', version: '1.0.0', author: 'forgen', principles: {} },
      philosophySource: 'default' as const,
      scope: {
        me: { philosophyPath: '', solutionCount: 0, ruleCount: 0 },
        project: { path: cwd, solutionCount: 0 },
        summary: `v1(${v1Result.session?.quality_pack ?? 'unknown'})`,
      },
      cwd,
      inTmux,
    });
  } catch { /* 세션 로그 실패는 무시 */ }
}

/** Step 12: write pending-compound.json if last extraction is stale. */
function checkCompoundStaleness(): void {
  try {
    const stalenessDays = Number(process.env.FORGEN_STALENESS_DAYS ?? process.env.COMPOUND_STALENESS_DAYS) || 3;
    const stalenessMs = stalenessDays * 24 * 60 * 60 * 1000;
    const lastExtractionPath = path.join(STATE_DIR, 'last-extraction.json');
    if (!fs.existsSync(lastExtractionPath)) return;

    const lastExtraction = JSON.parse(fs.readFileSync(lastExtractionPath, 'utf-8'));
    const extractedAt = lastExtraction.lastExtractedAt ?? lastExtraction.lastRunAt;
    const lastRunMs = extractedAt ? new Date(extractedAt).getTime() : Number.NaN;
    if (!Number.isFinite(lastRunMs)) return;

    const elapsed = Date.now() - lastRunMs;
    if (elapsed > stalenessMs) {
      const pendingPath = path.join(STATE_DIR, 'pending-compound.json');
      if (!fs.existsSync(pendingPath)) {
        fs.writeFileSync(pendingPath, JSON.stringify({
          reason: 'staleness',
          detectedAt: new Date().toISOString(),
          daysSinceLastRun: Math.floor(elapsed / (24 * 60 * 60 * 1000)),
        }, null, 2));
      }
    }
  } catch (e) {
    log.debug('Staleness check failed (non-fatal)', e);
  }
}

// ── Host Bindings (Multi-Harness Adapter Plan P0 — 구 if-ladder 대체) ──

/**
 * Claude 세션 준비: settings.json 인젝션 + 에이전트 설치 + 규칙 파일 생성/주입 +
 * 슬래시 명령 설치. (구 `if (runtime === 'claude')` 분기, 동작 동일.)
 */
async function prepareClaudeSession(ctx: HarnessSessionContext): Promise<void> {
  const { cwd, pkgRoot, env, v1Result } = ctx;
  try {
    injectSettings(env, v1Result, 'claude', cwd, pkgRoot);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('settings.json lock') || msg.includes('SettingsLockError')) {
      console.error(`[forgen] ${msg} — settings 갱신 스킵, 이전 값 유지`);
    } else {
      throw e;
    }
  }
  installAgents(cwd, pkgRoot);
  const ruleFiles = generateClaudeRuleFiles(cwd, v1Result.renderedRules);
  injectClaudeRuleFiles(cwd, ruleFiles);
  installSlashCommands(cwd, pkgRoot);
}

/**
 * Codex 세션 준비: hooks.json 자동 reconcile-on-launch.
 * (구 `else if (runtime === 'codex')` 분기, 동작 동일.)
 */
async function prepareCodexSession(ctx: HarnessSessionContext): Promise<void> {
  try {
    await ensureCodexHooksFresh(ctx.pkgRoot);
  } catch (e) {
    log.debug('Codex hooks reconcile 실패 (fail-open)', e);
  }
}

/**
 * capabilities 선언 + projection 함수 + 세션 준비(hook-surface wiring)를 host 별로
 * 묶은 registry. `Record<HostId, HostBinding>` 이 완전성을 강제하므로 새 host 추가 시
 * (예: OpenCode, P1) 엔트리 누락은 컴파일 타임에 걸린다.
 *
 * capabilities/projection 은 현재 prepareHarness 자체가 소비하지 않지만(각각
 * capabilities-registry.ts / parity-harness.ts 가 독립 소비), HostBinding 계약의
 * 일부로 함께 선언해 두어 향후 확장(§4.1 P1) 시 registry 엔트리 하나만 추가하면
 * 되는 형태를 만든다.
 */
const HOST_BINDINGS: Record<HostId, HostBinding> = {
  claude: {
    id: 'claude',
    capabilities: getHostCapabilities('claude'),
    projection: getProjection('claude'),
    prepareSession: prepareClaudeSession,
  },
  codex: {
    id: 'codex',
    capabilities: getHostCapabilities('codex'),
    projection: getProjection('codex'),
    prepareSession: prepareCodexSession,
  },
};

interface PrepareHarnessOptions {
  runtime?: RuntimeHost;
}

export async function prepareHarness(
  cwd: string,
  options: PrepareHarnessOptions = {},
): Promise<V1HarnessContext> {
  const runtime: RuntimeHost = options.runtime ?? 'claude';

  try {
    // 0. 스토리지 마이그레이션 (v5.1: ~/.compound/ → ~/.forgen/)
    migrateToForgen();

    // 1. 디렉토리 구조 보장
    ensureDirectories();

    // 2. v1 Session Bootstrap (legacy 감지 → profile 로드 → preset 합성 → rule 렌더)
    const v1Result = bootstrapV1Session();

    if (v1Result.needsOnboarding) {
      log.debug('v1: 온보딩 필요 — forgen forge --onboarding 실행 안내');
    }

    if (v1Result.legacyBackupPath) {
      log.debug(`v1: 레거시 프로필 백업 완료 → ${v1Result.legacyBackupPath}`);
    }

    if (v1Result.corruptProfileBackupPath) {
      // v0.4.8 — corrupt profile auto-repair 결과는 debug 가 아닌 user-visible warning.
      // 사용자가 onboarding 으로 보내지는 이유를 알 수 있도록.
      console.warn(`  ⚠  forgen: profile.json 이 깨져 있어 옆에 백업해두고 onboarding 으로 보냅니다.`);
      console.warn(`  ⚠  backup: ${v1Result.corruptProfileBackupPath}`);
    }

    if (v1Result.session) {
      const { session } = v1Result;
      log.debug(`v1 세션 시작: ${session.quality_pack}/${session.autonomy_pack}, trust=${session.effective_trust_policy}`);

      // Audit fix #3 (2026-04-21): trust 에스컬레이션(runtime > desired) 경고를
      // 사용자에게 명시적으로 노출 — 이전엔 session.warnings에만 저장되고
      // 출력되지 않아 silent escalation이 됐다.
      for (const w of session.warnings ?? []) {
        if (w.includes('Trust 상승')) {
          console.warn(`  ⚠  ${w}`);
        }
      }
      for (const w of session.warnings) {
        // mismatch 경고는 사용자에게 직접 표시
        if (w.includes('mismatch')) {
          console.error(`[forgen] ${w}`);
        }
        log.debug(`v1 경고: ${w}`);
      }
    }

    if (v1Result.mismatch?.quality_mismatch || v1Result.mismatch?.autonomy_mismatch) {
      log.debug(`v1 mismatch 감지: quality=${v1Result.mismatch.quality_score}, autonomy=${v1Result.mismatch.autonomy_score}`);
    }

    // 3. 환경 확인
    const inTmux = !!process.env.TMUX;

    // 4-7. Host artifact 작업 (Claude: settings.json + agents + rules + slash commands.
    // Codex: hooks.json reconcile). HOST_BINDINGS 로 dispatch — host 별 구체 동작은
    // prepareClaudeSession / prepareCodexSession 참조.
    //
    // feat/codex-support P1-7 (2026-04-27): runtime === 'codex' 시 *.claude/* 계열
    // 작업은 *no-op*. Codex 측 동치 prep 은 Phase 3 (install-codex.ts 의 prompts +
    // AGENTS.md inject) 에서 처리. 본 dispatch 는 *Claude artifact 가 Codex 환경을
    // 오염시키지 않도록* 보호하는 비대칭 게이트를 그대로 보존한다.
    const pkgRoot = getPackageRoot();
    const env = buildEnv(cwd, v1Result.session?.session_id, runtime);
    const binding = HOST_BINDINGS[runtime];
    if (binding) {
      await binding.prepareSession({ cwd, pkgRoot, env, v1Result });
    } else {
      log.debug(`prepareHarness: runtime=${runtime} — artifact prep skipped`);
    }

    // 8. tmux 바인딩 등록
    if (inTmux) {
      await registerTmuxBindings();
    }

    // 9. .gitignore 등록
    ensureGitignore(cwd);

    // 10. Auto memory에 compound 포인터 추가
    ensureCompoundMemory(cwd);

    // 11. 세션 로그 시작 (레거시 호환)
    await startLegacySessionLog(cwd, inTmux, v1Result);

    // 12. Compound staleness guard
    checkCompoundStaleness();

    return { cwd, inTmux, v1: v1Result, runtime };
  } catch (err) {
    rollbackSettings();
    throw err;
  }
}
