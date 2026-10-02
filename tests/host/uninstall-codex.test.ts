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

  it('uninstall → 재설치: 자리표시 그룹을 다시 채워 forgen 훅이 원래 인덱스(= 승인된 trust 키)로 돌아간다', () => {
    const inst = install();
    const hooks = readHooks(inst.hooksPath);
    for (const ev of ['UserPromptSubmit', 'Stop', 'PreToolUse']) hooks.hooks[ev].push(userGroup() as G);
    fs.writeFileSync(inst.hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
    // 사용자가 forgen 훅 + 다른 도구 훅을 전부 승인해 둔 상태
    const state: string[] = [];
    for (const [ev, groups] of Object.entries(hooks.hooks)) {
      groups.forEach((g, gi) => g.hooks.forEach((h, hi) => state.push(`[hooks.state."${inst.hooksPath}:${codexHookEventKey(ev)}:${gi}:${hi}"]`, `trusted_hash = "${codexHookTrustHash(ev, g.matcher, h)}"`, '')));
    }
    fs.appendFileSync(inst.configTomlPath, `\n${state.join('\n')}`);
    const before = fs.readFileSync(inst.hooksPath, 'utf-8');

    uninstall();
    const again = install();
    // 이벤트별 그룹 배열이 uninstall 전과 같다 (자리표시가 남지 않고, 인덱스가 그대로). 이벤트 키 순서는
    // 달라질 수 있지만 Codex trust 키에는 영향이 없다.
    expect(readHooks(again.hooksPath).hooks).toEqual(JSON.parse(before).hooks);
    expect(again.preservedUserHookCount).toBe(3); // 자리표시를 사용자 훅으로 세지 않는다
    expect(again.hookTrust.trusted).toBe(again.hookTrust.total); // 재승인 없이 전부 trusted
  });

  it('섞인 배치(user, forgen, user, forgen)에서도 사용자 그룹 인덱스를 지킨다', () => {
    const f = (n: string) => ({ matcher: '*', hooks: [{ type: 'command', command: ADAPTER(n) }] });
    const u = (n: string) => ({ hooks: [{ type: 'command', command: `echo ${n}` }] });
    const r = stripForgenHooks({ hooks: { Stop: [u('a'), f('context-guard'), u('b'), f('stop-guard')] } }, PKG_ROOT);
    expect(r.next?.hooks.Stop).toEqual([u('a'), { hooks: [] }, u('b')]);
    expect(r.placeholders).toBe(1);
  });

  it('소유 판정 오탐 방지: 다른 프로젝트의 dist/hooks 스크립트나 pkgRoot 접두 경로는 지우지 않는다', () => {
    const foreign = [
      { hooks: [{ type: 'command', command: 'node /home/me/otherproj/dist/hooks/pre-commit.js' }] },
      { hooks: [{ type: 'command', command: `${PKG_ROOT}-fork/hook.sh` }] },
    ];
    const r = stripForgenHooks({ hooks: { PreToolUse: foreign } }, PKG_ROOT);
    expect(r.removed).toBe(0);
    expect(r.next?.hooks.PreToolUse).toEqual(foreign);
  });

  it('사용자 파일 보호: 본문에 `---` + 마커를 인용한 스킬, forgen-<stack>-* 이름의 사용자 스킬, 마커 접두만 같은 에이전트', () => {
    const inst = install();
    const quoting = path.join(inst.skillsPath, 'my-notes');
    fs.mkdirSync(quoting);
    const quotingBody = '---\nname: my-notes\ndescription: x\n---\n\nHow forgen marks files:\n\n---\n<!-- forgen-managed -->\n';
    fs.writeFileSync(path.join(quoting, 'SKILL.md'), quotingBody);
    const mine = path.join(inst.skillsPath, 'forgen-react-mine');
    fs.mkdirSync(mine);
    fs.writeFileSync(path.join(mine, 'SKILL.md'), '---\nname: forgen-react-mine\ndescription: mine\n---\nmine');
    fs.writeFileSync(path.join(inst.agentsPath, 'ch-custom.toml'), '# forgen-managed-by-me\nname = "ch-custom"\n');

    const r = uninstall();
    expect(fs.readdirSync(inst.skillsPath).sort()).toEqual(['forgen-react-mine', 'my-notes']);
    expect(fs.readFileSync(path.join(quoting, 'SKILL.md'), 'utf-8')).toBe(quotingBody);
    expect(fs.readdirSync(inst.agentsPath)).toEqual(['ch-custom.toml']);
    expect(r.skillsRemoved).toBe(inst.skillsInstalled + inst.devGuideSkillsInstalled);
    expect(uninstall().skillsRemoved).toBe(0); // 두 번째 실행에서 다시 세지 않는다
  });

  it('손편집된 notify 블록은 남기고 알린다, 체인된 notifier 는 되돌려 놓는다', () => {
    const inst = install();
    const toml = fs.readFileSync(inst.configTomlPath, 'utf-8');
    const multi = toml.replace(/^notify = .*$/m, 'notify = [\n  "node", "/p/dist/host/codex-notify.js",\n  "--", "say", "done",\n]');
    fs.writeFileSync(inst.configTomlPath, multi);
    const r1 = uninstall();
    expect([r1.notifyRemoved, r1.notifyCustomLeft, r1.mcpRemoved]).toEqual([false, true, true]);
    const left = fs.readFileSync(inst.configTomlPath, 'utf-8');
    expect(left).toContain('"--", "say", "done",'); // 배열이 온전히 남아 TOML 이 깨지지 않는다
    expect(left).toContain('# >>> forgen-managed-notify');
    expect(renderCodexUninstall(r1).join('\n')).toMatch(/hand-edited/);

    fs.writeFileSync(inst.configTomlPath, toml.replace(/^notify = .*$/m, 'notify = ["node","/p/dist/host/codex-notify.js","--","say","done"]'));
    const r2 = uninstall();
    expect(r2.notifyChainRestored).toEqual(['say', 'done']);
    expect(fs.readFileSync(inst.configTomlPath, 'utf-8')).toBe('notify = ["say","done"]\n');
  });

  it('MCP 블록: 배열 테이블 하위(`[[mcp_servers.forgen-compound.x]]`)도 함께 지우고, 이름만 비슷한 서버는 남긴다', () => {
    const inst = install();
    const toml = fs.readFileSync(inst.configTomlPath, 'utf-8').replace(
      '# <<< forgen-managed-mcp',
      '\n[[mcp_servers.forgen-compound.things]]\nx = 1\n\n[mcp_servers.forgen-compound-2]\ncommand = "other"\n# <<< forgen-managed-mcp',
    );
    fs.writeFileSync(inst.configTomlPath, toml);
    uninstall();
    expect(fs.readFileSync(inst.configTomlPath, 'utf-8')).toBe('[mcp_servers.forgen-compound-2]\ncommand = "other"\n');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('한 단계가 실패해도 나머지 정리는 계속하고 실패를 보고한다', () => {
    const inst = install();
    fs.chmodSync(inst.hooksPath, 0o444);
    fs.chmodSync(codexHome, 0o555); // hooks.json 삭제 불가
    let r;
    try { r = uninstall(); } finally { fs.chmodSync(codexHome, 0o755); }
    expect(r.errors.some((e) => e.startsWith('hooks.json:'))).toBe(true);
    expect(r.agentsRemoved).toBe(inst.agentsInstalled); // 뒤 단계는 진행됨
    expect(r.skillsRemoved).toBeGreaterThan(0);
    expect(renderCodexUninstall(r).join('\n')).toMatch(/✗ Codex cleanup — hooks\.json/);
  });

  it('hooks.json 이 JSON 이 아니면 건드리지 않고 알린다', () => {
    const inst = install();
    fs.writeFileSync(inst.hooksPath, '{ not json');
    const r = uninstall();
    expect(r.errors[0]).toMatch(/^hooks\.json: not valid JSON/);
    expect(fs.readFileSync(inst.hooksPath, 'utf-8')).toBe('{ not json');
    expect(r.mcpRemoved).toBe(true);
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

describe('ADR-016 0.5.9: install 이 사용자 스킬을 보존하고, AGENTS.md 설치 위치를 기억한다', () => {
  it('install codex 는 사용자가 만든 forgen-<stack>-* 스킬을 지우지 않는다', () => {
    const inst = install();
    const mine = path.join(inst.skillsPath, 'forgen-react-mine');
    fs.mkdirSync(mine);
    fs.writeFileSync(path.join(mine, 'SKILL.md'), '---\nname: forgen-react-mine\ndescription: mine\n---\nmine');
    fs.mkdirSync(path.join(inst.skillsPath, 'forgen-go-gone'));
    fs.symlinkSync('/old/forgen/assets/dev-guide/be/skills/go/gone/SKILL.md', path.join(inst.skillsPath, 'forgen-go-gone', 'SKILL.md'));
    const again = install();
    expect(fs.readFileSync(path.join(mine, 'SKILL.md'), 'utf-8')).toContain('mine');
    expect(fs.existsSync(path.join(inst.skillsPath, 'forgen-go-gone'))).toBe(false);
    expect(again.devGuideSkillsRemoved).toBe(again.devGuideSkillsInstalled + 1);
  });

  it('여러 프로젝트에서 install 한 AGENTS.md 블록을 uninstall 한 번으로 전부 걷어낸다', () => {
    const projA = path.join(codexHome, 'projA', 'AGENTS.md');
    const projB = path.join(codexHome, 'projB', 'AGENTS.md');
    fs.mkdirSync(path.dirname(projA));
    fs.mkdirSync(path.dirname(projB));
    fs.writeFileSync(projB, '# Project B\n\nKeep me.\n');
    planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: projA });
    planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: projB });
    planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: projB }); // 재설치는 중복 기록하지 않는다
    const registry = path.join(codexHome, 'forgen-agents-md.json');
    expect((JSON.parse(fs.readFileSync(registry, 'utf-8')) as { paths: string[] }).paths).toEqual([projA, projB]);

    // 다른 디렉토리(= agentsMd 가 가리키는 cwd 에는 블록이 없음)에서 uninstall
    const r = planCodexUninstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: path.join(codexHome, 'elsewhere', 'AGENTS.md') });
    expect(r.agentsMdCleanedPaths.sort()).toEqual([projA, projB]);
    expect(fs.existsSync(projA)).toBe(false); // 블록뿐이던 파일
    expect(fs.readFileSync(projB, 'utf-8')).toBe('# Project B\n\nKeep me.\n');
    expect(fs.existsSync(registry)).toBe(false);
    expect(renderCodexUninstall(r).join('\n')).toMatch(/2 AGENTS\.md file\(s\)/);
  });

  it('기록된 프로젝트가 사라졌거나 블록이 이미 없어도 문제없다; dry-run 은 기록을 지우지 않는다', () => {
    const gone = path.join(codexHome, 'gone', 'AGENTS.md');
    fs.mkdirSync(path.dirname(gone));
    planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: gone });
    fs.rmSync(path.dirname(gone), { recursive: true, force: true });
    const dry = planCodexUninstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: agentsMd, dryRun: true });
    expect(dry.agentsMdCleanedPaths).toEqual([]);
    expect(fs.existsSync(path.join(codexHome, 'forgen-agents-md.json'))).toBe(true);
    const r = planCodexUninstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: agentsMd });
    expect(r.errors).toEqual([]);
    expect(fs.existsSync(path.join(codexHome, 'forgen-agents-md.json'))).toBe(false);
  });
});

describe('0.5.9 critic: 심링크 관통 금지 · AGENTS.md 쓰기 실패 보고 · 인용된 마커', () => {
  it('install codex 는 심링크된 dev-guide 스킬 디렉토리 안의 사용자 파일을 덮어쓰지 않는다', () => {
    const inst = install();
    const name = fs.readdirSync(inst.skillsPath).find((n) => /^forgen-(react|vue|node|go)-/.test(n)) as string;
    const dotfiles = path.join(codexHome, 'dotfiles-skill');
    fs.mkdirSync(dotfiles);
    fs.writeFileSync(path.join(dotfiles, 'SKILL.md'), 'dotfiles user skill');
    fs.unlinkSync(path.join(inst.skillsPath, name, 'SKILL.md'));
    fs.rmdirSync(path.join(inst.skillsPath, name));
    fs.symlinkSync(dotfiles, path.join(inst.skillsPath, name), 'dir');
    const again = install();
    expect(fs.readFileSync(path.join(dotfiles, 'SKILL.md'), 'utf-8')).toBe('dotfiles user skill');
    expect(again.devGuideSkillsInstalled).toBe(inst.devGuideSkillsInstalled - 1);
    // uninstall 도 심링크 디렉토리는 건드리지 않는다
    uninstall();
    expect(fs.readFileSync(path.join(dotfiles, 'SKILL.md'), 'utf-8')).toBe('dotfiles user skill');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('쓰지 못한 AGENTS.md 는 오류로 보고하고 기록에 남긴다 (다음 uninstall 이 다시 시도)', () => {
    const ro = path.join(codexHome, 'ro', 'AGENTS.md');
    const ok = path.join(codexHome, 'ok', 'AGENTS.md');
    fs.mkdirSync(path.dirname(ro));
    fs.mkdirSync(path.dirname(ok));
    fs.writeFileSync(ro, '# keep\n');
    planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: ro });
    planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: ok });
    fs.chmodSync(ro, 0o444);
    let r;
    try { r = planCodexUninstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: ok }); } finally { fs.chmodSync(ro, 0o644); }
    expect(r.agentsMdCleanedPaths).toEqual([ok]);
    expect(r.errors.some((e) => e.startsWith(`AGENTS.md ${ro}:`))).toBe(true);
    const registry = path.join(codexHome, 'forgen-agents-md.json');
    expect((JSON.parse(fs.readFileSync(registry, 'utf-8')) as { paths: string[] }).paths).toEqual([ro]);
    // 권한을 고친 뒤 다시 실행하면 정리되고 기록도 사라진다
    const again = planCodexUninstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: ok });
    expect(again.agentsMdCleanedPaths).toEqual([ro]);
    expect(fs.readFileSync(ro, 'utf-8')).toBe('# keep\n');
    expect(fs.existsSync(registry)).toBe(false);
  });

  it('본문에 마커 문자열을 인용한 줄은 블록 경계가 아니다 — 그 사이의 글을 지우지 않는다; 블록이 둘이면 둘 다 제거', () => {
    const md = path.join(codexHome, 'doc', 'AGENTS.md');
    fs.mkdirSync(path.dirname(md));
    const prose = 'doc: `<!-- >>> forgen-managed-rules -->` is the marker forgen uses.\n\nImportant user text.\n';
    fs.writeFileSync(md, prose);
    planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: md });
    const once = fs.readFileSync(md, 'utf-8');
    expect(once.startsWith(prose.trimEnd())).toBe(true); // 설치가 인용 줄부터 덮어쓰지 않는다
    // 재설치는 idempotent, 중복 블록을 만들지 않는다
    planCodexInstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: md });
    expect(fs.readFileSync(md, 'utf-8')).toBe(once);
    // 사용자가 블록을 복사해 둘이 된 경우
    const block = once.slice(once.indexOf('\n<!-- >>> forgen-managed-rules -->') + 1);
    fs.writeFileSync(md, `${once}\nmiddle text\n\n${block}`);
    planCodexUninstall({ pkgRoot: PKG_ROOT, codexHome, agentsMdPath: md });
    expect(fs.readFileSync(md, 'utf-8')).toBe(`${prose}\nmiddle text\n`);
  });
});
