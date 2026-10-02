/**
 * ADR-016 D4 — Codex uninstall: install 이 쓴 것만 되돌리고, 다른 도구의 훅과 그 Codex 신뢰는 보존한다.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditCodexHookTrust, codexHookEventKey, codexHookTrustHash, planCodexInstall, removeMcpBlock } from '../../src/host/install-codex.js';
import { planCodexUninstall, renderCodexUninstall, stripForgenHooks } from '../../src/host/uninstall-codex.js';

const PKG_ROOT = process.cwd();
const ADAPTER = (n: string) => `node "${PKG_ROOT}/dist/host/codex-adapter.js" "${PKG_ROOT}/dist/hooks/${n}.js"`;
const USER_CMD = "if [ -x '/home/u/.orca/hook.sh' ]; then /home/u/.orca/hook.sh; fi";
const userGroup = () => ({ hooks: [{ type: 'command', command: USER_CMD, timeout: 10 }] });

type G = { matcher?: string; hooks: Array<Record<string, unknown>> };
const readHooks = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8')) as { description?: string; hooks: Record<string, G[]> };

let codexHome: string;
let agentsMd: string;
beforeEach(() => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-uninstall-'));
  agentsMd = path.join(codexHome, 'AGENTS.md');
});
afterEach(() => { fs.rmSync(codexHome, { recursive: true, force: true }); });

const install = () => planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: agentsMd });
const uninstall = (dryRun = false) => planCodexUninstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: agentsMd, dryRun });

describe('stripForgenHooks (순수)', () => {
  it('forgen 전용 그룹 뒤에 사용자 그룹이 있으면 빈 그룹으로 자리를 지킨다, 없으면 제거한다', () => {
    const file = {
      description: 'forgen Codex hooks (managed; user-authored entries preserved)',
      hooks: {
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: ADAPTER('context-guard') }, { type: 'command', command: ADAPTER('stop-guard') }] }, userGroup()],
        PreCompact: [{ matcher: '*', hooks: [{ type: 'command', command: ADAPTER('pre-compact') }] }],
        PreToolUse: [userGroup(), { matcher: 'Bash', hooks: [{ type: 'command', command: ADAPTER('db-guard') }] }],
      },
    };
    const r = stripForgenHooks(file, PKG_ROOT);
    expect(r.removed).toBe(4);
    expect(r.preserved).toBe(2);
    expect(r.placeholders).toBe(1);
    expect(r.reindexed).toEqual([]);
    expect(r.next?.hooks.Stop).toEqual([{ hooks: [] }, userGroup()]); // 사용자 그룹은 여전히 index 1
    expect(r.next?.hooks.PreCompact).toBeUndefined(); // forgen 뿐이던 이벤트는 사라짐
    expect(r.next?.hooks.PreToolUse).toEqual([userGroup()]); // 뒤쪽 forgen 그룹은 자리표시 없이 제거
    expect(r.next?.description).toBeUndefined(); // forgen 이 쓴 description 은 걷어냄
  });

  it('한 그룹에 섞여 있으면 forgen 핸들러만 빼고, 인덱스가 바뀐 사용자 훅을 보고한다', () => {
    const mine = { type: 'command', command: 'echo mine' };
    const file = { hooks: { Stop: [{ hooks: [{ type: 'command', command: ADAPTER('stop-guard') }, mine] }] } };
    const r = stripForgenHooks(file, PKG_ROOT);
    expect(r.next?.hooks.Stop).toEqual([{ hooks: [mine] }]);
    expect(r.reindexed).toEqual(['stop:0:1→0']);
  });

  it('forgen 훅이 없으면 아무것도 바꾸지 않는다 / 전부 forgen 이면 next=null (파일 삭제 대상)', () => {
    const user = { description: 'my hooks', hooks: { Stop: [userGroup()] } };
    const r1 = stripForgenHooks(user, PKG_ROOT);
    expect(r1.removed).toBe(0);
    expect(r1.next).toEqual(user);
    const only = { description: 'forgen Codex hooks (managed; user-authored entries preserved)', hooks: { Stop: [{ hooks: [{ type: 'command', command: ADAPTER('stop-guard') }] }] } };
    expect(stripForgenHooks(only, PKG_ROOT).next).toBeNull();
    // 사용자 description 이 있으면 파일은 남긴다
    expect(stripForgenHooks({ ...only, description: 'mine' }, PKG_ROOT).next).toEqual({ description: 'mine', hooks: {} });
  });

  it('다른 경로에 설치된 forgen(스크립트 시그니처)도 forgen 으로 본다', () => {
    const stale = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/old/prefix/dist/host/codex-adapter.js" "/old/prefix/dist/hooks/stop-guard.js"' }] }] } };
    expect(stripForgenHooks(stale, PKG_ROOT).removed).toBe(1);
  });
});

describe('planCodexUninstall', () => {
  it('신규 설치 → uninstall: forgen 이 만든 것이 전부 사라진다', () => {
    const inst = install();
    expect(fs.existsSync(inst.hooksPath)).toBe(true);
    const r = uninstall();
    expect(r.present).toBe(true);
    expect(r.hooksRemoved).toBe(inst.hooksCount);
    expect(r.hooksFileDeleted).toBe(true);
    expect(fs.existsSync(inst.hooksPath)).toBe(false);
    expect(r.mcpRemoved).toBe(true);
    expect(r.notifyRemoved).toBe(true);
    expect(fs.readFileSync(inst.configTomlPath, 'utf-8').trim()).toBe('');
    expect(r.skillsRemoved).toBe(inst.skillsInstalled + inst.devGuideSkillsInstalled);
    expect(fs.readdirSync(inst.skillsPath)).toEqual([]);
    expect(r.agentsRemoved).toBe(inst.agentsInstalled);
    expect(fs.readdirSync(inst.agentsPath)).toEqual([]);
    expect(r.agentsMdCleaned).toBe(true);
    expect(fs.existsSync(agentsMd)).toBe(false); // 블록뿐이던 파일은 삭제
    // 두 번째 실행은 no-op
    const again = uninstall();
    expect([again.hooksRemoved, again.skillsRemoved, again.agentsRemoved]).toEqual([0, 0, 0]);
    expect([again.mcpRemoved, again.notifyRemoved, again.agentsMdCleaned]).toEqual([false, false, false]);
    expect(renderCodexUninstall(again)).toEqual([]);
  });

  it('다른 도구의 훅과 그 Codex 신뢰(인덱스)를 보존한다', () => {
    const inst = install();
    const hooks = readHooks(inst.hooksPath);
    // orca 같은 도구가 각 이벤트 뒤에 그룹을 append 한 실제 형태 + 사용자가 /hooks 로 승인
    for (const ev of ['UserPromptSubmit', 'Stop', 'PreToolUse']) hooks.hooks[ev].push(userGroup() as G);
    fs.writeFileSync(inst.hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
    const userKeys = ['UserPromptSubmit', 'Stop', 'PreToolUse'].map((ev) => `${inst.hooksPath}:${codexHookEventKey(ev)}:${hooks.hooks[ev].length - 1}:0`);
    const state = userKeys.map((k, i) => `[hooks.state."${k}"]\ntrusted_hash = "${codexHookTrustHash(['UserPromptSubmit', 'Stop', 'PreToolUse'][i], undefined, userGroup().hooks[0])}"\n`).join('\n');
    fs.appendFileSync(inst.configTomlPath, `\n${state}`);

    const r = uninstall();
    expect(r.userHooksPreserved).toBe(3);
    expect(r.hooksFileDeleted).toBe(false);
    expect(r.userHooksReindexed).toEqual([]);
    const after = readHooks(inst.hooksPath);
    expect(Object.keys(after.hooks).sort()).toEqual(['PreToolUse', 'Stop', 'UserPromptSubmit']);
    // 사용자 그룹은 uninstall 전과 같은 인덱스에 있다 → 기록된 trust 키가 그대로 맞는다
    for (const [i, ev] of ['UserPromptSubmit', 'Stop', 'PreToolUse'].entries()) {
      const idx = Number(userKeys[i].split(':').slice(-2)[0]);
      expect(after.hooks[ev][idx]).toEqual(userGroup());
      expect(after.hooks[ev].slice(0, idx).every((g) => g.hooks.length === 0)).toBe(true);
    }
    expect(r.placeholderGroups).toBe(after.hooks.UserPromptSubmit.length + after.hooks.Stop.length + after.hooks.PreToolUse.length - 3);
    expect(JSON.stringify(after)).not.toContain('codex-adapter');
    // forgen 은 hooks.state 를 건드리지 않는다
    const toml = fs.readFileSync(inst.configTomlPath, 'utf-8');
    for (const k of userKeys) expect(toml).toContain(`[hooks.state."${k}"]`);
    expect(toml).not.toContain('forgen-managed');
    expect(renderCodexUninstall(r).join('\n')).toMatch(/kept 3 hook\(s\) from other tools/);
  });

  it('config.toml: 사용자 설정과 Codex 가 블록 안에 써 넣은 내용은 남는다', () => {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.5"\n\n[features]\nmulti_agent = true\n');
    const inst = install();
    // Codex 가 승인 기록을 MCP 블록 END 마커 앞에 써 넣은 형태 (재설치 전이라 아직 블록 안)
    const toml = fs.readFileSync(inst.configTomlPath, 'utf-8').replace(
      '# <<< forgen-managed-mcp',
      'enabled = false\n\n[mcp_servers.forgen-compound.tools.compound-search]\napproval_mode = "approve"\n\n[hooks.state."/x/hooks.json:stop:1:0"]\ntrusted_hash = "sha256:aa"\n# <<< forgen-managed-mcp',
    );
    fs.writeFileSync(inst.configTomlPath, toml);
    uninstall();
    const after = fs.readFileSync(inst.configTomlPath, 'utf-8');
    expect(after).toBe('model = "gpt-5.5"\n\n[features]\nmulti_agent = true\n\n[hooks.state."/x/hooks.json:stop:1:0"]\ntrusted_hash = "sha256:aa"\n');
  });

  it('마커 없는 사용자 관리 MCP 테이블 / 사용자 notify 는 건드리지 않는다', () => {
    const user = 'notify = ["mine"]\n\n[mcp_servers.forgen-compound]\ncommand = "node"\nargs = ["/mine.js"]\n';
    fs.writeFileSync(path.join(codexHome, 'config.toml'), user);
    const r = uninstall();
    expect([r.mcpRemoved, r.notifyRemoved]).toEqual([false, false]);
    expect(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf-8')).toBe(user);
    expect(removeMcpBlock(user)).toEqual({ content: user, removed: false });
  });

  it('사용자가 만든 스킬/에이전트/AGENTS.md 내용은 보존', () => {
    const inst = install();
    const mySkill = path.join(inst.skillsPath, 'my-skill');
    fs.mkdirSync(mySkill);
    fs.writeFileSync(path.join(mySkill, 'SKILL.md'), '---\nname: my-skill\ndescription: x\n---\nmine');
    // forgen 스킬 이름을 사용자가 직접 다시 쓴 경우 (마커 없음)
    fs.writeFileSync(path.join(inst.skillsPath, 'compound', 'SKILL.md'), '---\nname: compound\ndescription: USER\n---\n\nUSER edited');
    fs.writeFileSync(path.join(inst.agentsPath, 'ch-mine.toml'), 'name = "ch-mine"\n');
    fs.writeFileSync(path.join(inst.agentsPath, 'reviewer.toml'), 'name = "reviewer"\n');
    fs.writeFileSync(agentsMd, `# My project\n\nBe nice.\n\n${fs.readFileSync(agentsMd, 'utf-8')}`);

    const r = uninstall();
    expect(fs.readdirSync(inst.skillsPath).sort()).toEqual(['compound', 'my-skill']);
    expect(fs.readFileSync(path.join(inst.skillsPath, 'compound', 'SKILL.md'), 'utf-8')).toContain('USER edited');
    expect(fs.readdirSync(inst.agentsPath).sort()).toEqual(['ch-mine.toml', 'reviewer.toml']);
    expect(r.agentsRemoved).toBe(inst.agentsInstalled);
    expect(fs.readFileSync(agentsMd, 'utf-8')).toBe('# My project\n\nBe nice.\n');
  });

  it('dry-run 은 아무것도 쓰지 않고 같은 수치를 보고한다', () => {
    const inst = install();
    const snapshot = [inst.hooksPath, inst.configTomlPath, agentsMd].map((p) => fs.readFileSync(p, 'utf-8'));
    const r = uninstall(true);
    expect(r.hooksRemoved).toBe(inst.hooksCount);
    expect(r.mcpRemoved && r.notifyRemoved && r.agentsMdCleaned).toBe(true);
    expect(r.skillsRemoved).toBe(inst.skillsInstalled + inst.devGuideSkillsInstalled);
    expect([inst.hooksPath, inst.configTomlPath, agentsMd].map((p) => fs.readFileSync(p, 'utf-8'))).toEqual(snapshot);
    expect(fs.readdirSync(inst.agentsPath).length).toBe(inst.agentsInstalled);
  });

  it('Codex 를 쓰지 않으면(CODEX_HOME 없음) no-op', () => {
    const r = planCodexUninstall({ pkgRoot: PKG_ROOT, codexHome: path.join(codexHome, 'nope'), agentsMdPath: path.join(codexHome, 'nope.md') });
    expect(r.present).toBe(false);
    expect(renderCodexUninstall(r)).toEqual([]);
  });

  it('install → uninstall → install 왕복 후 감사 결과가 신규 설치와 같다', () => {
    install();
    uninstall();
    const again = install();
    expect(again.hookTrust.total).toBe(again.hooksCount);
    const audit = auditCodexHookTrust({ hooksPath: again.hooksPath, configTomlPath: again.configTomlPath, pkgRoot: PKG_ROOT });
    expect(audit.untrusted.length).toBe(audit.total);
    expect(fs.readFileSync(again.configTomlPath, 'utf-8').match(/forgen-managed-mcp/g)).toHaveLength(2);
  });
});
