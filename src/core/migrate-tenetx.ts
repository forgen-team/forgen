/**
 * Forgen v0.5.0 — `forgen migrate tenetx` (ADR-010 W1-1, Rule Reclaimer)
 *
 * tenetx(forgen 의 레거시 정체성) 및 구버전 forgen 이 ~/.claude/rules/ 와
 * <cwd>/.claude/rules/ 에 남긴 규칙 파일 스프롤을 provenance 기반으로 회수한다.
 * 2026-07-16 수동 청소(56K→0, 중복 스킬 21개 제거)의 프로덕트화.
 *
 * 판정 3단계 (설계: docs/plans/2026-07-16-v0.5.0-execution-plan.md W1-1):
 *   (a) content-hash 가 rendered-rules-manifest 와 일치 → 무프롬프트 삭제 (forgen 이 쓴 그대로)
 *   (b) provenance 마커만 매치 + hash 불일치      → --yes 필요 (사용자 편집 가능성)
 *   (c) 매치 없음                                  → 불간섭
 *
 * 안전장치: 모든 삭제는 백업 이동(가역), --dry-run 지원,
 * settings.json/installed_plugins.json 편집은 --apply-settings 명시 동의 시에만.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadManifest, matchesManifest } from './rendered-rules-manifest.js';
import { acquireLock, releaseLock, atomicWriteFileSync } from './settings-lock.js';

// ── 판정 ──

/** tenetx / forge 계열 산출물 provenance 마커 (2026-07-16 실물 파일 기준) */
const PROVENANCE_MARKERS: readonly RegExp[] = Object.freeze([
  /<!--\s*forge-tuned\s*-->/,
  /^#\s*Tenetx\b/m,
  /forge-generated v\d/,
  /^# auto-generated from (observed interactions|profile \+ rule store)/m,
  /^# Forgen —/m, // 구버전 forgen 이 글로벌에 복제한 project-context 류
]);

/**
 * 현행 렌더 타겟 — 프로젝트 .claude/rules/ 에서 forgen 이 매 세션 관리하는
 * 파일들. reclaim 범위에서 제외한다 (manifest 생성 전 ⚠ 노이즈 방지;
 * 삭제해도 다음 렌더에서 재생성되므로 회수의 의미도 없다).
 * 정리 책임: 렌더(갱신) / uninstall(제거).
 */
const CURRENT_RENDER_TARGETS = new Set([
  'project-context.md', 'v1-rules.md', 'forge-behavioral.md', 'user-profile.md',
]);

export type ReclaimReason = 'manifest-hash' | 'provenance-marker';

export interface ReclaimCandidate {
  path: string;
  reason: ReclaimReason;
}

export interface ReclaimScan {
  /** (a) 무프롬프트 삭제 가능 — forgen 이 쓴 그대로 */
  removable: ReclaimCandidate[];
  /** (b) 마커는 있으나 hash 불일치 — --yes 필요 */
  needsConfirm: ReclaimCandidate[];
  /** settings/registry 의 tenetx 흔적 (사람이 읽는 설명) */
  settingsFindings: string[];
}

export interface ReclaimOptions {
  cwd: string;
  home?: string;
  dryRun?: boolean;
  /** marker-only(b) 항목도 삭제에 포함 */
  yes?: boolean;
  /** settings.json / installed_plugins.json 에서 tenetx 항목 직접 제거 */
  applySettings?: boolean;
}

export interface ReclaimResult {
  removed: string[];
  skippedNeedsConfirm: string[];
  settingsFindings: string[];
  settingsApplied: boolean;
  backupDir: string | null;
  dryRun: boolean;
}

function listRuleFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      // .md 한정: tenetx/forgen 계열 rules 산출물은 전부 마크다운이었다
      // (2026-07-16 실물 13개 파일 기준). 다른 확장자는 provenance 판단
      // 근거가 없으므로 건드리지 않는다 — 불간섭이 기본값.
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

export function hasProvenanceMarker(content: string): boolean {
  return PROVENANCE_MARKERS.some(re => re.test(content));
}

/** 스캔만 — 디스크 수정 없음. doctor --reclaim 이 그대로 사용. */
export function scanReclaimables(cwd: string, home: string = os.homedir()): ReclaimScan {
  const manifest = loadManifest(home);
  const dirs = [
    path.join(home, '.claude', 'rules'),
    path.join(cwd, '.claude', 'rules'),
  ];

  const removable: ReclaimCandidate[] = [];
  const needsConfirm: ReclaimCandidate[] = [];

  const globalDir = dirs[0];
  for (const dir of dirs) {
    const isProjectDir = dir !== globalDir;
    for (const p of listRuleFiles(dir)) {
      // 프로젝트 스코프의 현행 렌더 타겟은 reclaim 범위 밖 (렌더/uninstall 책임)
      if (isProjectDir && CURRENT_RENDER_TARGETS.has(path.basename(p))) continue;

      let content: string;
      try { content = fs.readFileSync(p, 'utf-8'); } catch { continue; }

      if (matchesManifest(p, content, manifest)) {
        // (a) forgen 이 쓴 그대로임이 hash 로 증명됨 — 무프롬프트 회수.
        // NOTE: 현행 harness 는 프로젝트 경로만 기록하므로 글로벌 파일은
        // 오늘 기준 여기 도달하지 않는다(항상 marker 경로로 폴백). 이 분기는
        // 미래에 렌더 대상이 바뀌어 특정 파일이 잔재화될 때를 위한 경로다.
        removable.push({ path: p, reason: 'manifest-hash' });
        continue;
      }
      if (hasProvenanceMarker(content)) {
        needsConfirm.push({ path: p, reason: 'provenance-marker' });
      }
      // (c) 매치 없음 → 불간섭
    }
  }

  return { removable, needsConfirm, settingsFindings: scanSettings(home) };
}

// ── settings / registry 탐지 ──

function scanSettings(home: string): string[] {
  const findings: string[] = [];

  const settingsPath = path.join(home, '.claude', 'settings.json');
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (typeof s?.statusLine?.command === 'string' && s.statusLine.command.includes('tenetx')) {
      findings.push(`settings.json statusLine.command = "${s.statusLine.command}" → "forgen statusline" 권장`);
    }
    for (const key of Object.keys(s?.enabledPlugins ?? {})) {
      if (key.startsWith('tenetx@')) findings.push(`settings.json enabledPlugins["${key}"] 활성 상태`);
    }
    if (Array.isArray(s?.plugins)) {
      for (const p of s.plugins) {
        if (typeof p === 'string' && p.includes('tenetx')) findings.push(`settings.json plugins 배열에 ${p}`);
      }
    }
  } catch { /* settings 없음/파손 → 탐지 생략 */ }

  const registryPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  try {
    const r = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    for (const key of Object.keys(r?.plugins ?? {})) {
      if (key.startsWith('tenetx@')) findings.push(`installed_plugins.json 에 ${key} 등록 잔존`);
    }
  } catch { /* ignore */ }

  const pluginDir = path.join(home, '.claude', 'plugins', 'tenetx');
  if (fs.existsSync(pluginDir)) {
    findings.push(`플러그인 디렉토리 잔존: ${pluginDir}`);
  }

  return findings;
}

function applySettingsRemoval(home: string, backupDir: string): boolean {
  let applied = false;

  // settings.json 은 코드베이스 불변식대로 settings-lock 하에서만 수정한다
  // (settings-injector/uninstall 과 동일). 단 lock 은 실제 homedir 의
  // settings.json 전용이므로, 테스트 주입 home 에서는 lock 을 생략한다.
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const useLock = home === os.homedir();
  if (useLock) {
    try { acquireLock(); } catch { return false; /* 활성 세션과 경합 — 건드리지 않음 */ }
  }
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const s = JSON.parse(raw);
    let changed = false;

    if (typeof s?.statusLine?.command === 'string' && s.statusLine.command.includes('tenetx')) {
      s.statusLine.command = 'forgen statusline';
      changed = true;
    }
    for (const key of Object.keys(s?.enabledPlugins ?? {})) {
      if (key.startsWith('tenetx@')) { delete s.enabledPlugins[key]; changed = true; }
    }
    if (Array.isArray(s?.plugins)) {
      const before = s.plugins.length;
      s.plugins = s.plugins.filter((p: unknown) => !(typeof p === 'string' && p.includes('tenetx')));
      if (s.plugins.length !== before) changed = true;
    }

    if (changed) {
      fs.copyFileSync(settingsPath, path.join(backupDir, 'settings.json.bak'));
      atomicWriteFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
      applied = true;
    }
  } catch { /* settings 파손 시 건드리지 않음 */ }
  finally {
    if (useLock) releaseLock();
  }

  const registryPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  try {
    const raw = fs.readFileSync(registryPath, 'utf-8');
    const r = JSON.parse(raw);
    const tenetxKeys = Object.keys(r?.plugins ?? {}).filter(k => k.startsWith('tenetx@'));
    if (tenetxKeys.length > 0) {
      fs.copyFileSync(registryPath, path.join(backupDir, 'installed_plugins.json.bak'));
      for (const k of tenetxKeys) delete r.plugins[k];
      atomicWriteFileSync(registryPath, JSON.stringify(r, null, 2) + '\n');
      applied = true;
    }
  } catch { /* ignore */ }

  return applied;
}

// ── 실행 ──

export function runReclaim(opts: ReclaimOptions): ReclaimResult {
  const home = opts.home ?? os.homedir();
  const scan = scanReclaimables(opts.cwd, home);
  const dryRun = opts.dryRun === true;

  const targets: ReclaimCandidate[] = [
    ...scan.removable,
    ...(opts.yes ? scan.needsConfirm : []),
  ];
  const skippedNeedsConfirm = opts.yes ? [] : scan.needsConfirm.map(c => c.path);

  let backupDir: string | null = null;
  const removed: string[] = [];

  if (!dryRun && (targets.length > 0 || opts.applySettings)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupDir = path.join(home, '.forgen', 'backups', `reclaim-${ts}`);
    fs.mkdirSync(backupDir, { recursive: true });
  }

  for (const t of targets) {
    if (dryRun) { removed.push(t.path); continue; }
    try {
      // 백업 이동 = 가역 삭제. 파일명 충돌 방지를 위해 dir 구조 평탄화 + 접두.
      const flat = t.path.replace(/[\\/]/g, '_');
      fs.copyFileSync(t.path, path.join(backupDir as string, flat));
      fs.unlinkSync(t.path);
      removed.push(t.path);
    } catch { /* 개별 실패는 건너뜀 — 나머지 회수 계속 */ }
  }

  let settingsApplied = false;
  if (opts.applySettings && !dryRun && backupDir) {
    settingsApplied = applySettingsRemoval(home, backupDir);
  }

  return {
    removed,
    skippedNeedsConfirm,
    settingsFindings: scan.settingsFindings,
    settingsApplied,
    backupDir: dryRun ? null : backupDir,
    dryRun,
  };
}

// ── CLI 출력 ──

export function printReclaimResult(r: ReclaimResult): void {
  const mode = r.dryRun ? ' (dry-run — 디스크 미수정)' : '';
  console.log(`\n  [reclaim] tenetx/legacy 규칙 회수${mode}`);

  if (r.removed.length === 0 && r.skippedNeedsConfirm.length === 0 && r.settingsFindings.length === 0) {
    console.log('  ✓ 회수 대상 없음 — 깨끗한 상태');
    return;
  }
  for (const p of r.removed) {
    console.log(`  ${r.dryRun ? '○ 회수 예정' : '✓ 회수'}: ${p}`);
  }
  for (const p of r.skippedNeedsConfirm) {
    console.log(`  ⚠ 마커는 있으나 forgen 이 쓴 내용과 다름 (사용자 편집 가능성): ${p}`);
    console.log('    → 확인 후 삭제하려면 --yes 로 재실행');
  }
  if (r.settingsFindings.length > 0) {
    console.log('  [settings] tenetx 흔적:');
    for (const f of r.settingsFindings) console.log(`    - ${f}`);
    if (r.settingsApplied) console.log('    ✓ --apply-settings 로 제거 완료 (백업 저장됨)');
    else console.log('    → 자동 제거: forgen migrate tenetx --apply-settings');
  }
  if (r.backupDir) console.log(`  백업: ${r.backupDir}`);
}
