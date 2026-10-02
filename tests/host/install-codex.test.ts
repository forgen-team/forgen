/**
 * Codex InstallPlan — Multi-Host Core Design §10 우선순위 3 단위 테스트
 *
 * 핵심 검증:
 *   - hooks.json 가 절대경로 + codex-adapter wrap 으로 생성된다 (spec §18.5 옵션 1).
 *   - 사용자 비-forgen hook 은 보존된다 (managed marker pattern).
 *   - 재실행 시 idempotent (forgen entry 가 중복되지 않는다).
 *   - MCP 등록은 marker block 으로 idempotent.
 *   - $CODEX_HOME 존중.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planCodexInstall } from '../../src/host/install-codex.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const PKG_ROOT = process.cwd(); // forgen 자체

describe('planCodexInstall', () => {
  let codexHome: string;

  beforeEach(() => {
    codexHome = tmpDir('codex-install-test-');
  });

  afterEach(() => {
    if (fs.existsSync(codexHome)) {
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('빈 codexHome 에 hooks.json 새로 작성, 절대경로 + codex-adapter wrap', () => {
    const result = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    expect(result.hooksWritten).toBe(true);
    expect(result.hooksCount).toBeGreaterThan(0);
    expect(result.preservedUserHookCount).toBe(0);

    const written = JSON.parse(fs.readFileSync(result.hooksPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const allCommands = Object.values(written.hooks)
      .flat()
      .flatMap((g) => g.hooks.map((h) => h.command));
    expect(allCommands.length).toBe(result.hooksCount);
    // 모든 command 가 codex-adapter 를 경유 + 절대경로
    for (const c of allCommands) {
      expect(c).toContain('codex-adapter');
      expect(c).toMatch(/node "\/.+codex-adapter\.js"/);
      expect(c).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    }
  });

  it('사용자가 직접 작성한 hook 항목은 보존된다', () => {
    const userHooksPath = path.join(codexHome, 'hooks.json');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      userHooksPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'node /home/user/my-own-hook.js' }],
            },
          ],
        },
      }),
    );

    const result = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    expect(result.preservedUserHookCount).toBe(1);

    const final = JSON.parse(fs.readFileSync(result.hooksPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const pre = (final.hooks.PreToolUse ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    expect(pre).toContain('node /home/user/my-own-hook.js');
    // forgen 측 entry 도 함께 존재
    expect(pre.some((c) => c.includes('codex-adapter'))).toBe(true);
  });

  it('재실행 시 idempotent — forgen entry 가 중복되지 않음', () => {
    const r1 = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    const r2 = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    expect(r2.hooksCount).toBe(r1.hooksCount);
    expect(r2.preservedUserHookCount).toBe(0);
  });

  it('MCP 등록 marker block 이 idempotent (재실행 시 alreadyPresent=true)', () => {
    const r1 = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    expect(r1.mcpRegistered).toBe(true);
    expect(r1.mcpAlreadyPresent).toBe(false);

    const r2 = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    expect(r2.mcpRegistered).toBe(false);
    expect(r2.mcpAlreadyPresent).toBe(true);

    const toml = fs.readFileSync(r1.configTomlPath, 'utf-8');
    const beginCount = (toml.match(/forgen-managed-mcp/g) || []).length;
    expect(beginCount).toBe(2); // begin + end markers, single block
    expect(toml).toContain('[mcp_servers.forgen-compound]');
    expect(toml).toContain('command = "node"');
  });

  it('config.toml 에 사용자 기존 내용이 있어도 보존', () => {
    const tomlPath = path.join(codexHome, 'config.toml');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(tomlPath, '[user]\nkey = "value"\n');

    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    expect(r.mcpRegistered).toBe(true);

    const toml = fs.readFileSync(tomlPath, 'utf-8');
    expect(toml).toContain('[user]');
    expect(toml).toContain('key = "value"');
    expect(toml).toContain('[mcp_servers.forgen-compound]');
  });

  it('dryRun: 파일 미작성', () => {
    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, dryRun: true });
    expect(r.hooksWritten).toBe(false);
    expect(fs.existsSync(r.hooksPath)).toBe(false);
    expect(fs.existsSync(r.configTomlPath)).toBe(false);
  });

  it('registerMcp:false + registerNotify:false 면 config.toml 미작성', () => {
    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, registerMcp: false, registerNotify: false });
    expect(r.mcpRegistered).toBe(false);
    expect(r.notify).toBe('skipped');
    expect(fs.existsSync(r.configTomlPath)).toBe(false);
  });

  it('registerMcp:false 만 주면 MCP 블록 없이 notify 블록만 쓴다', () => {
    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, registerMcp: false });
    expect(r.mcpRegistered).toBe(false);
    expect(r.notify).toBe('installed');
    const toml = fs.readFileSync(r.configTomlPath, 'utf-8');
    expect(toml).toContain('forgen-managed-notify');
    expect(toml).not.toContain('mcp_servers.forgen-compound');
  });

  it('P3-3: Codex skills/ 에 forgen 10 commands install (SKILL.md frontmatter)', () => {
    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    expect(r.skillsInstalled).toBeGreaterThan(0);
    expect(fs.existsSync(r.skillsPath)).toBe(true);
    const skillDirs = fs.readdirSync(r.skillsPath);
    expect(skillDirs.length).toBeGreaterThan(0);
    // 각 skill 은 SKILL.md + frontmatter
    const sampleSkill = skillDirs[0];
    const skillContent = fs.readFileSync(path.join(r.skillsPath, sampleSkill, 'SKILL.md'), 'utf-8');
    expect(skillContent).toMatch(/^---\nname:/);
    expect(skillContent).toContain('description:');
    expect(skillContent).toContain('<!-- forgen-managed -->');
  });

  it('P3-3: Codex skills install idempotent (사용자 작성 SKILL.md 보존)', () => {
    const r1 = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    // 사용자가 한 skill 을 직접 작성 (forgen-managed marker 없음)
    const userSkillDir = path.join(r1.skillsPath, 'compound');
    fs.writeFileSync(path.join(userSkillDir, 'SKILL.md'), '---\nname: compound\ndescription: USER\n---\n\nUSER edited');
    const r2 = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    expect(r2.skillsInstalled).toBeLessThan(r1.skillsInstalled); // user-modified 1개 skip
    const userSkill = fs.readFileSync(path.join(userSkillDir, 'SKILL.md'), 'utf-8');
    expect(userSkill).toContain('USER edited'); // 보존
  });

  it('P3-3: AGENTS.md 에 forgen-managed-rules block 인젝션 (override path)', () => {
    const isolatedAgentsMd = path.join(codexHome, 'AGENTS.md');
    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: isolatedAgentsMd });
    expect(r.agentsMdPath).toBe(isolatedAgentsMd);
    expect(r.agentsMdInjected).toBe(true);
    expect(fs.existsSync(isolatedAgentsMd)).toBe(true);
    const content = fs.readFileSync(isolatedAgentsMd, 'utf-8');
    expect(content).toContain('forgen-managed-rules');
    expect(content).toContain('forgen-compound MCP');
  });

  it('P3-3: AGENTS.md 재실행 idempotent (block 1 개만 유지)', () => {
    const isolatedAgentsMd = path.join(codexHome, 'AGENTS.md');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(isolatedAgentsMd, '# User existing\n\nUser content here\n');
    planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: isolatedAgentsMd });
    planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: isolatedAgentsMd });
    const content = fs.readFileSync(isolatedAgentsMd, 'utf-8');
    expect(content).toContain('User existing');
    expect(content).toContain('User content here');
    const beginCount = (content.match(/forgen-managed-rules/g) ?? []).length;
    expect(beginCount).toBe(2); // begin + end markers, single block (not 4 = double block)
  });

  it('v0.4.9: dev-guide skills 14개 ~/.codex/skills/forgen-<stack>-<skill> 에 설치', () => {
    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    expect(r.devGuideSkillsInstalled).toBe(14);
    expect(r.devGuideSkillsRemoved).toBe(0); // 첫 실행 — 기존 stale 없음
    expect(fs.existsSync(r.devGuideSkillsPath)).toBe(true);

    const dirs = fs.readdirSync(r.devGuideSkillsPath).filter((d) => /^forgen-(react|vue|node|go)-/.test(d));
    expect(dirs.length).toBe(14);

    // SKILL.md 각 항목이 파일로 접근 가능
    for (const d of dirs) {
      const p = path.join(r.devGuideSkillsPath, d, 'SKILL.md');
      expect(fs.existsSync(p), `${d}/SKILL.md 존재`).toBe(true);
    }
  });

  it('v0.4.9: dev-guide skills 재실행 idempotent — stale 정리 후 재설치', () => {
    planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    const r2 = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });
    expect(r2.devGuideSkillsInstalled).toBe(14);
    expect(r2.devGuideSkillsRemoved).toBe(14); // 이전 14개 정리 후 재설치
  });

  it('v0.4.9: dryRun — dev-guide count 반환, 파일 미생성', () => {
    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, dryRun: true });
    expect(r.devGuideSkillsInstalled).toBe(14);
    expect(r.devGuideSkillsRemoved).toBe(0);
    // dryRun 이므로 codexSkillsDir 자체가 미생성
    expect(fs.existsSync(r.devGuideSkillsPath)).toBe(false);
  });

  it('v0.4.9: forgen 자체 commands (forgen-compound 등) 는 dev-guide cleanup 에서 보존', () => {
    // forgen-compound 디렉토리 수동 생성 (forgen 10 commands 시뮬레이션)
    const skillsDir = path.join(codexHome, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'forgen-compound'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'forgen-compound', 'SKILL.md'), 'compound skill');

    planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });

    // forgen-compound (react/vue/node/go 패턴 아님) 는 보존되어야 함
    expect(fs.existsSync(path.join(skillsDir, 'forgen-compound', 'SKILL.md'))).toBe(true);
  });

  it('v0.4.9: 사용자 own codex skills (forgen 패턴 아닌 것) 보존', () => {
    const skillsDir = path.join(codexHome, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'my-custom-skill'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'my-custom-skill', 'SKILL.md'), 'user skill');

    planCodexInstall({ pkgRoot: PKG_ROOT, codexHome });

    expect(fs.existsSync(path.join(skillsDir, 'my-custom-skill', 'SKILL.md'))).toBe(true);
    const content = fs.readFileSync(path.join(skillsDir, 'my-custom-skill', 'SKILL.md'), 'utf-8');
    expect(content).toBe('user skill');
  });

  it('CODEX_HOME env var 로 위치 재배치', () => {
    const original = process.env.CODEX_HOME;
    const altHome = tmpDir('codex-alt-');
    try {
      process.env.CODEX_HOME = altHome;
      const r = planCodexInstall({ pkgRoot: PKG_ROOT });
      expect(r.codexHome).toBe(altHome);
      expect(fs.existsSync(path.join(altHome, 'hooks.json'))).toBe(true);
    } finally {
      if (original === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = original;
      fs.rmSync(altHome, { recursive: true, force: true });
    }
  });
});

// ── ADR-014 (v0.5.3): Codex agents TOML + skill adaptation + hook trust audit ──

import { adaptSkillBodyForCodex, auditCodexHookTrust, codexHookEventKey, codexHookTrustHash, isCodexMultiAgentEnabled, isForgenHookCommand, removeNotifyBlock, renderCodexAgentToml, upsertNotifyBlock } from '../../src/host/install-codex.js';

type TrustFixtureRow = [event: string, matcher: string, handler: { type: 'command'; command: string; timeout: number }, expected: string];
/** Codex 0.153.4 가 실머신에서 기록한 trusted_hash (2026-10-02 `~/.codex/config.toml`). */
const REAL_TRUST_FIXTURE = (cmd: (n: string, arg?: string) => string): TrustFixtureRow[] => [
  ['UserPromptSubmit', '*', { type: 'command', command: cmd('notepad-injector'), timeout: 3 }, 'sha256:e1329ea49297337891c86559c0e60f3b710f87b2e20f90b6096d2d38f2940f9c'],
  ['SessionStart', '*', { type: 'command', command: cmd('session-recovery'), timeout: 3 }, 'sha256:e518fe4cddeb0b88b97d5fee0e344c7c42c664003c4005ef7463950e2446d323'],
  ['PostToolUse', 'Write|Edit|Bash', { type: 'command', command: cmd('secret-filter'), timeout: 3 }, 'sha256:1c6306f4306b02e75f1b7e4225f7f8bcf81875676ed35d6598b7ff6f51ab17cb'],
  ['Stop', '*', { type: 'command', command: cmd('stop-guard'), timeout: 10 }, 'sha256:8c2d9488a51da8af2f535afb7f1444e2cc0b947b9eb35e089537ddd3e5ab964d'],
  ['PreToolUse', 'Bash', { type: 'command', command: cmd('db-guard'), timeout: 3 }, 'sha256:0538322eddbacc755d1f880723a42eaef4a22ec9de0bf2732cba3ef2fa6ab9f5'],
  ['PermissionRequest', '*', { type: 'command', command: cmd('permission-handler'), timeout: 2 }, 'sha256:044b64034bb1e42b0c6bdae9a1c6e4f8c7d61a6a110af85699694304578d1164'],
  ['SubagentStart', '*', { type: 'command', command: cmd('subagent-tracker', ' "start"'), timeout: 2 }, 'sha256:3a2f0556d0925b29831dd805374d5d7f0537bae22b2665fbc63ecbeb87a5c535'],
  ['PreCompact', '*', { type: 'command', command: cmd('pre-compact'), timeout: 3 }, 'sha256:0ebcb3fb0274f8c509d014a7cff7029859221dfedc0e1297092de51f8a8252af'],
];

describe('ADR-014 Codex parity', () => {
  let codexHome: string;
  beforeEach(() => { codexHome = tmpDir('codex-adr014-'); });
  afterEach(() => { fs.rmSync(codexHome, { recursive: true, force: true }); });

  it('D2: assets/claude/agents/*.md 전부가 ~/.codex/agents/ch-*.toml 로 설치된다', () => {
    const result = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    const sourceCount = fs.readdirSync(path.join(PKG_ROOT, 'assets', 'claude', 'agents')).filter((f) => f.endsWith('.md')).length;
    expect(result.agentsInstalled).toBe(sourceCount);
    const files = fs.readdirSync(result.agentsPath).filter((f) => f.endsWith('.toml'));
    expect(files.length).toBe(sourceCount);
    for (const f of files) expect(f).toMatch(/^ch-[a-z0-9-]+\.toml$/);

    const verifier = fs.readFileSync(path.join(result.agentsPath, 'ch-verifier.toml'), 'utf-8');
    expect(verifier.startsWith('# forgen-managed')).toBe(true);
    expect(verifier).toContain('name = "ch-verifier"');
    expect(verifier).toMatch(/^description = ".+"$/m);
    expect(verifier).toContain('sandbox_mode = "read-only"'); // tools 에 Write/Edit 없음
    expect(verifier).toContain('developer_instructions = """');
    const executor = fs.readFileSync(path.join(result.agentsPath, 'ch-executor.toml'), 'utf-8');
    expect(executor).toContain('sandbox_mode = "workspace-write"');
    expect(executor).toContain('model_reasoning_effort = "medium"'); // sonnet → medium
    // critic 2026-10-01: disallowedTools: [Write, Edit] 로 선언된 읽기전용 에이전트
    for (const ro of ['ch-critic', 'ch-architect', 'ch-code-reviewer', 'ch-planner', 'ch-analyst', 'ch-explore', 'ch-git-master']) {
      expect(fs.readFileSync(path.join(result.agentsPath, `${ro}.toml`), 'utf-8'), ro).toContain('sandbox_mode = "read-only"');
    }
    expect(result.multiAgentEnabled).toBe(false); // 빈 config.toml
  });

  it('D2: disallowedTools / 인라인 배열 / DEL 문자 처리', () => {
    const ro = renderCodexAgentToml('a.md', '---\nname: ch-a\ndescription: d\ndisallowedTools:\n  - Write\n  - Edit\n---\nbody')!;
    expect(ro.toml).toContain('sandbox_mode = "read-only"');
    const inline = renderCodexAgentToml('b.md', '---\nname: ch-b\ndescription: d\ntools: [Read, Bash]\n---\nbody')!;
    expect(inline.toml).toContain('sandbox_mode = "read-only"');
    const none = renderCodexAgentToml('c.md', '---\nname: ch-c\ndescription: d\n---\nbody')!;
    expect(none.toml).toContain('sandbox_mode = "workspace-write"');
    const del = renderCodexAgentToml('d.md', '---\nname: ch-d\ndescription: x\u007fy\n---\nbody\u007f!')!;
    expect(del.toml).not.toContain('\u007f');
  });

  it('D2: dryRun 은 사용자 파일을 제외한 설치 예정 수를 돌려주고 파일을 쓰지 않는다', () => {
    const agentsDir = path.join(codexHome, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'ch-verifier.toml'), 'name = "ch-verifier"\ndescription = "USER"\ndeveloper_instructions = "x"\n');
    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, dryRun: true, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    const sourceCount = fs.readdirSync(path.join(PKG_ROOT, 'assets', 'claude', 'agents')).filter((f) => f.endsWith('.md')).length;
    expect(r.agentsInstalled).toBe(sourceCount - 1);
    expect(fs.readdirSync(agentsDir)).toEqual(['ch-verifier.toml']);
  });

  it('D2: isCodexMultiAgentEnabled 는 [features] 섹션 안의 multi_agent 만 본다', () => {
    expect(isCodexMultiAgentEnabled('')).toBe(false);
    expect(isCodexMultiAgentEnabled('[features]\nmulti_agent = true\n')).toBe(true);
    expect(isCodexMultiAgentEnabled('[features]\nmulti_agent = false\n')).toBe(false);
    expect(isCodexMultiAgentEnabled('[other]\nmulti_agent = true\n[features]\nx = 1\n')).toBe(false);
    expect(isCodexMultiAgentEnabled('model = "gpt-5.5"\n\n[features]\nmulti_agent = true\n\n[mcp_servers.x]\nurl = "u"\n')).toBe(true);
  });

  it('D2: 재실행 idempotent — forgen-managed 만 교체, 사용자 toml 보존', () => {
    const agentsDir = path.join(codexHome, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'ch-mine.toml'), 'name = "ch-mine"\ndescription = "user"\ndeveloper_instructions = "x"\n');
    fs.writeFileSync(path.join(agentsDir, 'ch-verifier.toml'), 'name = "ch-verifier"\ndescription = "USER OVERRIDE"\ndeveloper_instructions = "x"\n');
    const r1 = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    const sourceCount = fs.readdirSync(path.join(PKG_ROOT, 'assets', 'claude', 'agents')).filter((f) => f.endsWith('.md')).length;
    expect(r1.agentsInstalled).toBe(sourceCount - 1); // ch-verifier 는 사용자 파일이라 skip
    expect(fs.readFileSync(path.join(agentsDir, 'ch-verifier.toml'), 'utf-8')).toContain('USER OVERRIDE');
    expect(fs.existsSync(path.join(agentsDir, 'ch-mine.toml'))).toBe(true);
    const r2 = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    expect(r2.agentsRemoved).toBe(sourceCount - 1);
    expect(r2.agentsInstalled).toBe(sourceCount - 1);
    expect(fs.readdirSync(agentsDir).filter((f) => f.endsWith('.toml')).length).toBe(sourceCount + 1);
  });

  it('D2: renderCodexAgentToml — 삼중따옴표/백슬래시 이스케이프, 공식 스키마 외 키 없음', () => {
    const raw = '---\nname: ch-x\ndescription: Desc "q"\nmodel: opus\nmaxTurns: 3\ntools:\n  - Read\n---\n\nbody with """ and \\ slash\n';
    const r = renderCodexAgentToml('x.md', raw)!;
    expect(r.name).toBe('ch-x');
    expect(r.toml).toContain('description = "Desc \\"q\\""');
    expect(r.toml).toContain('model_reasoning_effort = "high"');
    expect(r.toml).toContain('sandbox_mode = "read-only"');
    expect(r.toml).toContain('body with \\"\\"\\" and \\\\ slash');
    const keys = r.toml.split('\n').filter((l) => /^[a-z_]+ = /.test(l)).map((l) => l.split(' = ')[0]);
    expect(keys.sort()).toEqual(['description', 'developer_instructions', 'model_reasoning_effort', 'name', 'sandbox_mode']);
    expect(r.toml).not.toContain('maxTurns');
  });

  it('D3: Codex 스킬에 $ARGUMENTS 가 남지 않고 host note 가 붙는다', () => {
    const result = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    const forgeLoop = fs.readFileSync(path.join(result.skillsPath, 'forge-loop', 'SKILL.md'), 'utf-8');
    expect(forgeLoop).not.toContain('$ARGUMENTS');
    expect(forgeLoop).toContain('## Codex host note (forgen-managed)');
    expect(forgeLoop).toContain('invoke-agent');
    expect(adaptSkillBodyForCodex('"task": "{$ARGUMENTS}"')).toBe('"task": "{the user\'s request text}"');
    expect(adaptSkillBodyForCodex('`$ARGUMENTS` 에서 파싱')).not.toContain('$ARGUMENTS');
  });

  it('D4: auditCodexHookTrust — trusted / modified / untrusted 를 해시로 구분 (ADR-016 D2)', () => {
    expect(codexHookEventKey('PreToolUse')).toBe('pre_tool_use');
    expect(codexHookEventKey('PostToolUseFailure')).toBe('post_tool_use_failure');
    const hooksPath = path.join(codexHome, 'hooks.json');
    const cmd = (n: string) => `node "${PKG_ROOT}/dist/host/codex-adapter.js" "${PKG_ROOT}/dist/hooks/${n}.js"`;
    const pre = { type: 'command', command: cmd('pre-tool-use'), timeout: 3 };
    const stop = { type: 'command', command: cmd('stop-guard'), timeout: 10 };
    const hooksFile = {
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [pre, { type: 'command', command: cmd('rate-limiter'), timeout: 2 }] }],
        Stop: [{ matcher: '*', hooks: [stop] }, { matcher: '*', hooks: [{ type: 'command', command: 'bash /home/u/my-hook.sh', timeout: 1 }] }],
        // Claude 전용 이벤트 — Codex 가 무시하므로 total 에서 제외되어야 함 (critic 2026-10-01)
        PostToolUseFailure: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('post-tool-failure'), timeout: 3 }] }],
      },
    };
    const toml = [
      `[hooks.state."${hooksPath}:pre_tool_use:0:0"]`, `trusted_hash = "${codexHookTrustHash('PreToolUse', '*', pre)}"`,
      `[hooks.state."${hooksPath}:stop:0:0"]`, 'enabled = true', `trusted_hash = "${codexHookTrustHash('Stop', '*', stop)}"`,
      `[hooks.state."${hooksPath}:stop:1:0"]`, 'trusted_hash = "sha256:cc"', // 사용자 훅 — 집계 제외
    ].join('\n');
    const audit = auditCodexHookTrust({ hooksPath, configTomlPath: path.join(codexHome, 'config.toml'), pkgRoot: PKG_ROOT, hooksFile, configToml: toml });
    expect(audit.total).toBe(3);
    expect(audit.trusted).toBe(2);
    expect(audit.modified).toEqual([]);
    expect(audit.untrusted).toEqual(['pre_tool_use:0:1']);
    expect(audit.ignoredByCodex).toEqual(['post_tool_use_failure:0:0']);
    expect(audit.noStateRecorded).toBe(false);

    // 핸들러 필드가 바뀌면(timeout 3→5) 신뢰 기록이 있어도 Codex 는 skip 한다 → modified
    const changed = { hooks: { ...hooksFile.hooks, PreToolUse: [{ matcher: '*', hooks: [{ ...pre, timeout: 5 }, hooksFile.hooks.PreToolUse[0].hooks[1]] }] } };
    const drift = auditCodexHookTrust({ hooksPath, configTomlPath: path.join(codexHome, 'config.toml'), pkgRoot: PKG_ROOT, hooksFile: changed, configToml: toml });
    expect(drift.trusted).toBe(1);
    expect(drift.modified).toEqual(['pre_tool_use:0:0']);

    // 승인돼 있어도 사용자가 /hooks 에서 끈 훅(enabled = false)은 Codex 가 실행하지 않는다 → disabled
    const off = auditCodexHookTrust({ hooksPath, configTomlPath: path.join(codexHome, 'config.toml'), pkgRoot: PKG_ROOT, hooksFile, configToml: toml.replace('enabled = true', 'enabled = false') });
    expect(off.disabled).toEqual(['stop:0:0']);
    expect(off.trusted).toBe(1);

    // Codex 가 literal('…') 키나 CRLF 로 쓴 섹션도 읽는다
    const literal = toml.replace(`[hooks.state."${hooksPath}:pre_tool_use:0:0"]`, `[hooks.state.'${hooksPath}:pre_tool_use:0:0']`).replace(/\n/g, '\r\n');
    expect(auditCodexHookTrust({ hooksPath, configTomlPath: path.join(codexHome, 'config.toml'), pkgRoot: PKG_ROOT, hooksFile, configToml: literal }).trusted).toBe(2);

    // trusted_hash 없이 enabled 만 있는 섹션은 미승인
    const noHash = auditCodexHookTrust({ hooksPath, configTomlPath: path.join(codexHome, 'config.toml'), pkgRoot: PKG_ROOT, hooksFile, configToml: `[hooks.state."${hooksPath}:stop:0:0"]\nenabled = false\n` });
    expect(noHash.untrusted).toContain('stop:0:0');

    const none = auditCodexHookTrust({ hooksPath, configTomlPath: path.join(codexHome, 'config.toml'), pkgRoot: PKG_ROOT, hooksFile, configToml: '' });
    expect(none.trusted).toBe(0);
    expect(none.noStateRecorded).toBe(true);
  });

  it('codexHookTrustHash — Codex 0.153.4 가 실제로 기록한 trusted_hash 와 일치 (실머신 fixture)', () => {
    // 실 ~/.codex/config.toml 의 [hooks.state] 에서 가져온 값 (2026-10-02, forgen 0.5.5 설치 상태).
    // 경로/인덱스는 해시에 들어가지 않는다 — command 문자열·timeout·matcher·event 만.
    const root = '/home/ubuntu/.nvm/versions/node/v22.22.0/lib/node_modules/@wooojin/forgen/dist';
    const cmd = (n: string, arg = '') => `node "${root}/host/codex-adapter.js" "${root}/hooks/${n}.js"${arg}`;
    for (const [event, matcher, handler, expected] of REAL_TRUST_FIXTURE(cmd)) {
      expect(codexHookTrustHash(event, matcher, handler), `${event} ${handler.command}`).toBe(expected);
    }
  });

  it('codexHookTrustHash — Codex `hooks/list` 의 currentHash 와 일치 (0.5.6 이 추가한 핸들러 형태)', () => {
    // 격리 CODEX_HOME 에서 Codex 0.153.4 app-server `hooks/list` 가 계산한 값 (2026-10-02).
    const adapter = (n: string) => `node "/X/dist/host/codex-adapter.js" "/X/dist/hooks/${n}.js"`;
    expect(codexHookTrustHash('SessionStart', '*', { type: 'command', command: adapter('session-recovery'), timeout: 3, additionalContextLimit: 0 }))
      .toBe('sha256:0ea28725702db95e579db421859b9a994ce98d0ba87838f0ef03acff370a0698');
    expect(codexHookTrustHash('SessionEnd', '*', { type: 'command', command: adapter('session-end'), timeout: 3 }))
      .toBe('sha256:48db5bce67b2678842c909b305fd954f8b503fe50596f7264e5131a13d469f15');
    expect(codexHookTrustHash('Stop', '*', { type: 'command', command: 'echo a', timeout: 7, async: true }))
      .toBe('sha256:c762a60e062d747b21bc3ebd85279a70d3703d4841db4393a940eac6c8aa8188');
  });

  it('codexHookTrustHash — 정규화 규칙', () => {
    const h = { type: 'command', command: 'x' };
    // timeout 생략 = 600 (SessionEnd/Interrupt 는 1, 1~3 clamp)
    expect(codexHookTrustHash('PreToolUse', '*', h)).toBe(codexHookTrustHash('PreToolUse', '*', { ...h, timeout: 600 }));
    expect(codexHookTrustHash('SessionEnd', '*', { ...h, timeout: 10 })).toBe(codexHookTrustHash('SessionEnd', '*', { ...h, timeout: 3 }));
    expect(codexHookTrustHash('SessionEnd', '*', h)).toBe(codexHookTrustHash('SessionEnd', '*', { ...h, timeout: 1 }));
    // matcher 는 UserPromptSubmit/Stop/Interrupt 에서 무시
    expect(codexHookTrustHash('Stop', '*', h)).toBe(codexHookTrustHash('Stop', undefined, h));
    expect(codexHookTrustHash('PreToolUse', 'Bash', h)).not.toBe(codexHookTrustHash('PreToolUse', '*', h));
    // additionalContextLimit: 기본값 2500 은 생략과 동치, 0 은 다른 해시, 미지원 이벤트에선 무시
    expect(codexHookTrustHash('SessionStart', '*', { ...h, additionalContextLimit: 2500 })).toBe(codexHookTrustHash('SessionStart', '*', h));
    expect(codexHookTrustHash('SessionStart', '*', { ...h, additionalContextLimit: 0 })).not.toBe(codexHookTrustHash('SessionStart', '*', h));
    expect(codexHookTrustHash('Stop', '*', { ...h, additionalContextLimit: 0 })).toBe(codexHookTrustHash('Stop', '*', h));
    // async 는 해시에 포함, 미지 필드는 불포함
    expect(codexHookTrustHash('PostToolUse', '*', { ...h, async: true })).not.toBe(codexHookTrustHash('PostToolUse', '*', h));
    // upstream 은 SessionEnd 에서도 raw async 플래그를 해시한다 (동기 강등은 실행 방식에만 반영)
    expect(codexHookTrustHash('SessionEnd', '*', { ...h, async: true })).not.toBe(codexHookTrustHash('SessionEnd', '*', h));
    expect(codexHookTrustHash('PostToolUse', '*', { ...h, bogus: 1 } as never)).toBe(codexHookTrustHash('PostToolUse', '*', h));
    // command 훅이 아니면 null
    expect(codexHookTrustHash('Stop', '*', { type: 'prompt' })).toBeNull();
  });

  it('D4: planCodexInstall 결과에 hookTrust 가 포함되고, 신규 홈에서는 전부 untrusted', () => {
    const result = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    // 0.5.6: Codex 가 무시하는 PostToolUseFailure 는 더 이상 등록하지 않는다 → 전부 trust 대상
    expect(result.hookTrust.total).toBe(result.hooksCount);
    expect(result.hookTrust.ignoredByCodex).toEqual([]);
    expect(result.hookTrust.trusted).toBe(0);
    expect(result.hookTrust.modified).toEqual([]);
    expect(result.hookTrust.noStateRecorded).toBe(true);
  });

  it('심링크된 CODEX_HOME: Codex 는 canonical 경로로 키를 쓴다 — raw 경로로도 대조된다', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-real-'));
    const link = `${real}-link`;
    fs.symlinkSync(real, link, 'dir');
    try {
      const fresh = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome: link, agentsMdPath: path.join(real, 'AGENTS.md') });
      const hooks = JSON.parse(fs.readFileSync(fresh.hooksPath, 'utf-8')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> };
      const canonical = fs.realpathSync(fresh.hooksPath);
      expect(canonical).not.toBe(fresh.hooksPath);
      const g = hooks.hooks.Stop[0];
      fs.appendFileSync(fresh.configTomlPath, `\n[hooks.state."${canonical}:stop:0:0"]\ntrusted_hash = "${codexHookTrustHash('Stop', g.matcher, g.hooks[0])}"\n`);
      const again = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome: link, agentsMdPath: path.join(real, 'AGENTS.md') });
      expect(again.hookTrust.trusted).toBe(1);
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it('0.5.5 → 0.5.6 업그레이드: 재승인 대상은 session_start(modified) + session_end(신규) 뿐, 죽은 PostToolUseFailure 는 제거', () => {
    // 0.5.5 형 hooks.json: session-recovery 에 additionalContextLimit 없음, SessionEnd 없음, PostToolUseFailure 있음
    const fresh = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    type G = { matcher?: string; hooks: Array<Record<string, unknown>> };
    const cur = JSON.parse(fs.readFileSync(fresh.hooksPath, 'utf-8')) as { hooks: Record<string, G[]> };
    const old = structuredClone(cur);
    delete old.hooks.SessionEnd;
    for (const g of old.hooks.SessionStart) for (const h of g.hooks) delete h.additionalContextLimit;
    old.hooks.PostToolUseFailure = [{ matcher: '*', hooks: [{ type: 'command', command: `node "${PKG_ROOT}/dist/host/codex-adapter.js" "${PKG_ROOT}/dist/hooks/post-tool-failure.js"`, timeout: 3 }] }];
    fs.writeFileSync(fresh.hooksPath, `${JSON.stringify(old, null, 2)}\n`);
    // 사용자가 0.5.5 훅을 전부 승인해 둔 상태
    const state: string[] = [];
    for (const [ev, groups] of Object.entries(old.hooks)) {
      if (ev === 'PostToolUseFailure') continue;
      groups.forEach((g, gi) => g.hooks.forEach((h, hi) => {
        state.push(`[hooks.state."${fresh.hooksPath}:${codexHookEventKey(ev)}:${gi}:${hi}"]`, `trusted_hash = "${codexHookTrustHash(ev, g.matcher, h)}"`, '');
      }));
    }
    fs.appendFileSync(fresh.configTomlPath, `\n${state.join('\n')}`);

    const up = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    expect(up.hookTrust.modified).toEqual(['session_start:0:0']);
    expect(up.hookTrust.untrusted).toEqual(['session_end:0:0']);
    expect(up.hookTrust.trusted).toBe(up.hookTrust.total - 2);
    expect(up.hookTrust.ignoredByCodex).toEqual([]);
    const after = JSON.parse(fs.readFileSync(up.hooksPath, 'utf-8')) as { hooks: Record<string, unknown> };
    expect(Object.keys(after.hooks)).not.toContain('PostToolUseFailure');
  });
});

describe('hooks.json 그룹 순서 보존 (0.5.3 훅 신뢰 회귀)', () => {
  let codexHome: string;
  beforeEach(() => { codexHome = tmpDir('codex-order-'); });
  afterEach(() => { fs.rmSync(codexHome, { recursive: true, force: true }); });

  it('forgen 그룹이 앞, 사용자 그룹이 뒤인 기존 파일을 재설치해도 바이트 동일', () => {
    const first = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    const hooks = JSON.parse(fs.readFileSync(first.hooksPath, 'utf-8')) as { hooks: Record<string, unknown[]> };
    // 사용자 훅을 각 이벤트 *뒤* 에 추가 (orca 등 다른 도구가 append 하는 실제 형태)
    const userGroup = { matcher: '*', hooks: [{ type: 'command', command: "if [ -x '/home/u/.orca/hook.sh' ]; then /home/u/.orca/hook.sh; fi", timeout: 5 }] };
    for (const ev of ['UserPromptSubmit', 'Stop', 'PreToolUse']) hooks.hooks[ev].push(userGroup);
    fs.writeFileSync(first.hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
    const before = fs.readFileSync(first.hooksPath, 'utf-8');

    const second = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    const after = fs.readFileSync(second.hooksPath, 'utf-8');
    expect(second.preservedUserHookCount).toBe(3);
    expect(after).toBe(before); // 바이트 동일 → Codex trust 키(<event>:<groupIdx>:<hookIdx>) 유지
  });

  it('사용자 그룹이 앞인 파일도 그 순서를 유지하고, stale forgen 중복 그룹은 하나로 합친다', () => {
    const first = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    const hooks = JSON.parse(fs.readFileSync(first.hooksPath, 'utf-8')) as { hooks: Record<string, unknown[]> };
    const userGroup = { matcher: '*', hooks: [{ type: 'command', command: 'echo user', timeout: 1 }] };
    hooks.hooks.Stop = [userGroup, ...hooks.hooks.Stop, ...hooks.hooks.Stop]; // user 앞 + forgen 중복
    fs.writeFileSync(first.hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
    const second = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    const after = JSON.parse(fs.readFileSync(second.hooksPath, 'utf-8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(after.hooks.Stop[0].hooks[0].command).toBe('echo user');
    const forgenGroups = after.hooks.Stop.filter((g) => g.hooks.some((h) => h.command.includes('codex-adapter')));
    expect(forgenGroups.length).toBe(1);
  });
});

describe('ADR-016 D1: config.toml notify 폴백', () => {
  let codexHome: string;
  beforeEach(() => { codexHome = tmpDir('codex-notify-'); });
  afterEach(() => { fs.rmSync(codexHome, { recursive: true, force: true }); });
  const NOTIFY_JS = path.join(PKG_ROOT, 'dist', 'host', 'codex-notify.js');

  it('빈 config: 블록을 최상단에 쓰고, top-level 키가 첫 테이블 헤더보다 앞에 온다', () => {
    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    expect(r.notify).toBe('installed');
    const toml = fs.readFileSync(r.configTomlPath, 'utf-8');
    expect(toml.startsWith('# >>> forgen-managed-notify\n')).toBe(true);
    expect(toml).toContain(`notify = ${JSON.stringify(['node', NOTIFY_JS])}`);
    expect(toml.indexOf('notify = ')).toBeLessThan(toml.indexOf('[mcp_servers.forgen-compound]'));
  });

  it('기존 top-level 키·테이블을 보존하고 재설치는 바이트 동일 (idempotent)', () => {
    const user = 'model = "gpt-5.5"\napproval_policy = "on-request"\n\n[features]\nmulti_agent = true\n';
    fs.writeFileSync(path.join(codexHome, 'config.toml'), user);
    const r1 = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    const first = fs.readFileSync(r1.configTomlPath, 'utf-8');
    expect(first).toContain('model = "gpt-5.5"');
    expect(first.indexOf('notify = ')).toBeLessThan(first.indexOf('[features]'));
    expect(r1.multiAgentEnabled).toBe(true);
    const r2 = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    expect(r2.notify).toBe('already-present');
    expect(fs.readFileSync(r2.configTomlPath, 'utf-8')).toBe(first);
  });

  it('사용자 notify 가 있으면 건드리지 않는다 — 중복 키를 만들지 않는다', () => {
    const user = 'notify = ["terminal-notifier", "-title", "codex"]\nmodel = "x"\n';
    fs.writeFileSync(path.join(codexHome, 'config.toml'), user);
    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    expect(r.notify).toBe('user-defined');
    const toml = fs.readFileSync(r.configTomlPath, 'utf-8');
    expect(toml).toContain('notify = ["terminal-notifier", "-title", "codex"]');
    expect(toml).not.toContain('forgen-managed-notify');
    expect(toml.match(/^[ \t]*notify[ \t]*=/gm)).toHaveLength(1);
  });

  it('forgen 블록이 있는데 사용자가 나중에 자기 notify 를 추가했으면 forgen 블록을 걷어낸다', () => {
    const r1 = upsertNotifyBlock('model = "x"\n', PKG_ROOT);
    const withUser = `${r1.content}notify = ["mine"]\n`;
    const r2 = upsertNotifyBlock(withUser, PKG_ROOT);
    expect(r2.status).toBe('user-defined');
    expect(r2.content).not.toContain('forgen-managed-notify');
    expect(r2.content.match(/^[ \t]*notify[ \t]*=/gm)).toHaveLength(1);
    expect(r2.content).toContain('model = "x"');
  });

  it('블록 안에 사용자가 붙인 체인 꼬리("--", prog…)는 재설치 후에도 보존', () => {
    const r1 = upsertNotifyBlock('', PKG_ROOT);
    const chained = r1.content.replace(/^notify = .*$/m, `notify = ${JSON.stringify(['node', '/old/path/codex-notify.js', '--', 'terminal-notifier', '-title', 'codex'])}`);
    const r2 = upsertNotifyBlock(chained, PKG_ROOT);
    expect(r2.status).toBe('installed'); // 경로가 갱신됨
    expect(r2.content).toContain(`notify = ${JSON.stringify(['node', NOTIFY_JS, '--', 'terminal-notifier', '-title', 'codex'])}`);
    expect(upsertNotifyBlock(r2.content, PKG_ROOT).status).toBe('already-present');
  });

  it('dry-run 은 config.toml 을 쓰지 않는다', () => {
    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, dryRun: true, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    expect(r.notify).toBe('installed');
    expect(fs.existsSync(r.configTomlPath)).toBe(false);
  });
});

describe('config.toml managed blocks — Codex 가 블록 안에 써 넣은 내용 보존 (critic 2026-10-02)', () => {
  let codexHome: string;
  beforeEach(() => { codexHome = tmpDir('codex-blocks-'); });
  afterEach(() => { fs.rmSync(codexHome, { recursive: true, force: true }); });
  const install = () => planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });

  it('C2: /hooks 승인으로 MCP 블록 END 마커 앞에 끼어든 [hooks.state] 테이블이 재설치에서 살아남는다', () => {
    const r1 = install();
    const toml1 = fs.readFileSync(r1.configTomlPath, 'utf-8');
    expect(toml1.trimEnd().endsWith('# <<< forgen-managed-mcp')).toBe(true); // 신규 설치: 블록이 파일 끝
    // Codex(toml_edit)는 새 테이블을 파일 끝 주석(=END 마커) *앞* 에 넣는다 — 실 Codex 로 재현된 형태.
    const hooks = JSON.parse(fs.readFileSync(r1.hooksPath, 'utf-8')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> };
    const state: string[] = [];
    for (const [ev, groups] of Object.entries(hooks.hooks)) {
      groups.forEach((g, gi) => g.hooks.forEach((h, hi) => {
        state.push('', `[hooks.state."${r1.hooksPath}:${codexHookEventKey(ev)}:${gi}:${hi}"]`, `trusted_hash = "${codexHookTrustHash(ev, g.matcher, h)}"`);
      }));
    }
    const inside = toml1.replace('# <<< forgen-managed-mcp', `enabled = false\n${state.join('\n')}\n\n[features]\nmulti_agent = true\n# <<< forgen-managed-mcp`);
    fs.writeFileSync(r1.configTomlPath, inside);

    const r2 = install();
    const toml2 = fs.readFileSync(r2.configTomlPath, 'utf-8');
    expect(r2.hookTrust.trusted).toBe(r2.hookTrust.total); // 훅 신뢰 22건 전부 유지
    expect(r2.multiAgentEnabled).toBe(true);
    // 사용자가 Codex 에서 이 MCP 서버에 붙인 설정은 테이블 안에 남는다
    expect(toml2).toMatch(/\[mcp_servers\.forgen-compound\]\ncommand = "node"\nargs = .*\nenabled = false\n# <<< forgen-managed-mcp/);
    // 끼어든 테이블은 블록 밖(뒤)으로 옮겨진다 → 이후 Codex 가 추가하는 테이블도 밖에 쌓인다
    expect(toml2.indexOf('[hooks.state.')).toBeGreaterThan(toml2.indexOf('# <<< forgen-managed-mcp'));
    expect(toml2.match(/\[mcp_servers\.forgen-compound\]/g)).toHaveLength(1);
    // 재설치는 idempotent
    const r3 = install();
    expect(fs.readFileSync(r3.configTomlPath, 'utf-8')).toBe(toml2);
    expect(r3.mcpAlreadyPresent).toBe(true);
  });

  it('마커 없는 같은 이름의 MCP 테이블이 있으면 append 하지 않는다 (중복 테이블 = 파싱 실패)', () => {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[mcp_servers.forgen-compound]\ncommand = "node"\nargs = ["/mine.js"]\n');
    const r = install();
    const toml = fs.readFileSync(r.configTomlPath, 'utf-8');
    expect(toml.match(/\[mcp_servers\.forgen-compound\]/g)).toHaveLength(1);
    expect(toml).toContain('args = ["/mine.js"]');
  });

  it('C1: notify 블록 안에 Codex 가 써 넣은 root 키(model 등)가 재설치에서 살아남고 root-level 에 남는다', () => {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[projects."/home/u/p"]\ntrust_level = "trusted"\n');
    const r1 = install();
    const toml1 = fs.readFileSync(r1.configTomlPath, 'utf-8');
    // Codex 는 root 키를 root 테이블의 마지막 키(= forgen 의 notify 줄) 바로 뒤, END 마커 앞에 넣는다.
    const inside = toml1.replace('# <<< forgen-managed-notify', 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n# <<< forgen-managed-notify');
    fs.writeFileSync(r1.configTomlPath, inside);

    const r2 = install();
    const toml2 = fs.readFileSync(r2.configTomlPath, 'utf-8');
    expect(toml2).toContain('model = "gpt-5.5"');
    expect(toml2).toContain('model_reasoning_effort = "high"');
    const firstTable = toml2.search(/^\[/m);
    expect(toml2.indexOf('model = "gpt-5.5"')).toBeLessThan(firstTable); // 여전히 root-level
    expect(toml2.indexOf('model = "gpt-5.5"')).toBeGreaterThan(toml2.indexOf('# <<< forgen-managed-notify')); // 블록 밖으로
    expect(toml2).toContain('trust_level = "trusted"');
    expect(fs.readFileSync(install().configTomlPath, 'utf-8')).toBe(toml2); // idempotent
  });

  it('M1: BOM 으로 시작하는 config.toml — BOM 은 파일 맨 앞에 남는다', () => {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '\uFEFFmodel = "gpt-5"\n');
    const r = install();
    const toml = fs.readFileSync(r.configTomlPath, 'utf-8');
    expect(toml.startsWith('\uFEFF# >>> forgen-managed-notify')).toBe(true);
    expect(toml.indexOf('\uFEFF', 1)).toBe(-1);
    expect(fs.readFileSync(install().configTomlPath, 'utf-8')).toBe(toml);
  });

  it('CRLF 파일: 줄 끝을 보존하고 idempotent', () => {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"\r\n\r\n[features]\r\nmulti_agent = true\r\n');
    const r = install();
    const toml = fs.readFileSync(r.configTomlPath, 'utf-8');
    expect(toml.replace(/\r\n/g, '')).not.toContain('\n'); // 모든 줄이 CRLF
    expect(r.multiAgentEnabled).toBe(true);
    expect(fs.readFileSync(install().configTomlPath, 'utf-8')).toBe(toml);
  });

  it.each([
    ['"notify" = ["x"]'],
    ["'notify' = ['x']"],
    ['notify.program = "x"'],
    ['  notify=["x"]'],
    ['notify = [\n  "x",\n]'],
  ])('m1: 사용자 notify 변형 %j 도 감지 — 중복 키를 만들지 않는다', (line) => {
    const r = upsertNotifyBlock(`${line}\nmodel = "x"\n`, PKG_ROOT);
    expect(r.status).toBe('user-defined');
    expect(r.content).toBe(`${line}\nmodel = "x"\n`);
  });

  it('주석 처리된 notify / [tui] notifications 는 사용자 정의가 아니다', () => {
    expect(upsertNotifyBlock('# notify = ["x"]\n[tui]\nnotifications = true\n', PKG_ROOT).status).toBe('installed');
  });

  it('m4: 블록의 notify 줄을 손으로 여러 줄/홑따옴표로 고쳤으면 아무것도 바꾸지 않는다 (체인 유실 방지)', () => {
    const base = upsertNotifyBlock('model = "x"\n', PKG_ROOT).content;
    const multi = base.replace(/^notify = .*$/m, 'notify = [\n  "node", "/p/codex-notify.js",\n  "--", "mine",\n]');
    expect(upsertNotifyBlock(multi, PKG_ROOT)).toEqual({ content: multi, status: 'custom-block' });
    const literal = base.replace(/^notify = .*$/m, "notify = ['node', 'C:\\tools\\n.js', '--', 'mine']");
    expect(upsertNotifyBlock(literal, PKG_ROOT)).toEqual({ content: literal, status: 'custom-block' });
    const commented = base.replace(/^(notify = .*)$/m, '$1 # mine');
    expect(upsertNotifyBlock(commented, PKG_ROOT).status).toBe('custom-block');
  });

  it('m9: --no-notify 는 기존 forgen 블록을 제거한다 (끼어든 root 키는 보존)', () => {
    const r1 = install();
    const withKey = fs.readFileSync(r1.configTomlPath, 'utf-8').replace('# <<< forgen-managed-notify', 'model = "gpt-5.5"\n# <<< forgen-managed-notify');
    fs.writeFileSync(r1.configTomlPath, withKey);
    const r2 = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, registerNotify: false, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    expect(r2.notify).toBe('removed');
    const toml = fs.readFileSync(r2.configTomlPath, 'utf-8');
    expect(toml).not.toContain('forgen-managed-notify');
    expect(toml).not.toMatch(/^notify\s*=/m);
    expect(toml.startsWith('model = "gpt-5.5"\n')).toBe(true);
    expect(toml).toContain('[mcp_servers.forgen-compound]');
    // 블록이 없을 때의 --no-notify 는 no-op
    expect(planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, registerNotify: false, agentsMdPath: path.join(codexHome, 'AGENTS.md') }).notify).toBe('skipped');
    expect(removeNotifyBlock('model = "x"\n')).toEqual({ content: 'model = "x"\n', removed: false, custom: false, restoredChain: [] });
  });

  it('M1: 손으로 여러 줄로 고친 notify 블록은 제거하지 않는다 — 첫 줄만 지우면 Codex 가 기동 못 하는 TOML 이 된다', () => {
    const base = upsertNotifyBlock('model = "x"\n', PKG_ROOT).content;
    const multi = base.replace(/^notify = .*$/m, 'notify = [\n  "node", "/p/dist/host/codex-notify.js",\n  "--", "say", "done",\n]');
    expect(removeNotifyBlock(multi)).toEqual({ content: multi, removed: false, custom: true, restoredChain: [] });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), multi);
    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, registerNotify: false, registerMcp: false, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    expect(r.notify).toBe('custom-block');
    expect(fs.readFileSync(r.configTomlPath, 'utf-8')).toBe(multi);
  });

  it('제거 시 체인돼 있던 사용자 notifier 는 그 argv 만으로 되돌려 놓는다', () => {
    const base = upsertNotifyBlock('model = "x"\n', PKG_ROOT).content;
    const chained = base.replace(/^notify = .*$/m, `notify = ${JSON.stringify(['node', '/p/dist/host/codex-notify.js', '--', 'terminal-notifier', '-title', 'codex'])}`);
    const r = removeNotifyBlock(chained);
    expect(r.removed).toBe(true);
    expect(r.restoredChain).toEqual(['terminal-notifier', '-title', 'codex']);
    expect(r.content).toBe('notify = ["terminal-notifier","-title","codex"]\n\nmodel = "x"\n');
    // 되돌려 놓은 뒤 다시 설치하면 사용자 notify 로 인식해 건드리지 않는다
    expect(upsertNotifyBlock(r.content, PKG_ROOT).status).toBe('user-defined');
  });

  it('BOM/CRLF 파일에서 블록을 제거해도 BOM 은 맨 앞, 줄 끝은 그대로', () => {
    const original = '\uFEFFmodel = "x"\r\n\r\n[features]\r\nmulti_agent = true\r\n';
    const installed = upsertNotifyBlock(original, PKG_ROOT).content;
    expect(removeNotifyBlock(installed).content).toBe(original);
  });
});

describe('훅 소유 판정 (critic 2026-10-02: 부분문자열/임의 dist/hooks 오탐)', () => {
  it.each([
    [`node "${PKG_ROOT}/dist/host/codex-adapter.js" "${PKG_ROOT}/dist/hooks/stop-guard.js"`, true],
    ['node "/old/prefix/dist/host/codex-adapter.js" "/old/prefix/dist/hooks/stop-guard.js"', true], // 다른 경로의 forgen
    ['node "/usr/lib/node_modules/@wooojin/forgen/dist/hooks/stop-guard.js"', true], // adapter 없는 구버전 형태
    ['node /home/me/otherproj/dist/hooks/pre-commit.js', false], // 다른 프로젝트의 dist/hooks
    ['echo "see dist/hooks/readme.js"', false],
    [`${PKG_ROOT}-fork/hook.sh`, false], // pkgRoot 를 접두로 가진 다른 경로
    [`bash ${PKG_ROOT}/my-own-script.sh`, false], // 저장소 체크아웃 안의 사용자 스크립트
    ["if [ -x '/home/u/.orca/hook.sh' ]; then /home/u/.orca/hook.sh; fi", false],
    [undefined, false],
  ])('%j → forgen=%s', (command, expected) => {
    expect(isForgenHookCommand(command, PKG_ROOT)).toBe(expected);
  });
});

describe('Codex 가 마커를 재배치한 config.toml (0.160 실머신 형태, 2026-10-02)', () => {
  // Codex(toml_edit)는 주석을 "다음 테이블의 장식" 으로 취급한다. `/hooks` 승인 후 실제로 관측된 형태:
  // BEGIN 마커는 forgen 테이블과 함께 파일 끝으로 가고, END 마커는 앞쪽 hooks.state 테이블 위에 고아로 남는다.
  const NOTIFY_JS = path.join(PKG_ROOT, 'dist', 'host', 'codex-notify.js');
  const SERVER_JS = path.join(PKG_ROOT, 'dist', 'mcp', 'server.js');
  const rearranged = [
    '# >>> forgen-managed-notify',
    '# forgen turn-complete fallback (ADR-016): works even while forgen hooks are untrusted.',
    '# To chain your own notifier, append:  "--", "<program>", "<args…>"  (kept across re-install).',
    `notify = ${JSON.stringify(['node', NOTIFY_JS])}`,
    '# <<< forgen-managed-notify',
    '',
    'model = "gpt-5.5"',
    '',
    '[features]',
    'multi_agent = true',
    '',
    '[hooks.state]',
    '',
    '[hooks.state."/h/hooks.json:stop:0:0"]',
    'trusted_hash = "sha256:aa"',
    '',
    '# <<< forgen-managed-mcp',
    '',
    '[hooks.state."/h/hooks.json:stop:1:0"]',
    'trusted_hash = "sha256:bb"',
    '',
    '# >>> forgen-managed-mcp',
    '[mcp_servers.forgen-compound]',
    'command = "node"',
    `args = [${JSON.stringify(SERVER_JS)}, "--host=codex"]`,
    '',
  ].join('\n');

  let codexHome: string;
  beforeEach(() => {
    codexHome = tmpDir('codex-rearranged-');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), rearranged);
  });
  afterEach(() => { fs.rmSync(codexHome, { recursive: true, force: true }); });
  const install = (extra: Record<string, unknown> = {}) => planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md'), ...extra });

  it('재설치: 테이블을 중복시키지 않고, 고아 END 를 걷어 마커를 테이블 위아래로 정규화하며, 다른 내용은 그대로 둔다', () => {
    const r = install();
    const toml = fs.readFileSync(r.configTomlPath, 'utf-8');
    expect(toml.match(/^\[mcp_servers\.forgen-compound\]$/gm)).toHaveLength(1);
    expect(toml.match(/forgen-managed-mcp/g)).toHaveLength(2);
    expect(toml.match(/^notify\s*=/gm)).toHaveLength(1);
    expect(toml).toMatch(/# >>> forgen-managed-mcp\n\[mcp_servers\.forgen-compound\]\ncommand = "node"\nargs = .*\n# <<< forgen-managed-mcp\n$/);
    // 사용자/Codex 내용은 순서 그대로
    const strip = (t: string) => t.split('\n').filter((l) => !l.includes('forgen-managed-mcp') && l.trim() !== '').join('\n');
    expect(strip(toml)).toBe(strip(rearranged));
    expect(r.multiAgentEnabled).toBe(true);
    // 정규화된 뒤에는 바이트 동일 (idempotent)
    const again = install();
    expect(again.mcpAlreadyPresent).toBe(true);
    expect(again.notify).toBe('already-present');
    expect(fs.readFileSync(again.configTomlPath, 'utf-8')).toBe(toml);
  });

  it('uninstall: 재배치된 형태에서도 forgen 테이블·notify·마커를 전부 걷어내고 hooks.state 는 남긴다', async () => {
    const { planCodexUninstall } = await import('../../src/host/uninstall-codex.js');
    const r = planCodexUninstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    expect([r.mcpRemoved, r.notifyRemoved]).toEqual([true, true]);
    expect(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf-8')).toBe([
      'model = "gpt-5.5"',
      '',
      '[features]',
      'multi_agent = true',
      '',
      '[hooks.state]',
      '',
      '[hooks.state."/h/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:aa"',
      '',
      '[hooks.state."/h/hooks.json:stop:1:0"]',
      'trusted_hash = "sha256:bb"',
      '',
    ].join('\n'));
  });

  it('notify: END 마커가 사라졌거나 멀리 옮겨져도 forgen 줄을 찾아 갱신/제거한다', () => {
    const noEnd = rearranged.replace('# <<< forgen-managed-notify\n', '');
    const up = upsertNotifyBlock(noEnd.replace(NOTIFY_JS, '/old/dist/host/codex-notify.js'), PKG_ROOT);
    expect(up.status).toBe('installed');
    expect(up.content.match(/^notify\s*=/gm)).toHaveLength(1);
    expect(up.content).toContain(JSON.stringify(['node', NOTIFY_JS]));
    const rm = removeNotifyBlock(noEnd);
    expect(rm.removed).toBe(true);
    expect(rm.content).not.toMatch(/notify\s*=|forgen-managed-notify|forgen turn-complete/);
    expect(rm.content.startsWith('model = "gpt-5.5"\n')).toBe(true);

    // END 가 테이블들 뒤로 옮겨진 경우: 사이의 내용을 재배열하지 않는다
    const farEnd = `${noEnd}\n# <<< forgen-managed-notify\n`;
    const up2 = upsertNotifyBlock(farEnd, PKG_ROOT);
    expect(up2.content.indexOf('model = "gpt-5.5"')).toBeLessThan(up2.content.indexOf('[features]'));
    expect(up2.content.match(/forgen-managed-notify/g)).toHaveLength(2);
    expect(upsertNotifyBlock(up2.content, PKG_ROOT).status).toBe('already-present');
  });

  it('사용자가 forgen 테이블만 지우고 마커가 남은 경우: 고아 마커를 걷어내고 새 블록을 한 번만 쓴다', () => {
    const orphan = rearranged.split('\n').filter((l) => !/^\[mcp_servers\.forgen-compound\]|^command = |^args = /.test(l)).join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), orphan);
    const r = install();
    const toml = fs.readFileSync(r.configTomlPath, 'utf-8');
    expect(r.mcpRegistered).toBe(true);
    expect(toml.match(/forgen-managed-mcp/g)).toHaveLength(2);
    expect(toml.match(/^\[mcp_servers\.forgen-compound\]$/gm)).toHaveLength(1);
    expect(fs.readFileSync(install().configTomlPath, 'utf-8')).toBe(toml);
  });
});
