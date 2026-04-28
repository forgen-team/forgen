import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: '/tmp/forgen-test-postinstall',
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const COMMANDS_DIR = path.join(TEST_HOME, '.claude', 'commands', 'forgen');
const SETTINGS_PATH = path.join(TEST_HOME, '.claude', 'settings.json');
const COMPOUND_HOME = path.join(TEST_HOME, '.forgen');
const SKILLS_DIR = path.resolve(__dirname, '..', 'assets', 'claude', 'commands');

function runPostinstall() {
  const { execFileSync } = require('node:child_process');
  execFileSync('node', [path.resolve(__dirname, '..', 'scripts', 'postinstall.js')], {
    env: { ...process.env, HOME: TEST_HOME },
  });
}

/**
 * P1-6b (옵션 Y): 신규 사용자에겐 자동 install 안 함. 본 테스트 swite 의 기존 시나리오는
 * 모두 *기존 forgen 사용자 마이그레이션* 모드에서 자동 갱신 검증. seedExistingForgenUser
 * 가 settings.json 에 forgen hook entry 1개 미리 박제 → isExistingForgenUser=true →
 * postinstall 이 자동 install 모드.
 */
function seedExistingForgenUser() {
  const claudeDir = path.dirname(SETTINGS_PATH);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify({
    hooks: {
      UserPromptSubmit: [{
        matcher: '*',
        hooks: [{
          type: 'command',
          command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/forgen-legacy.js"',
          timeout: 3,
        }],
      }],
    },
  }, null, 2));
}

describe('postinstall', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    // P1-6b: 기존 사용자 마이그레이션 모드 trigger (옵션 Y)
    seedExistingForgenUser();
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  // ── Slash commands ──

  describe('slash commands', () => {
    it('should install all skill files as slash commands', () => {
      runPostinstall();

      expect(fs.existsSync(COMMANDS_DIR)).toBe(true);
      const installed = fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));
      const skills = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.md'));
      expect(installed.length).toBe(skills.length);
      expect(installed.length).toBeGreaterThan(0);
    });

    it('should mark files with forgen-managed marker', () => {
      runPostinstall();

      const files = fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf-8');
        expect(content).toContain('<!-- forgen-managed -->');
      }
    });

    it('should not overwrite user-customized files', () => {
      fs.mkdirSync(COMMANDS_DIR, { recursive: true });
      const customFile = path.join(COMMANDS_DIR, 'ship.md');
      fs.writeFileSync(customFile, '# My custom ship workflow\nUser-customized content');

      runPostinstall();

      const content = fs.readFileSync(customFile, 'utf-8');
      expect(content).toContain('User-customized content');
      expect(content).not.toContain('<!-- forgen-managed -->');
    });

    it('should update existing forgen-managed files', () => {
      fs.mkdirSync(COMMANDS_DIR, { recursive: true });
      const managedFile = path.join(COMMANDS_DIR, 'ship.md');
      fs.writeFileSync(managedFile, '# Old version\n\n<!-- forgen-managed -->\n\nOld content');

      runPostinstall();

      const content = fs.readFileSync(managedFile, 'utf-8');
      expect(content).toContain('<!-- forgen-managed -->');
      expect(content).not.toContain('Old content');
    });
  });

  // ── Hooks cleanup (settings.json에서 기존 forgen 훅 정리) ──

  describe('hooks cleanup', () => {
    it('should inject hooks into settings.json with absolute paths', () => {
      runPostinstall();

      expect(fs.existsSync(SETTINGS_PATH)).toBe(true);
      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      // hooks 키가 있어야 함 (settings.json에 직접 등록)
      expect(settings.hooks).toBeDefined();
      // UserPromptSubmit에 forgen 훅이 등록되어야 함
      expect(settings.hooks.UserPromptSubmit).toBeDefined();
      const hasForgenHook = settings.hooks.UserPromptSubmit.some(
        (h: { hooks?: Array<{ command?: string }> }) =>
          h.hooks?.some((cmd: { command?: string }) => cmd.command?.includes('dist/hooks/')),
      );
      expect(hasForgenHook).toBe(true);
    });

    it('should preserve custom hooks when adding forgen hooks', () => {
      fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
      const existing = {
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: 'my-custom-hook.sh', timeout: 1000 }] },
          ],
        },
        someOtherSetting: true,
      };
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(existing));

      runPostinstall();

      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      // 사용자 커스텀 훅은 보존되어야 함
      const customHook = settings.hooks?.UserPromptSubmit?.find(
        (h: { hooks?: Array<{ command?: string }> }) => h.hooks?.[0]?.command === 'my-custom-hook.sh',
      );
      expect(customHook).toBeDefined();
      // 기존 설정 보존
      expect(settings.someOtherSetting).toBe(true);
    });

    it('should set COMPOUND_HARNESS env marker', () => {
      runPostinstall();

      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      expect(settings.env?.COMPOUND_HARNESS).toBe('1');
    });

    it('corrupted settings.json → 원본 보존 + .corrupt-<ts> 백업 + 쓰기 abort (audit fix #2/#10)', () => {
      // 2026-04-21 audit: 이전엔 parse 실패 시 `{}`로 시작해서 모든 settings를
      // 덮어썼다 (데이터 손실). 이제 원본을 `.corrupt-<ts>`로 보존하고 쓰기를
      // 건너뛴다. runPostinstall은 npm install을 깨뜨리지 않도록 최상위 try/
      // catch가 걸려 있어 여전히 throw 없이 통과해야 한다.
      fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
      const corruptContent = '{invalid json!!!';
      fs.writeFileSync(SETTINGS_PATH, corruptContent);

      expect(() => runPostinstall()).not.toThrow();

      // 원본이 그대로 남아 있음 (settings 쓰기가 건너뛰어졌는지)
      expect(fs.readFileSync(SETTINGS_PATH, 'utf-8')).toBe(corruptContent);

      // 손상본이 .corrupt-<ts>로 백업됨
      const claudeDir = path.dirname(SETTINGS_PATH);
      const corruptBackups = fs
        .readdirSync(claudeDir)
        .filter((f) => f.includes('.corrupt-'));
      expect(corruptBackups.length).toBeGreaterThan(0);
    });
  });

  // ── Plugin registration ──

  describe('plugin', () => {
    it('should create .claude-plugin/plugin.json in cache dir', () => {
      runPostinstall();

      // ~/.claude/plugins/cache/forgen-local/forgen/{version}/.claude-plugin/plugin.json
      const cacheBase = path.join(TEST_HOME, '.claude', 'plugins', 'cache', 'forgen-local', 'forgen');
      expect(fs.existsSync(cacheBase)).toBe(true);
      const versions = fs.readdirSync(cacheBase);
      expect(versions.length).toBeGreaterThan(0);
      const pluginJson = path.join(cacheBase, versions[0], '.claude-plugin', 'plugin.json');
      expect(fs.existsSync(pluginJson)).toBe(true);
    });

    it('should register in installed_plugins.json', () => {
      runPostinstall();

      const installedPath = path.join(TEST_HOME, '.claude', 'plugins', 'installed_plugins.json');
      expect(fs.existsSync(installedPath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(installedPath, 'utf-8'));
      expect(data.plugins['forgen@forgen-local']).toBeDefined();
      expect(data.plugins['forgen@forgen-local'][0].scope).toBe('user');
    });

    it('should add to enabledPlugins in settings.json', () => {
      runPostinstall();

      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      expect(settings.enabledPlugins?.['forgen@forgen-local']).toBe(true);
    });

    it('plugin cache 가 assets/claude/commands/ 를 포함한다 (§7.2 자산 분리 후)', () => {
      runPostinstall();

      const cacheBase = path.join(TEST_HOME, '.claude', 'plugins', 'cache', 'forgen-local', 'forgen');
      const versions = fs.readdirSync(cacheBase);
      const commandsDir = path.join(cacheBase, versions[0], 'assets', 'claude', 'commands');
      expect(fs.existsSync(commandsDir)).toBe(true);
      const files = fs.readdirSync(commandsDir).filter((f: string) => f.endsWith('.md'));
      expect(files.length).toBeGreaterThan(0);
    });

    it('should not duplicate on reinstall', () => {
      runPostinstall();
      runPostinstall();

      const installedPath = path.join(TEST_HOME, '.claude', 'plugins', 'installed_plugins.json');
      const data = JSON.parse(fs.readFileSync(installedPath, 'utf-8'));
      expect(data.plugins['forgen@forgen-local'].length).toBe(1);
    });
  });

  // ── Directory structure ──

  describe('directories', () => {
    it('should create ~/.forgen directory structure', () => {
      runPostinstall();

      const expectedDirs = [
        COMPOUND_HOME,
        path.join(COMPOUND_HOME, 'me'),
        path.join(COMPOUND_HOME, 'me', 'solutions'),
        path.join(COMPOUND_HOME, 'me', 'behavior'),
        path.join(COMPOUND_HOME, 'me', 'rules'),
        path.join(COMPOUND_HOME, 'me', 'skills'),
        path.join(COMPOUND_HOME, 'state'),
        path.join(COMPOUND_HOME, 'handoffs'),
        path.join(COMPOUND_HOME, 'lab'),
      ];
      for (const dir of expectedDirs) {
        expect(fs.existsSync(dir), `missing dir: ${dir}`).toBe(true);
      }
    });
  });

  // ── Resilience ──

  describe('resilience', () => {
    it('should not crash when ~/.claude does not exist', () => {
      fs.mkdirSync(TEST_HOME, { recursive: true });

      expect(() => runPostinstall()).not.toThrow();
      expect(fs.existsSync(COMMANDS_DIR)).toBe(true);
    });
  });

  // ── Cross-platform ──

  describe('cross-platform', () => {
    it('should detect and clean forgen hooks regardless of path separator style', () => {
      // 기존에 Windows 스타일 백슬래시 경로로 등록된 훅이 있어도 감지해야 함
      fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
      const existing = {
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: 'node "C:\\Users\\foo\\node_modules\\forgen\\dist\\hooks\\intent-classifier.js"', timeout: 3000 }] },
            { matcher: '', hooks: [{ type: 'command', command: 'my-custom-hook.sh', timeout: 1000 }] },
          ],
        },
      };
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(existing));

      runPostinstall();

      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      // 기존 Windows 스타일 forgen 훅은 제거되어야 함
      if (settings.hooks?.UserPromptSubmit) {
        const oldWindowsHook = settings.hooks.UserPromptSubmit.find(
          (h: { hooks?: Array<{ command?: string }> }) => h.hooks?.[0]?.command?.includes('C:\\Users'),
        );
        expect(oldWindowsHook).toBeUndefined();
      }
      // 사용자 커스텀 훅은 보존
      const customHook = settings.hooks?.UserPromptSubmit?.find(
        (h: { hooks?: Array<{ command?: string }> }) => h.hooks?.[0]?.command === 'my-custom-hook.sh',
      );
      expect(customHook).toBeDefined();
    });

    it('should not accumulate duplicate hooks on reinstall', () => {
      runPostinstall();
      const settings1 = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      const count1 = JSON.stringify(settings1.hooks).length;

      runPostinstall();
      const settings2 = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      const count2 = JSON.stringify(settings2.hooks).length;

      // 재설치 시 훅이 중복되면 안 됨 (길이 동일해야 함)
      expect(count2).toBe(count1);
    });
  });
});
