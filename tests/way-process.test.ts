/**
 * Way 컴파일러·CLI 프로세스 검증. 빌드된 CLI 를 격리 HOME/FORGEN_HOME 에서 실제로 실행한다. 대역 없음.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DIST = path.resolve(__dirname, '..', 'dist');
let root: string, home: string, forgen: string, work: string;
const env = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, FORGEN_HOME: forgen, CODEX_HOME: path.join(home, '.codex'), FORGEN_SYNTHETIC: '1', FORGEN_CWD: work, FORGEN_DISABLE_PROJECT_RULES: '1', FORGEN_NO_BLOCK_JUDGE: '1' });
const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(DIST, 'cli.js'), ...args], { encoding: 'utf-8', cwd: work, env: env(), timeout: 90_000 });
const way = () => JSON.parse(cli('way', '--json').stdout) as { items: any[]; stats: any };
const ruleFile = (id: string) => path.join(forgen, 'me', 'rules', `${id}.json`);
const readRule = (id: string) => JSON.parse(fs.readFileSync(ruleFile(id), 'utf-8'));

function writeRule(id: string, policy: string, o: Record<string, unknown> = {}) {
  const now = '2026-10-01T00:00:00.000Z';
  fs.writeFileSync(ruleFile(id), JSON.stringify({
    rule_id: id, category: 'workflow', scope: 'me', trigger: '작업을 시작하기 전 확인할 때', policy, strength: 'default', source: 'explicit_correction', status: 'active',
    evidence_refs: [], render_key: `workflow.${id}`, created_at: now, updated_at: now, ...o,
  }));
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-way-'));
  home = path.join(root, 'home'); forgen = path.join(home, '.forgen'); work = path.join(root, 'work');
  fs.mkdirSync(path.join(forgen, 'me', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(forgen, 'me', 'behavior'), { recursive: true });
  fs.mkdirSync(path.join(forgen, 'me', 'solutions'), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(forgen, 'forge-profile.json'), '{}');
  // evidence: 사용자 발화 원문
  fs.writeFileSync(path.join(forgen, 'me', 'behavior', 'ev-1.json'), JSON.stringify({
    evidence_id: 'ev-1', type: 'explicit_correction', session_id: 's', timestamp: '2026-10-06T00:00:00.000Z', source_component: 'test', summary: 'x', axis_refs: [], candidate_rule_refs: [], confidence: 0.9,
    raw_payload: { kind: 'avoid-this', user_quote: 'secretmarker 는 절대 로그에 찍지 마' },
  }));
  writeRule('r-global-strong', '비밀값은 로그에 출력하지 말 것', { strength: 'strong', evidence_refs: ['ev-1'], enforce_via: [{ mech: 'A', hook: 'PreToolUse', verifier: { kind: 'tool_arg_regex', params: { pattern: 'echo .*SECRET' } } }] });
  writeRule('r-global-soft', '커밋 메시지는 짧게 쓴다', { strength: 'soft' });
  writeRule('r-proj', '앱 화면 문구는 짧게', { strength: 'strong', projects: ['alpha-app'] });
  writeRule('r-mined', '테스트를 먼저 돌려 본다', { source: 'behavior_inference', category: 'quality', strength: 'default' });
  writeRule('r-off', '꺼진 룰', { status: 'suppressed' });
  const sol = (name: string, status: string, content: string) => fs.writeFileSync(path.join(forgen, 'me', 'solutions', `${name}.md`), ['---', `name: ${name}`, 'version: 1', `status: ${status}`, 'confidence: 0.8', 'type: pattern', 'scope: me', 'tags:', '  - "docker"', '  - "build"', 'identifiers: []', 'evidence:', '  injected: 0', '  reflected: 0', '  negative: 0', '  sessions: 0', '  reExtracted: 0', 'created: 2026-10-01', 'updated: 2026-10-01', 'supersedes: null', 'extractedBy: manual', '---', '', '## Context', '도커 빌드가 캐시 때문에 옛 파일을 쓸 때', '', '## Content', content, ''].join('\n'));
  sol('docker-cache-bust', 'verified', '1. --no-cache 로 한 번 빌드한다.\n2. 원인이 된 COPY 순서를 고친다.');
  sol('empty-one', 'verified', '');
  sol('still-candidate', 'candidate', '아직 검증 안 된 내용이다. 충분히 길다.');
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('Way 추출', () => {
  it('발화 원문과 채굴 추론을 구분하고, 호스트 전용 필드는 노출하지 않는다', () => {
    const w = way();
    const strong = w.items.find((i) => i.id === 'r-global-strong');
    expect(strong.provenance).toMatchObject({ kind: 'you-said', quote: 'secretmarker 는 절대 로그에 찍지 마', date: '2026-10-06' });
    expect(strong.enforceable).toBe(true);
    expect(w.items.find((i) => i.id === 'r-mined').provenance.kind).toBe('mined');
    expect(w.items.find((i) => i.id === 'r-off')).toBeUndefined();
    const raw = JSON.stringify(w);
    expect(raw).not.toMatch(/enforce_via|PreToolUse|hook/);
    expect(w.stats).toMatchObject({ rules_active: 4, rules_you_said: 3, rules_mined: 1, rules_enforceable: 1, solutions_verified: 1, solutions_unverified: 1 });
  });
  it('사람이 읽는 요약에 구분이 나온다', () => {
    const out = cli('way').stdout;
    expect(out).toContain('내가 말한 규칙 3');
    expect(out).toContain('추론된 규칙 1');
    expect(out).toContain('강제 중 1 / 자문 3');
    expect(out).toContain('[alpha-app]');
  });
});

describe('export', () => {
  it('--out 없이는 파일을 쓰지 않는다 (cwd 포함)', () => {
    const r = cli('way', 'export', '--target', 'agents-md');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('===== AGENTS.md =====');
    expect(fs.readdirSync(work)).toEqual([]);
  });
  it('프로젝트 필터: 없으면 전역만, 있으면 전역 + 그 프로젝트', () => {
    const g = cli('way', 'export', '--target', 'system-prompt');
    expect(g.stdout).not.toContain('앱 화면 문구는 짧게');
    expect(g.stderr).toContain('project-scope 1');
    const p = cli('way', 'export', '--target', 'system-prompt', '--project', 'alpha-app');
    expect(p.stdout).toContain('앱 화면 문구는 짧게');
    expect(cli('way', 'export', '--target', 'system-prompt', '--project', 'other').stdout).not.toContain('앱 화면 문구는 짧게');
  });
  it('예산 초과: 자르지 않고 우선순위로 고르고 빠진 것을 보고한다', () => {
    const full = cli('way', 'export', '--target', 'agents-md', '--project', 'alpha-app').stdout;
    const budget = full.length - 30;
    const r = cli('way', 'export', '--target', 'agents-md', '--project', 'alpha-app', '--budget', String(budget));
    expect(r.stderr).toContain('예산으로 뺌');
    expect(r.stdout).toContain('비밀값은 로그에 출력하지 말 것'); // strong + 발화: 남는다
    expect(r.stdout).not.toContain('커밋 메시지는 짧게 쓴다'); // soft: 먼저 빠진다
    for (const l of r.stdout.split('\n').filter((x) => x.startsWith('- '))) expect(l.length).toBeGreaterThan(10); // 줄 중간에서 잘리지 않았다
    const lines = full.split('\n').filter((x) => x.startsWith('- '));
    for (const l of r.stdout.split('\n').filter((x) => x.startsWith('- '))) expect(lines).toContain(l);
  });
  it('강제 가능한 룰은 degraded 로 "자문으로 전환" 이 보고되고 json 에는 없다', () => {
    expect(cli('way', 'export', '--target', 'claude-rules').stderr).toContain('자문으로 전환');
    expect(cli('way', 'export', '--target', 'json').stderr).toContain('자문 전환 0개');
  });
  it('검증 안 된 솔루션과 빈 솔루션은 내보내지 않는다. 습관은 --habits 일 때만', () => {
    const out = cli('way', 'export', '--target', 'agents-md').stdout;
    expect(out).toContain('--no-cache');
    expect(out).not.toContain('아직 검증 안 된');
  });
  it('모든 대상이 파일 경로와 표식을 낸다', () => {
    const paths: Record<string, string> = { 'agents-md': 'AGENTS.md', 'claude-rules': '.claude/rules/forgen-way.md', gemini: 'GEMINI.md', 'system-prompt': 'system-prompt.txt', workflow: 'forgen-way-checklist.md', json: 'forgen-way.json', cursor: '.cursor/rules/forgen-way.mdc', skill: '.claude/skills/docker-cache-bust/SKILL.md' };
    for (const [t, p] of Object.entries(paths)) {
      const r = cli('way', 'export', '--target', t);
      expect(r.status, t).toBe(0);
      expect(r.stdout, t).toContain(`===== ${p} =====`);
      expect(r.stdout, t).toContain('forgen-way');
    }
  });
});

describe('skill 대상: 표준 SKILL.md', () => {
  it('name 이 디렉터리와 같고 규칙을 지키며, description 이 트리거 문장이다', () => {
    const dir = path.join(root, 'skill-out');
    expect(cli('way', 'export', '--target', 'skill', '--out', dir).status).toBe(0);
    const md = fs.readFileSync(path.join(dir, '.claude/skills/docker-cache-bust/SKILL.md'), 'utf-8');
    const name = /^name: (.+)$/m.exec(md)?.[1] ?? '';
    expect(name).toBe('docker-cache-bust');
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    const desc = JSON.parse(/^description: (.+)$/m.exec(md)?.[1] ?? '""') as string;
    expect(desc.length).toBeGreaterThan(10);
    expect(desc.length).toBeLessThanOrEqual(1024);
    expect(desc).toContain('도커 빌드가 캐시 때문에');
    for (const h of ['## 적용 조건', '## 절차', '## 근거', '## 주의']) expect(md).toContain(h);
  });
});

describe('덮어쓰기 보호', () => {
  it('새 파일 생성 → 같은 내용 재실행은 unchanged → 바뀐 내용은 --force 없이 거부, 아무것도 쓰지 않음', () => {
    const dir = path.join(root, 'protect');
    expect(cli('way', 'export', '--target', 'agents-md', '--out', dir).stdout).toContain('create');
    expect(cli('way', 'export', '--target', 'agents-md', '--out', dir).stdout).toContain('unchanged');
    writeRule('r-late', '늦게 생긴 룰은 목록에 새로 들어간다');
    const before = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8');
    const r = cli('way', 'export', '--target', 'agents-md', '--out', dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--force');
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8')).toBe(before);
    expect(cli('way', 'export', '--target', 'agents-md', '--out', dir, '--force').status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8')).toContain('늦게 생긴 룰');
    fs.rmSync(ruleFile('r-late'));
  });
  it('forgen 표식이 없는 파일은 --force 로도 덮어쓰지 않는다', () => {
    const dir = path.join(root, 'foreign');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 내 손으로 쓴 지침\n');
    const r = cli('way', 'export', '--target', 'agents-md', '--out', dir, '--force');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('forgen way 가 만든 파일이 아니다');
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8')).toBe('# 내 손으로 쓴 지침\n');
  });
  it('여러 파일 중 하나라도 막히면 나머지도 쓰지 않는다', () => {
    const dir = path.join(root, 'partial');
    fs.mkdirSync(path.join(dir, '.cursor/rules'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cursor/rules/forgen-way-situational.mdc'), 'mine');
    expect(cli('way', 'export', '--target', 'cursor', '--out', dir).status).toBe(1);
    expect(fs.existsSync(path.join(dir, '.cursor/rules/forgen-way.mdc'))).toBe(false);
  });
});

describe('json 왕복', () => {
  it('export json → 수정 → import 미리보기(변경 없음) → --apply → 룰 파일·전이 사유·렌더 반영', () => {
    const file = path.join(root, 'way.json');
    fs.writeFileSync(file, cli('way', 'export', '--target', 'json', '--project', 'alpha-app').stdout.replace(/^===== .* =====\n/, ''));
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const preview0 = cli('way', 'import', file);
    expect(preview0.stdout).toContain('변경 0건');

    const soft = data.items.find((i: any) => i.id === 'r-global-soft');
    soft.statement = '커밋 메시지는 한 줄로 쓴다';
    soft.status = 'suppressed';
    data.items.find((i: any) => i.id === 'r-proj').projects = ['beta-app'];
    data.items.find((i: any) => i.id === 'r-global-strong').statement = '비밀값을 로그에 절대 출력하지 말 것 (고침)';
    fs.writeFileSync(file, JSON.stringify(data));

    // 강제되는 룰(r-global-strong)의 문장 수정은 --allow-enforced-edit 없이는 거부된다. 아무것도 바뀌지 않고 스냅샷도 없다.
    const refused = cli('way', 'import', file, '--apply');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('--allow-enforced-edit');
    expect(readRule('r-global-soft').policy).toBe('커밋 메시지는 짧게 쓴다');
    expect(readRule('r-global-strong').policy).toBe('비밀값은 로그에 출력하지 말 것');

    const preview = cli('way', 'import', file, '--allow-enforced-edit');
    expect(preview.stdout).toContain('미리보기');
    expect(preview.stdout).toContain('경고');
    expect(readRule('r-global-soft').policy).toBe('커밋 메시지는 짧게 쓴다'); // 미리보기는 바꾸지 않는다

    const applied = cli('way', 'import', file, '--apply', '--allow-enforced-edit');
    expect(applied.stdout).toContain('적용 전 스냅샷');
    expect(fs.readdirSync(path.join(forgen, 'backups')).some((n) => n.endsWith('pre-way-import'))).toBe(true);
    expect(applied.status, applied.stderr).toBe(0);
    const soft2 = readRule('r-global-soft');
    expect(soft2.policy).toBe('커밋 메시지는 한 줄로 쓴다');
    expect(soft2.status).toBe('suppressed');
    expect(soft2.status_history.at(-1)).toMatchObject({ from: 'active', to: 'suppressed', by: 'way-import' });
    expect(soft2.status_history.at(-1).reason).toContain('way import');
    expect(readRule('r-proj').projects).toEqual(['beta-app']);
    expect(readRule('r-global-strong').enforce_via).toBeDefined(); // 원본의 호스트 필드는 건드리지 않았다

    // 렌더: 새 세션 시작 컨텍스트와 다시 내보낸 산출물에 고친 문장이 들어간다.
    const hook = spawnSync(process.execPath, [path.join(DIST, 'hooks', 'session-recovery.js')], { input: JSON.stringify({ session_id: '44444444-4444-4444-8444-444444444444', cwd: work, source: 'startup', hook_event_name: 'SessionStart' }), encoding: 'utf-8', cwd: work, env: env() });
    const ctx = JSON.parse(hook.stdout.trim().split('\n').at(-1) ?? '{}').hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('비밀값을 로그에 절대 출력하지 말 것 (고침)');
    expect(ctx).not.toContain('커밋 메시지는 한 줄로 쓴다'); // 꺼진 룰은 렌더에서 빠진다
    const out = cli('way', 'export', '--target', 'agents-md', '--project', 'beta-app').stdout;
    expect(out).toContain('비밀값을 로그에 절대 출력하지 말 것 (고침)');
    expect(out).toContain('앱 화면 문구는 짧게');
  });
  it('스키마 오류는 적용 없이 거부한다', () => {
    const file = path.join(root, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ schema: 'forgen-way/1', items: [{ id: 'r-proj', kind: 'rule', statement: '', projects: 'x', strength: 'huge' }] }));
    const r = cli('way', 'import', file, '--apply');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('스키마 오류');
    expect(cli('way', 'import', path.join(root, 'nope.json')).status).toBe(1);
  });
  it('저장소에 없는 id 는 imported 출처가 아니면 거부한다', () => {
    const file = path.join(root, 'unknown.json');
    fs.writeFileSync(file, JSON.stringify({ schema: 'forgen-way/1', items: [{ id: 'ghost', kind: 'rule', statement: '유령', applies_when: '', projects: [], strength: 'soft', provenance: { kind: 'mined' }, enforceable: false }] }));
    const r = cli('way', 'import', file, '--apply');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('저장소에 없는 룰');
  });
});

describe('collect-memory', () => {
  const memDir = () => path.join(home, '.claude', 'projects', '-nonexistent-proj', 'memory');
  beforeAll(() => {
    fs.mkdirSync(memDir(), { recursive: true });
    fs.writeFileSync(path.join(memDir(), 'feedback_a.md'), '---\nname: a\ndescription: "2026-10-26 오너 — 답변은 항상 한국어로 쓴다"\nmetadata:\n  type: feedback\n---\n\n본문.\n\n**Why:** 화면이 무거워진다.\n**How to apply:** 영어 답변은 하지 않는다.\n');
    fs.writeFileSync(path.join(memDir(), 'feedback_dup.md'), '---\nname: d\ndescription: 비밀값은 로그에 출력하지 말 것 (고침)\n---\n\n본문\n');
    fs.writeFileSync(path.join(memDir(), 'project_other.md'), '---\nname: p\ndescription: feedback 아님\n---\n본문\n');
  });
  it('미리보기: 후보·근거·프로젝트 추정을 보이고 기존 룰과 중복은 제외한다. 적용 전엔 룰이 늘지 않는다', () => {
    const before = fs.readdirSync(path.join(forgen, 'me', 'rules')).length;
    const r = cli('way', 'collect-memory');
    expect(r.stdout).toContain('후보 2개 (새 1, 제외 1: duplicate 1)');
    expect(r.stdout).toContain('nonexistent-proj/feedback_a.md'); // 절대 경로가 아니라 슬러그/파일명
    expect(r.stdout).not.toContain(home);
    expect(r.stdout).toContain('전역(확인 필요)');
    expect(fs.readdirSync(path.join(forgen, 'me', 'rules')).length).toBe(before);
  });
  it('--apply: source imported 룰이 만들어지고 근거 파일이 남는다. 두 번째 실행은 중복으로 건너뛴다', () => {
    const r = cli('way', 'collect-memory', '--apply', '--project', 'alpha-app');
    expect(r.stdout).toContain('룰 1개 추가');
    const created = fs.readdirSync(path.join(forgen, 'me', 'rules')).map((f) => JSON.parse(fs.readFileSync(path.join(forgen, 'me', 'rules', f), 'utf-8'))).find((x) => x.source === 'imported');
    expect(created.imported_from).toBe('nonexistent-proj/feedback_a.md');
    expect(created.projects).toEqual(['alpha-app']);
    expect(created.policy).toBe('답변은 항상 한국어로 쓴다');
    expect(cli('way', 'collect-memory').stdout).toContain('새 0');
    const w = way();
    expect(w.items.find((i) => i.id === created.rule_id).provenance).toMatchObject({ kind: 'imported' });
  });
});

describe('skill promote', () => {
  it('검증된 솔루션을 표준 SKILL.md 로: 기본은 forgen 저장소, --install 은 ~/.claude/skills', () => {
    const r = cli('skill', 'promote', 'docker-cache-bust');
    expect(r.stdout).toContain('Promoted');
    expect(fs.existsSync(path.join(forgen, 'me', 'skills', 'docker-cache-bust', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.claude', 'skills'))).toBe(false);
    expect(cli('skill', 'promote', 'docker-cache-bust').stdout).toContain('Promoted'); // 같은 내용은 통과
    expect(cli('skill', 'promote', 'docker-cache-bust', '--install').stdout).toContain('Promoted');
    expect(fs.readFileSync(path.join(home, '.claude', 'skills', 'docker-cache-bust', 'SKILL.md'), 'utf-8')).toContain('--no-cache');
    expect(cli('skill', 'list').stdout).toContain('docker-cache-bust');
  });
  it('게이트: 미검증·빈 내용은 거부, 남이 만든 SKILL.md 는 덮어쓰지 않는다', () => {
    expect(cli('skill', 'promote', 'still-candidate').stdout).toContain('Only verified/mature');
    expect(cli('skill', 'promote', 'empty-one').stdout).toContain('no content');
    const dir = path.join(root, 'foreign-skill');
    fs.mkdirSync(path.join(dir, 'docker-cache-bust'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docker-cache-bust', 'SKILL.md'), '---\nname: docker-cache-bust\ndescription: mine\n---\n');
    const r = cli('skill', 'promote', 'docker-cache-bust', '--out', dir, '--force');
    expect(r.stdout).toContain('not written by forgen');
    expect(r.status).toBe(1);
  });
});

describe('install codex 는 cwd 에 쓰지 않는다 (E7)', () => {
  it('AGENTS.md 는 $CODEX_HOME 에만 생긴다', () => {
    const cwd = path.join(root, 'install-cwd');
    fs.mkdirSync(cwd, { recursive: true });
    const r = spawnSync(process.execPath, [path.join(DIST, 'cli.js'), 'install', 'codex', '--no-mcp'], { encoding: 'utf-8', cwd, env: env(), timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readdirSync(cwd)).toEqual([]);
    expect(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf-8')).toContain('forgen');
  }, 130_000);
});
