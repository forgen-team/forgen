/**
 * tests/migrate-tenetx.test.ts — ADR-010 W1-1 Rule Reclaimer.
 *
 * fixture 내용은 2026-07-16 수동 청소에서 확보한 실물 tenetx 산출물
 * (~/.forgen/backups/tenetx-removal-2026-07-15/)의 헤더/마커를 그대로 사용.
 * 모듈이 home/cwd 를 인자로 받으므로 vi.mock 없이 실제 fs 로 검증한다.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  scanReclaimables, runReclaim, hasProvenanceMarker,
} from '../src/core/migrate-tenetx.js';
import {
  recordRenderedFiles, loadManifest, matchesManifest, manifestPath, sha256Of,
} from '../src/core/rendered-rules-manifest.js';

// 실물 tenetx 산출물 형태 (backup 원본에서 발췌)
const TENETX_SECURITY = `# Tenetx — Security Rules
# Philosophy: forge-generated v1.0.0

## Dangerous Command Warning
- Always confirm before executing destructive commands
`;

const FORGE_QUALITY = `# Tenetx Forge — Quality Standards
## Quality Gates
- Target test coverage: 83% on changed code paths
`;

const LEGACY_BEHAVIORAL = `# Forgen — Learned Patterns
# auto-generated from observed interactions

## Response Preferences
- ⚠️ **Prompt injection detected in your message** (1회 관찰)
`;

const USER_AUTHORED = `# My own project notes

These are my personal notes. No provenance markers here.
`;

let HOME: string;
let CWD: string;

function globalRules(): string { return path.join(HOME, '.claude', 'rules'); }
function projectRules(): string { return path.join(CWD, '.claude', 'rules'); }

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-reclaim-home-'));
  CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-reclaim-cwd-'));
  fs.mkdirSync(globalRules(), { recursive: true });
  fs.mkdirSync(projectRules(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(CWD, { recursive: true, force: true });
});

describe('provenance markers', () => {
  it('matches real tenetx/forge artifacts, not user files', () => {
    expect(hasProvenanceMarker(TENETX_SECURITY)).toBe(true);
    expect(hasProvenanceMarker(FORGE_QUALITY)).toBe(true);
    expect(hasProvenanceMarker(LEGACY_BEHAVIORAL)).toBe(true);
    expect(hasProvenanceMarker('<!-- forge-tuned -->\nsome rule')).toBe(true);
    expect(hasProvenanceMarker(USER_AUTHORED)).toBe(false);
    // 마커가 문서 중간에 인용된 사용자 파일 — "# Tenetx" 는 line-start 앵커라 통과
    expect(hasProvenanceMarker('my notes about the old # Tenetx system')).toBe(false);
  });
});

describe('rendered-rules-manifest', () => {
  it('record → load → match roundtrip; mismatch on edit', () => {
    const target = path.join(projectRules(), 'v1-rules.md');
    const content = '# Forgen v1 — Rendered Rules\n- rule A\n';
    recordRenderedFiles({ [target]: content }, '0.5.0', HOME);

    const m = loadManifest(HOME);
    expect(m[target]?.sha256).toBe(sha256Of(content));
    expect(m[target]?.version).toBe('0.5.0');
    expect(matchesManifest(target, content, m)).toBe(true);
    expect(matchesManifest(target, content + 'user edit\n', m)).toBe(false);
    expect(fs.existsSync(manifestPath(HOME))).toBe(true);
  });
});

describe('scanReclaimables', () => {
  it('(a) manifest-hash match in global dir → removable', () => {
    const p = path.join(globalRules(), 'forge-behavioral.md');
    fs.writeFileSync(p, LEGACY_BEHAVIORAL);
    recordRenderedFiles({ [p]: LEGACY_BEHAVIORAL }, '0.4.13', HOME);

    const scan = scanReclaimables(CWD, HOME);
    expect(scan.removable.map(c => c.path)).toContain(p);
    expect(scan.needsConfirm).toHaveLength(0);
  });

  it('(b) marker-only (hash 불일치/manifest 부재) → needsConfirm', () => {
    const p = path.join(globalRules(), 'security.md');
    fs.writeFileSync(p, TENETX_SECURITY);

    const scan = scanReclaimables(CWD, HOME);
    expect(scan.removable).toHaveLength(0);
    expect(scan.needsConfirm.map(c => c.path)).toContain(p);
  });

  it('(c) user-authored file → untouched in scan', () => {
    const p = path.join(globalRules(), 'my-notes.md');
    fs.writeFileSync(p, USER_AUTHORED);

    const scan = scanReclaimables(CWD, HOME);
    expect(scan.removable).toHaveLength(0);
    expect(scan.needsConfirm).toHaveLength(0);
  });

  it('project dir: current render targets are out of scope even with markers', () => {
    fs.writeFileSync(path.join(projectRules(), 'v1-rules.md'),
      '# Forgen v1 — Rendered Rules\n# auto-generated from profile + rule store\n');
    fs.writeFileSync(path.join(projectRules(), 'forge-behavioral.md'), LEGACY_BEHAVIORAL);

    const scan = scanReclaimables(CWD, HOME);
    expect(scan.removable).toHaveLength(0);
    expect(scan.needsConfirm).toHaveLength(0);
  });

  it('project dir: stale tenetx files (non-render-targets) are flagged', () => {
    const p = path.join(projectRules(), 'golden-principles.md');
    fs.writeFileSync(p, FORGE_QUALITY);

    const scan = scanReclaimables(CWD, HOME);
    expect(scan.needsConfirm.map(c => c.path)).toContain(p);
  });
});

describe('runReclaim', () => {
  it('removes manifest-matched files with backup; marker-only skipped without --yes', () => {
    const matched = path.join(globalRules(), 'forge-behavioral.md');
    fs.writeFileSync(matched, LEGACY_BEHAVIORAL);
    recordRenderedFiles({ [matched]: LEGACY_BEHAVIORAL }, '0.4.13', HOME);
    const markerOnly = path.join(globalRules(), 'security.md');
    fs.writeFileSync(markerOnly, TENETX_SECURITY);

    const r = runReclaim({ cwd: CWD, home: HOME });

    expect(r.removed).toContain(matched);
    expect(fs.existsSync(matched)).toBe(false);
    // marker-only 는 --yes 없인 보존
    expect(r.skippedNeedsConfirm).toContain(markerOnly);
    expect(fs.existsSync(markerOnly)).toBe(true);
    // 백업에 원본 존재 (가역성)
    expect(r.backupDir).toBeTruthy();
    const backups = fs.readdirSync(r.backupDir as string);
    expect(backups.some(f => f.includes('forge-behavioral'))).toBe(true);
  });

  it('--yes includes marker-only files', () => {
    const markerOnly = path.join(globalRules(), 'routing.md');
    fs.writeFileSync(markerOnly, '# Tenetx — Model Routing\nold table\n');

    const r = runReclaim({ cwd: CWD, home: HOME, yes: true });
    expect(r.removed).toContain(markerOnly);
    expect(fs.existsSync(markerOnly)).toBe(false);
  });

  it('--dry-run: reports targets but touches nothing', () => {
    const p = path.join(globalRules(), 'forge-quality.md');
    fs.writeFileSync(p, FORGE_QUALITY);

    const r = runReclaim({ cwd: CWD, home: HOME, yes: true, dryRun: true });
    expect(r.removed).toContain(p);
    expect(fs.existsSync(p)).toBe(true); // 미수정
    expect(r.backupDir).toBeNull();
  });

  it('idempotent: second run finds nothing', () => {
    const p = path.join(globalRules(), 'anti-pattern.md');
    fs.writeFileSync(p, FORGE_QUALITY);
    runReclaim({ cwd: CWD, home: HOME, yes: true });

    const r2 = runReclaim({ cwd: CWD, home: HOME, yes: true });
    expect(r2.removed).toHaveLength(0);
    expect(r2.skippedNeedsConfirm).toHaveLength(0);
  });
});

describe('settings/registry detection + --apply-settings', () => {
  function seedTenetxSettings(): { settingsPath: string; registryPath: string } {
    const claudeDir = path.join(HOME, '.claude');
    const pluginsDir = path.join(claudeDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: 'tenetx status' },
      enabledPlugins: { 'tenetx@tenetx-local': true, 'forgen@forgen-local': true },
      plugins: ['/home/user/.claude/plugins/tenetx'],
    }, null, 2));
    const registryPath = path.join(pluginsDir, 'installed_plugins.json');
    fs.writeFileSync(registryPath, JSON.stringify({
      version: 2,
      plugins: { 'tenetx@tenetx-local': [{ scope: 'user', installPath: '/x', version: '2.4.0' }] },
    }, null, 2));
    return { settingsPath, registryPath };
  }

  it('detects tenetx traces in settings + registry (report-only by default)', () => {
    const { settingsPath } = seedTenetxSettings();
    const r = runReclaim({ cwd: CWD, home: HOME });

    expect(r.settingsFindings.length).toBeGreaterThanOrEqual(3); // statusline + enabledPlugins + plugins[] + registry
    expect(r.settingsApplied).toBe(false);
    // 기본 모드는 report-only — settings 원본 불변
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(s.statusLine.command).toBe('tenetx status');
  });

  it('--apply-settings removes traces with backup and preserves other entries', () => {
    const { settingsPath, registryPath } = seedTenetxSettings();
    const r = runReclaim({ cwd: CWD, home: HOME, applySettings: true });

    expect(r.settingsApplied).toBe(true);
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(s.statusLine.command).toBe('forgen statusline');
    expect(s.enabledPlugins['tenetx@tenetx-local']).toBeUndefined();
    expect(s.enabledPlugins['forgen@forgen-local']).toBe(true); // 타 항목 보존
    expect(s.plugins).toHaveLength(0);
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(reg.plugins['tenetx@tenetx-local']).toBeUndefined();
    // 백업 존재
    const backups = fs.readdirSync(r.backupDir as string);
    expect(backups).toContain('settings.json.bak');
    expect(backups).toContain('installed_plugins.json.bak');

    // idempotent: 재실행 시 findings 없음
    const r2 = runReclaim({ cwd: CWD, home: HOME, applySettings: true });
    expect(r2.settingsFindings).toHaveLength(0);
  });
});
