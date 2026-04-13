import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';

// vi.hoisted로 mock 상태 관리 — vi.mock 호이스팅보다 먼저 실행됨
const mocks = vi.hoisted(() => ({
  existsSync: vi.fn<(p: string) => boolean>(),
  readFileSync: vi.fn<(p: string, enc: string) => string>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: mocks.existsSync,
    readFileSync: mocks.readFileSync,
  };
});

// hook-registry mock — HOOK_REGISTRY 데이터를 직접 제공
vi.mock('../src/hooks/hook-registry.js', () => ({
  HOOK_REGISTRY: [
    { name: 'solution-injector', tier: 'compound-core', event: 'UserPromptSubmit', script: 'hooks/solution-injector.js', timeout: 3, compoundCritical: true },
    { name: 'notepad-injector', tier: 'compound-core', event: 'UserPromptSubmit', script: 'hooks/notepad-injector.js', timeout: 3, compoundCritical: false },
    { name: 'intent-classifier', tier: 'workflow', event: 'UserPromptSubmit', script: 'hooks/intent-classifier.js', timeout: 3, compoundCritical: false },
    { name: 'secret-filter', tier: 'safety', event: 'PostToolUse', script: 'hooks/secret-filter.js', timeout: 3, compoundCritical: false },
    { name: 'pre-tool-use', tier: 'compound-core', event: 'PreToolUse', script: 'hooks/pre-tool-use.js', timeout: 3, compoundCritical: true },
  ],
}));

const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.forgen', 'hook-config.json');

/**
 * 글로벌/프로젝트 설정 파일의 mock helper.
 * existsSync와 readFileSync를 경로별로 분기합니다.
 */
function mockConfigFiles(opts: {
  global?: Record<string, unknown> | null;
  project?: Record<string, unknown> | null;
  projectCwd?: string;
}) {
  const projectCwd = opts.projectCwd ?? '/test/project';
  const projectConfigPath = path.join(projectCwd, '.forgen', 'hook-config.json');

  mocks.existsSync.mockImplementation((p: string) => {
    if (p === GLOBAL_CONFIG_PATH) return opts.global != null;
    if (p === projectConfigPath) return opts.project != null;
    return false;
  });

  mocks.readFileSync.mockImplementation((p: string, _enc: string) => {
    if (p === GLOBAL_CONFIG_PATH && opts.global != null) return JSON.stringify(opts.global);
    if (p === projectConfigPath && opts.project != null) return JSON.stringify(opts.project);
    throw new Error(`ENOENT: no such file: ${p}`);
  });
}

describe('hook-config', () => {
  const origForgenCwd = process.env.FORGEN_CWD;
  const origCompoundCwd = process.env.COMPOUND_CWD;

  beforeEach(() => {
    vi.resetAllMocks();
    // 모듈 레벨 캐시 초기화를 위해 모듈 리로드
    vi.resetModules();
    // 테스트용 cwd 고정
    process.env.FORGEN_CWD = '/test/project';
    delete process.env.COMPOUND_CWD;
  });

  afterEach(() => {
    // 환경변수 복원
    if (origForgenCwd !== undefined) process.env.FORGEN_CWD = origForgenCwd;
    else delete process.env.FORGEN_CWD;
    if (origCompoundCwd !== undefined) process.env.COMPOUND_CWD = origCompoundCwd;
    else delete process.env.COMPOUND_CWD;
  });

  // ── isHookEnabled ──

  describe('isHookEnabled', () => {
    it('설정 파일이 없으면 true 반환 (기본값)', async () => {
      mocks.existsSync.mockReturnValue(false);
      const { isHookEnabled: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('notepad-injector')).toBe(true);
    });

    it('설정 파일 존재하지만 해당 훅 언급 없으면 true 반환', async () => {
      mockConfigFiles({
        global: { hooks: { 'some-other-hook': { enabled: false } } },
      });
      const { isHookEnabled: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('notepad-injector')).toBe(true);
    });

    it('hooks 섹션에서 enabled: false면 false 반환', async () => {
      mockConfigFiles({
        global: { hooks: { 'notepad-injector': { enabled: false } } },
      });
      const { isHookEnabled: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('notepad-injector')).toBe(false);
    });

    it('레거시 형식 (최상위 hookName.enabled: false)이면 false 반환', async () => {
      mockConfigFiles({
        global: { 'notepad-injector': { enabled: false } },
      });
      const { isHookEnabled: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('notepad-injector')).toBe(false);
    });

    it('티어가 disabled이면 해당 티어 훅은 false 반환', async () => {
      mockConfigFiles({
        global: { tiers: { workflow: { enabled: false } } },
      });
      const { isHookEnabled: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('intent-classifier')).toBe(false);
    });

    it('티어가 disabled이어도 개별 훅이 명시적 enabled: true이면 true 반환', async () => {
      mockConfigFiles({
        global: {
          tiers: { workflow: { enabled: false } },
          hooks: { 'intent-classifier': { enabled: true } },
        },
      });
      const { isHookEnabled: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('intent-classifier')).toBe(true);
    });

    it('workflow 티어가 disabled이어도 compound-core 훅은 true 반환', async () => {
      mockConfigFiles({
        global: { tiers: { workflow: { enabled: false } } },
      });
      const { isHookEnabled: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('solution-injector')).toBe(true);
    });

    it('compound-core 티어를 disabled해도 compound-core 훅은 true 반환 (보호)', async () => {
      mockConfigFiles({
        global: { tiers: { 'compound-core': { enabled: false } } },
      });
      const { isHookEnabled: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('solution-injector')).toBe(true);
      expect(fn('pre-tool-use')).toBe(true);
    });

    it('safety 티어가 disabled이면 safety 훅은 false 반환', async () => {
      mockConfigFiles({
        global: { tiers: { safety: { enabled: false } } },
      });
      const { isHookEnabled: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('secret-filter')).toBe(false);
    });

    it('malformed JSON이면 true 반환 (failure-tolerant)', async () => {
      mocks.existsSync.mockReturnValue(true);
      mocks.readFileSync.mockReturnValue('{ invalid json !!');
      const { isHookEnabled: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('notepad-injector')).toBe(true);
    });
  });

  // ── loadHookConfig ──

  describe('loadHookConfig', () => {
    it('설정 파일이 없으면 null 반환', async () => {
      mocks.existsSync.mockReturnValue(false);
      const { loadHookConfig: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('notepad-injector')).toBeNull();
    });

    it('v2 형식에서 훅 설정 반환', async () => {
      mockConfigFiles({
        global: { hooks: { 'notepad-injector': { enabled: true, maxLines: 50 } } },
      });
      const { loadHookConfig: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('notepad-injector')).toEqual({ enabled: true, maxLines: 50 });
    });

    it('레거시 형식에서 훅 설정 반환', async () => {
      mockConfigFiles({
        global: { 'notepad-injector': { enabled: false } },
      });
      const { loadHookConfig: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('notepad-injector')).toEqual({ enabled: false });
    });

    it('해당 훅이 없으면 null 반환', async () => {
      mockConfigFiles({ global: { hooks: {} } });
      const { loadHookConfig: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('nonexistent')).toBeNull();
    });
  });

  // ── mergeHookConfigs (순수 함수) ──

  describe('mergeHookConfigs', () => {
    it('프로젝트 설정이 글로벌의 특정 훅을 오버라이드', async () => {
      const { mergeHookConfigs } = await import('../src/hooks/hook-config.js');
      const global = {
        hooks: {
          'slop-detector': { enabled: true, threshold: 0.8 },
          'secret-filter': { enabled: true },
        },
      };
      const project = {
        hooks: {
          'slop-detector': { enabled: false },
        },
      };
      const merged = mergeHookConfigs(global, project);
      const hooks = merged.hooks as Record<string, Record<string, unknown>>;
      expect(hooks['slop-detector']).toEqual({ enabled: false });
      expect(hooks['secret-filter']).toEqual({ enabled: true });
    });

    it('프로젝트에 언급되지 않은 훅은 글로벌에서 상속', async () => {
      const { mergeHookConfigs } = await import('../src/hooks/hook-config.js');
      const global = {
        hooks: {
          'notepad-injector': { enabled: true, maxLines: 100 },
          'secret-filter': { enabled: true },
        },
        tiers: { workflow: { enabled: true } },
      };
      const project = {
        hooks: {
          'notepad-injector': { enabled: false },
        },
      };
      const merged = mergeHookConfigs(global, project);
      const hooks = merged.hooks as Record<string, Record<string, unknown>>;
      expect(hooks['notepad-injector']).toEqual({ enabled: false });
      expect(hooks['secret-filter']).toEqual({ enabled: true });
      const tiers = merged.tiers as Record<string, Record<string, unknown>>;
      expect(tiers.workflow).toEqual({ enabled: true });
    });

    it('프로젝트 tiers가 글로벌 tiers를 오버라이드', async () => {
      const { mergeHookConfigs } = await import('../src/hooks/hook-config.js');
      const global = {
        tiers: { workflow: { enabled: true }, safety: { enabled: true } },
      };
      const project = {
        tiers: { workflow: { enabled: false } },
      };
      const merged = mergeHookConfigs(global, project);
      const tiers = merged.tiers as Record<string, Record<string, unknown>>;
      expect(tiers.workflow).toEqual({ enabled: false });
      expect(tiers.safety).toEqual({ enabled: true });
    });

    it('레거시 최상위 키도 프로젝트가 오버라이드', async () => {
      const { mergeHookConfigs } = await import('../src/hooks/hook-config.js');
      const global = {
        'slop-detector': { enabled: true },
        'secret-filter': { enabled: true },
      };
      const project = {
        'slop-detector': { enabled: false },
      };
      const merged = mergeHookConfigs(global, project);
      expect(merged['slop-detector']).toEqual({ enabled: false });
      expect(merged['secret-filter']).toEqual({ enabled: true });
    });

    it('빈 프로젝트 설정은 글로벌을 그대로 반환', async () => {
      const { mergeHookConfigs } = await import('../src/hooks/hook-config.js');
      const global = {
        hooks: { 'slop-detector': { enabled: true } },
        tiers: { workflow: { enabled: true } },
      };
      const merged = mergeHookConfigs(global, {});
      expect(merged).toEqual(global);
    });
  });

  // ── 프로젝트 레벨 설정 통합 ──

  describe('프로젝트 레벨 설정 통합', () => {
    it('프로젝트 설정이 글로벌의 특정 훅을 오버라이드 (isHookEnabled)', async () => {
      mockConfigFiles({
        global: { hooks: { 'slop-detector': { enabled: true } } },
        project: { hooks: { 'slop-detector': { enabled: false } } },
      });
      const { isHookEnabled: fn } = await import('../src/hooks/hook-config.js');
      // 프로젝트에서 slop-detector를 비활성화
      expect(fn('slop-detector')).toBe(false);
    });

    it('프로젝트 설정이 없으면 글로벌만 사용 (하위호환)', async () => {
      mockConfigFiles({
        global: { hooks: { 'notepad-injector': { enabled: false } } },
        project: null,
      });
      const { isHookEnabled: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('notepad-injector')).toBe(false);
    });

    it('글로벌 설정 없이 프로젝트 설정만 있어도 동작', async () => {
      mockConfigFiles({
        global: null,
        project: { hooks: { 'notepad-injector': { enabled: false } } },
      });
      const { isHookEnabled: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('notepad-injector')).toBe(false);
    });

    it('프로젝트에 언급 없는 훅은 글로벌 설정 상속 (isHookEnabled)', async () => {
      mockConfigFiles({
        global: {
          hooks: {
            'notepad-injector': { enabled: false },
            'secret-filter': { enabled: false },
          },
        },
        project: {
          hooks: {
            'notepad-injector': { enabled: true },
          },
        },
      });
      const { isHookEnabled: fn } = await import('../src/hooks/hook-config.js');
      // 프로젝트에서 명시적 활성화
      expect(fn('notepad-injector')).toBe(true);
      // 글로벌에서 상속 (비활성화)
      expect(fn('secret-filter')).toBe(false);
    });

    it('프로젝트에서 tiers 오버라이드 (isHookEnabled)', async () => {
      mockConfigFiles({
        global: { tiers: { workflow: { enabled: true } } },
        project: { tiers: { workflow: { enabled: false } } },
      });
      const { isHookEnabled: fn } = await import('../src/hooks/hook-config.js');
      expect(fn('intent-classifier')).toBe(false);
    });
  });

  // ── resolveProjectCwd ──

  describe('resolveProjectCwd', () => {
    it('FORGEN_CWD가 설정되면 우선 사용', async () => {
      process.env.FORGEN_CWD = '/custom/forgen/cwd';
      process.env.COMPOUND_CWD = '/custom/compound/cwd';
      const { resolveProjectCwd } = await import('../src/hooks/hook-config.js');
      expect(resolveProjectCwd()).toBe('/custom/forgen/cwd');
    });

    it('FORGEN_CWD가 없으면 COMPOUND_CWD 사용', async () => {
      delete process.env.FORGEN_CWD;
      process.env.COMPOUND_CWD = '/custom/compound/cwd';
      const { resolveProjectCwd } = await import('../src/hooks/hook-config.js');
      expect(resolveProjectCwd()).toBe('/custom/compound/cwd');
    });

    it('둘 다 없으면 process.cwd() 사용', async () => {
      delete process.env.FORGEN_CWD;
      delete process.env.COMPOUND_CWD;
      const { resolveProjectCwd } = await import('../src/hooks/hook-config.js');
      expect(resolveProjectCwd()).toBe(process.cwd());
    });
  });
});
