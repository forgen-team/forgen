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
import { isUserOwnedVerifySkill, planClaudeInstall } from '../../src/host/install-claude.js';
import { cleanClaudeJsonMcp, cleanDevGuideSkills, cleanVerifySkill } from '../../src/core/uninstall.js';

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

describe('ADR-016 D3: user-level verify skill', () => {
  const skillFile = () => path.join(tmpHome, '.claude', 'skills', 'verify', 'SKILL.md');

  it('~/.claude/skills/verify/SKILL.md 를 forgen-managed 마커와 함께 설치 (name: verify, un-namespaced)', () => {
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    expect(r.verifySkill).toBe('installed');
    const content = fs.readFileSync(skillFile(), 'utf-8');
    expect(content).toMatch(/^---\nname: verify\ndescription: .+\n---\n\n<!-- forgen-managed -->/);
    // 심링크가 아니라 복사본이어야 한다 (마커로 소유 판정)
    expect(fs.lstatSync(skillFile()).isSymbolicLink()).toBe(false);
    // 프로젝트 자체 레시피 우선 + no-mock 증거 규칙이 본문에 있다
    expect(content).toContain('.claude/skills/verify/SKILL.md');
    expect(content).toMatch(/mocks or stubs/);
    expect(content).toMatch(/\*\*refuted\*\*/);
  });

  it('재설치는 idempotent, dev-guide stale 정리가 verify 를 지우지 않는다', () => {
    planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    const first = fs.readFileSync(skillFile(), 'utf-8');
    const r2 = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    expect(r2.verifySkill).toBe('installed');
    expect(fs.readFileSync(skillFile(), 'utf-8')).toBe(first);
  });

  it('사용자가 만든 verify 스킬(마커 없음)은 덮어쓰지 않는다', () => {
    fs.mkdirSync(path.dirname(skillFile()), { recursive: true });
    const mine = '---\nname: verify\ndescription: mine\n---\n\nrun `make check`\n';
    fs.writeFileSync(skillFile(), mine);
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    expect(r.verifySkill).toBe('user-owned');
    expect(fs.readFileSync(skillFile(), 'utf-8')).toBe(mine);
  });

  it('사용자 심링크 디렉토리 / SKILL.md 없이 다른 파일만 있는 디렉토리도 사용자 소유로 본다', () => {
    const skillsDir = path.join(tmpHome, '.claude', 'skills');
    const elsewhere = path.join(tmpHome, 'my-verify');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(skillsDir, 'verify'), 'dir');
    expect(planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome }).verifySkill).toBe('user-owned');
    expect(fs.existsSync(path.join(elsewhere, 'SKILL.md'))).toBe(false);

    fs.unlinkSync(path.join(skillsDir, 'verify'));
    fs.mkdirSync(path.join(skillsDir, 'verify'));
    fs.writeFileSync(path.join(skillsDir, 'verify', 'notes.md'), 'wip');
    expect(isUserOwnedVerifySkill(skillsDir)).toBe(true);
    fs.unlinkSync(path.join(skillsDir, 'verify', 'notes.md'));
    expect(isUserOwnedVerifySkill(skillsDir)).toBe(false); // 빈 디렉토리는 설치 가능
  });

  it('installVerifySkill:false 와 dry-run 은 파일을 쓰지 않는다', () => {
    expect(planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome, installVerifySkill: false }).verifySkill).toBe('skipped');
    expect(fs.existsSync(skillFile())).toBe(false);
    expect(planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome, dryRun: true }).verifySkill).toBe('installed');
    expect(fs.existsSync(skillFile())).toBe(false);
  });

  it('uninstall 대칭: forgen-managed 만 제거, 사용자 스킬은 보존', () => {
    planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    expect(cleanVerifySkill(tmpHome)).toBe(true);
    expect(fs.existsSync(path.dirname(skillFile()))).toBe(false);
    expect(cleanVerifySkill(tmpHome)).toBe(false); // 이미 없음

    fs.mkdirSync(path.dirname(skillFile()), { recursive: true });
    fs.writeFileSync(skillFile(), '---\nname: verify\ndescription: mine\n---\nmine\n');
    expect(cleanVerifySkill(tmpHome)).toBe(false);
    expect(fs.existsSync(skillFile())).toBe(true);
  });
});

describe('uninstall: Claude 쪽 대칭 보강 (ADR-016 D4)', () => {
  it('dev-guide 스킬(forgen-<stack>-*)을 제거하고 다른 스킬은 보존', () => {
    const r = planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    expect(r.skillsInstalled).toBeGreaterThan(0);
    const skillsDir = path.join(tmpHome, '.claude', 'skills');
    fs.mkdirSync(path.join(skillsDir, 'my-skill'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: x\n---\n');
    fs.mkdirSync(path.join(skillsDir, 'forgen-notes'), { recursive: true }); // forgen- 접두어지만 dev-guide 패턴 아님
    expect(cleanDevGuideSkills(tmpHome)).toBe(r.skillsInstalled);
    expect(fs.readdirSync(skillsDir).sort()).toEqual(['forgen-notes', 'my-skill', 'verify']);
    expect(cleanDevGuideSkills(tmpHome)).toBe(0);
  });

  it('~/.claude.json 의 forgen-compound MCP 등록을 제거 — 같은 이름의 사용자 서버와 다른 키는 보존', () => {
    const claudeJson = path.join(tmpHome, '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ numStartups: 3, mcpServers: { other: { command: 'x' } } }));
    planClaudeInstall({ pkgRoot: PKG_ROOT, homeDir: tmpHome });
    expect(JSON.parse(fs.readFileSync(claudeJson, 'utf-8')).mcpServers['forgen-compound']).toBeDefined();
    expect(cleanClaudeJsonMcp(tmpHome)).toBe(true);
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    expect(after.mcpServers).toEqual({ other: { command: 'x' } });
    expect(after.numStartups).toBe(3);
    expect(cleanClaudeJsonMcp(tmpHome)).toBe(false);

    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { 'forgen-compound': { command: 'python', args: ['/mine/server.py'] } } }));
    expect(cleanClaudeJsonMcp(tmpHome)).toBe(false); // 사용자가 같은 이름으로 등록한 다른 서버
    expect(JSON.parse(fs.readFileSync(claudeJson, 'utf-8')).mcpServers['forgen-compound'].command).toBe('python');
    expect(cleanClaudeJsonMcp(path.join(tmpHome, 'nope'))).toBe(false);
  });
});
