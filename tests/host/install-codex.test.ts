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

  it('registerMcp:false 면 config.toml 미작성', () => {
    const r = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, registerMcp: false });
    expect(r.mcpRegistered).toBe(false);
    expect(fs.existsSync(r.configTomlPath)).toBe(false);
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

import { adaptSkillBodyForCodex, auditCodexHookTrust, codexHookEventKey, isCodexMultiAgentEnabled, renderCodexAgentToml } from '../../src/host/install-codex.js';

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

  it('D4: auditCodexHookTrust — hooks.state 키 대조 (snake_case event + group/hook index)', () => {
    expect(codexHookEventKey('PreToolUse')).toBe('pre_tool_use');
    expect(codexHookEventKey('PostToolUseFailure')).toBe('post_tool_use_failure');
    const hooksPath = path.join(codexHome, 'hooks.json');
    const cmd = (n: string) => `node "${PKG_ROOT}/dist/host/codex-adapter.js" "${PKG_ROOT}/dist/hooks/${n}.js"`;
    const hooksFile = {
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('pre-tool-use'), timeout: 3 }, { type: 'command', command: cmd('rate-limiter'), timeout: 2 }] }],
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('stop-guard'), timeout: 10 }] }, { matcher: '*', hooks: [{ type: 'command', command: 'bash /home/u/my-hook.sh', timeout: 1 }] }],
        // Claude 전용 이벤트 — Codex 가 무시하므로 total 에서 제외되어야 함 (critic 2026-10-01)
        PostToolUseFailure: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('post-tool-failure'), timeout: 3 }] }],
      },
    };
    const toml = [
      `[hooks.state."${hooksPath}:pre_tool_use:0:0"]`, 'trusted_hash = "sha256:aa"',
      `[hooks.state."${hooksPath}:stop:0:0"]`, 'enabled = true', 'trusted_hash = "sha256:bb"',
      `[hooks.state."${hooksPath}:stop:1:0"]`, 'trusted_hash = "sha256:cc"', // 사용자 훅 — 집계 제외
    ].join('\n');
    const audit = auditCodexHookTrust({ hooksPath, configTomlPath: path.join(codexHome, 'config.toml'), pkgRoot: PKG_ROOT, hooksFile, configToml: toml });
    expect(audit.total).toBe(3);
    expect(audit.trusted).toBe(2);
    expect(audit.untrusted).toEqual(['pre_tool_use:0:1']);
    expect(audit.ignoredByCodex).toEqual(['post_tool_use_failure:0:0']);
    expect(audit.noStateRecorded).toBe(false);

    const none = auditCodexHookTrust({ hooksPath, configTomlPath: path.join(codexHome, 'config.toml'), pkgRoot: PKG_ROOT, hooksFile, configToml: '' });
    expect(none.trusted).toBe(0);
    expect(none.noStateRecorded).toBe(true);
  });

  it('D4: planCodexInstall 결과에 hookTrust 가 포함되고, 신규 홈에서는 전부 untrusted', () => {
    const result = planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'AGENTS.md') });
    // PostToolUseFailure 1건은 Codex 미지원 → total 에서 제외
    expect(result.hookTrust.total + result.hookTrust.ignoredByCodex.length).toBe(result.hooksCount);
    expect(result.hookTrust.ignoredByCodex).toEqual(['post_tool_use_failure:0:0']);
    expect(result.hookTrust.trusted).toBe(0);
    expect(result.hookTrust.noStateRecorded).toBe(true);
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
