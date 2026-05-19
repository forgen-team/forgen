/**
 * planClaudeInstall — feat/codex-support P1-2 단위 테스트
 *
 * 격리 homeDir 에 5 자산 (plugin cache, slash commands, settings hooks, MCP, dev-guide skills) 작성 검증.
 * 사용자 비-forgen 자산 보존 + 재실행 idempotent.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planClaudeInstall } from '../../src/host/install-claude.js';

const PKG_ROOT = process.cwd();

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'install-claude-test-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('planClaudeInstall', () => {
  it('빈 homeDir 에 install 시 4 자산 모두 작성 + count 반환', () => {
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    expect(r.pluginCacheWritten).toBe(true);
    expect(fs.existsSync(r.pluginCachePath)).toBe(true);
    expect(r.slashCommandsCount).toBeGreaterThan(0);
    expect(fs.existsSync(r.slashCommandsPath)).toBe(true);
    expect(fs.existsSync(r.settingsPath)).toBe(true);
    expect(r.hooksInjected).toBeGreaterThan(0);
    expect(r.mcpRegistered).toBe(true);
  });

  it('settings.json 의 forgen hooks 가 절대경로 박제 (CLAUDE_PLUGIN_ROOT 변수 미해석 회귀 차단)', () => {
    // settings.json 컨텍스트에서는 ${CLAUDE_PLUGIN_ROOT} 가 Claude Code 에 의해 풀리지 않음 →
    // "Hook command references ${CLAUDE_PLUGIN_ROOT} but the hook is not associated with a plugin" 에러.
    // postinstall.js 와 동일하게 절대경로로 박혀야 함.
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    const settings = JSON.parse(fs.readFileSync(r.settingsPath, 'utf-8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.enabledPlugins?.['forgen@forgen-local']).toBe(true);
    const allCommands = Object.values(settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
      .flat()
      .flatMap((g) => g.hooks.map((h) => h.command));
    expect(allCommands.every((c) => !c.includes('CLAUDE_PLUGIN_ROOT'))).toBe(true);
    expect(allCommands.some((c) => c.includes(path.join(PKG_ROOT, 'dist', 'hooks')))).toBe(true);
  });

  it('사용자 비-forgen hook 보존 + 사용자 비-forgen MCP 보존', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node /home/user/my-hook.js' }] }] },
      }),
    );
    fs.writeFileSync(
      path.join(tmpHome, '.claude.json'),
      JSON.stringify({ mcpServers: { 'user-mcp': { command: 'node', args: ['/home/user/mcp.js'] } } }),
    );
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    expect(r.hooksInjected).toBeGreaterThan(0);
    expect(r.mcpRegistered).toBe(true);

    const settings = JSON.parse(fs.readFileSync(r.settingsPath, 'utf-8'));
    const preCommands = (settings.hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap((g) => g.hooks.map((h) => h.command));
    expect(preCommands).toContain('node /home/user/my-hook.js');
    // forgen entry 도 절대경로로 존재 (CLAUDE_PLUGIN_ROOT 변수 박제 금지)
    expect(preCommands.every((c) => !c.includes('CLAUDE_PLUGIN_ROOT'))).toBe(true);
    expect(preCommands.some((c) => c.includes(path.join(PKG_ROOT, 'dist', 'hooks')))).toBe(true);

    const claudeJson = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf-8'));
    expect(claudeJson.mcpServers['user-mcp']).toBeDefined();
    expect(claudeJson.mcpServers['forgen-compound']).toBeDefined();
  });

  it('재실행 idempotent — forgen entry 가 중복되지 않고 MCP 가 alreadyPresent', () => {
    const r1 = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    const r2 = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    expect(r2.hooksInjected).toBe(r1.hooksInjected);
    expect(r2.mcpAlreadyPresent).toBe(true);
    expect(r2.mcpRegistered).toBe(false);
  });

  it('dryRun=true: 파일 미작성', () => {
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome, dryRun: true });
    expect(r.pluginCacheWritten).toBe(false);
    expect(fs.existsSync(r.pluginCachePath)).toBe(false);
    expect(fs.existsSync(r.slashCommandsPath)).toBe(false);
    expect(fs.existsSync(r.settingsPath)).toBe(false);
    // count 는 *예상값* 으로 보고 (실 작성은 없지만 결과는 지표 제공)
    expect(r.hooksInjected).toBeGreaterThan(0);
    expect(r.slashCommandsCount).toBeGreaterThan(0);
  });

  it('registerMcp=false → MCP 미작성', () => {
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome, registerMcp: false });
    expect(r.mcpRegistered).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.claude.json'))).toBe(false);
  });

  it('명시 homeDir override 으로 격리 (실제 ~/.claude 영향 없음)', () => {
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    expect(r.homeDir).toBe(tmpHome);
    expect(r.settingsPath).toBe(path.join(tmpHome, '.claude', 'settings.json'));
    expect(r.pluginCachePath.startsWith(tmpHome)).toBe(true);
  });

  it('잘못된 pkgRoot 는 명확한 에러', () => {
    expect(() => planClaudeInstall({ pkgRoot: '/no/such/dir', homeDir: tmpHome })).toThrow(/invalid pkgRoot/);
  });

  // ── 5. Dev-guide skills ──────────────────────────────────────────────

  it('dev-guide skills 14개 설치 검증', () => {
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    expect(r.skillsInstalled).toBe(14);
    expect(fs.existsSync(r.skillsPath)).toBe(true);
    // 각 forgen-* 디렉토리에 SKILL.md 존재 확인
    const skillDirs = fs.readdirSync(r.skillsPath).filter((d) => d.startsWith('forgen-'));
    expect(skillDirs).toHaveLength(14);
    for (const dir of skillDirs) {
      expect(fs.existsSync(path.join(r.skillsPath, dir, 'SKILL.md'))).toBe(true);
    }
  });

  it('dev-guide skills — forgen- 네이밍 패턴 확인', () => {
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    const skillDirs = fs.readdirSync(r.skillsPath).filter((d) => d.startsWith('forgen-'));
    // 대표 이름 검증
    expect(skillDirs).toContain('forgen-react-fe-build');
    expect(skillDirs).toContain('forgen-go-be-security');
    expect(skillDirs).toContain('forgen-vue-fe-review');
    expect(skillDirs).toContain('forgen-node-be-perf');
  });

  it('dev-guide skills — 재실행 idempotent (중복 없음, skillsRemoved 반영)', () => {
    const r1 = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    expect(r1.skillsInstalled).toBe(14);
    expect(r1.skillsRemoved).toBe(0); // 첫 실행 시 제거 대상 없음

    const r2 = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    expect(r2.skillsInstalled).toBe(14);
    expect(r2.skillsRemoved).toBe(14); // 이전 14개 정리 후 재설치

    // 최종 상태: 14개만 존재
    const skillDirs = fs.readdirSync(r2.skillsPath).filter((d) => d.startsWith('forgen-'));
    expect(skillDirs).toHaveLength(14);
  });

  it('dev-guide skills — dryRun=true: 파일 미작성, count 반환', () => {
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome, dryRun: true });
    expect(r.skillsInstalled).toBe(14);
    expect(r.skillsRemoved).toBe(0);
    // dryRun 시 skillsPath 디렉토리 생성 안 됨
    expect(fs.existsSync(r.skillsPath)).toBe(false);
  });

  it('dev-guide skills — 사용자 own skill 보존', () => {
    // 사용자가 직접 만든 스킬
    const ownSkillDir = path.join(tmpHome, '.claude', 'skills', 'my-own');
    fs.mkdirSync(ownSkillDir, { recursive: true });
    fs.writeFileSync(path.join(ownSkillDir, 'SKILL.md'), '# My Own Skill\n');

    planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });

    // 사용자 스킬은 건드리지 않음
    expect(fs.existsSync(path.join(ownSkillDir, 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(ownSkillDir, 'SKILL.md'), 'utf-8')).toBe('# My Own Skill\n');
  });
});
