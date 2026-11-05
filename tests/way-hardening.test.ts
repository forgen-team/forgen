/**
 * Way 쓰기 안전·표식·프로젝트 누수·import 신뢰 경계·메모리 수집·skill·install 정리.
 * 빌드된 CLI 를 격리 HOME 에서 실제로 실행한다. 대역 없음.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DIST = path.resolve(__dirname, '..', 'dist');
let root: string, home: string, forgen: string, work: string;
const env = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, FORGEN_HOME: forgen, CODEX_HOME: path.join(home, '.codex'), XDG_CONFIG_HOME: path.join(home, '.config'), FORGEN_SYNTHETIC: '1', FORGEN_CWD: work, FORGEN_DISABLE_PROJECT_RULES: '1', FORGEN_NO_BLOCK_JUDGE: '1' });
const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(DIST, 'cli.js'), ...args], { encoding: 'utf-8', cwd: work, env: env(), timeout: 120_000 });
const ruleFile = (id: string) => path.join(forgen, 'me', 'rules', `${id}.json`);
const readRule = (id: string) => JSON.parse(fs.readFileSync(ruleFile(id), 'utf-8'));
const NOW = '2026-10-01T00:00:00.000Z';
function writeRule(id: string, policy: string, o: Record<string, unknown> = {}) {
  fs.writeFileSync(ruleFile(id), JSON.stringify({ rule_id: id, category: 'workflow', scope: 'me', trigger: '작업을 시작하기 전 확인할 때', policy, strength: 'default', source: 'explicit_correction', status: 'active', evidence_refs: [], render_key: `workflow.${id}`, created_at: NOW, updated_at: NOW, ...o }));
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-way-hard-'));
  home = path.join(root, 'home'); forgen = path.join(home, '.forgen'); work = path.join(root, 'work');
  for (const d of ['rules', 'behavior', 'solutions']) fs.mkdirSync(path.join(forgen, 'me', d), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(forgen, 'forge-profile.json'), '{}');
  writeRule('r-host', '배포 전에 롤백 절차를 확인한다. secret-filter hook 이 감지하면 즉시 중단한다.');
  writeRule('r-plain', '커밋 메시지는 짧게 쓴다');
  writeRule('r-proj-trig', '화면 문구는 짧게 쓴다', { trigger: 'alpha-app 화면에서 문구가 길었을 때' });
  writeRule('r-alpha', '알파 전용 규칙을 따른다', { projects: ['alpha-app'] });
  writeRule('r-product', 'Zorbix 앱은 오프라인에서도 열려야 한다');
  writeRule('r-ban', '운영 DB 에 직접 쓰기를 하지 말 것 반드시 마이그레이션을 거친다', { strength: 'strong', category: 'safety' });
  writeRule('r-dupA', '테스트 먼저', { render_key: 'same.key', strength: 'default' });
  writeRule('r-dupB', '테스트를 먼저 돌린다', { render_key: 'same.key', strength: 'strong' });
  writeRule('r-removed', '로그에 토큰을 찍지 않는다 제거된 룰이다', { status: 'removed' });
  writeRule('r-enf', '파일을 지우기 전에 확인한다', { strength: 'strong', enforce_via: [{ mech: 'A', hook: 'PreToolUse', verifier: { kind: 'tool_arg_regex', params: { pattern: 'rm -rf' } } }] });
  writeRule('r-hard', '비밀키는 커밋하지 않는다', { strength: 'hard' });
  fs.writeFileSync(path.join(forgen, 'me', 'behavior', 'auto-2026-01-01-safety.md'), ['---', 'created: "2026-01-01"', '---', '- [safety] 패턴 설명 (관찰 근거)', '- [safety] 병렬 에이전트는 팀으로만 쓴다 반드시 지킨다', ''].join('\n'));
  const sol = (name: string, context: string) => fs.writeFileSync(path.join(forgen, 'me', 'solutions', `${name}.md`), ['---', `name: ${name}`, 'version: 1', 'status: verified', 'confidence: 0.8', 'type: pattern', 'scope: me', 'tags:', '  - "docker"', 'identifiers: []', 'evidence:', '  injected: 0', '  reflected: 0', '  negative: 0', '  sessions: 0', '  reExtracted: 0', 'created: 2026-10-01', 'updated: 2026-10-01', 'supersedes: null', 'extractedBy: manual', '---', '', '## Context', context, '', '## Content', '1. 먼저 빌드한다.\n2. 결과를 확인한다.', ''].join('\n'));
  sol('docker-cache-bust', '도커 빌드가 캐시 때문에 옛 파일을 쓸 때');
  sol('캐시-무효화-절차', '캐시가 오래되어 결과가 달라질 때');
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('쓰기 안전', () => {
  it('심링크 디렉터리·심링크 파일·.. 로 --out 밖에 쓰지 않는다', () => {
    const out = path.join(root, 'o-link'); const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(out, '.claude'), { recursive: true }); fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(out, '.claude', 'rules')); // 상위 디렉터리 심링크
    const r = cli('way', 'export', '--target', 'claude-rules', '--out', out, '--force');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('실경로 밖');
    expect(fs.readdirSync(outside)).toEqual([]);

    const out2 = path.join(root, 'o-file'); fs.mkdirSync(out2, { recursive: true });
    const victim = path.join(outside, 'victim.txt'); fs.writeFileSync(victim, 'keep');
    fs.symlinkSync(victim, path.join(out2, 'AGENTS.md')); // 파일 심링크
    const r2 = cli('way', 'export', '--target', 'agents-md', '--out', out2, '--force');
    expect(r2.status).toBe(1);
    expect(fs.readFileSync(victim, 'utf-8')).toBe('keep');

    fs.symlinkSync(path.join(root, 'nowhere'), path.join(out2, 'GEMINI.md')); // 끊어진 링크
    expect(cli('way', 'export', '--target', 'gemini', '--out', out2).status).toBe(1);
  });
  it('표식은 앞부분의 정확한 줄만: 본문 중간의 단어는 인정하지 않고, --force 덮어쓰기는 백업을 남긴다', () => {
    const out = path.join(root, 'o-mark'); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'AGENTS.md'), `내 지침\n이 문서는 forgen-way 에 대해 말한다. <!-- forgen-way -->는 표식 모양이지만 줄이 아니다\n`);
    const r = cli('way', 'export', '--target', 'agents-md', '--out', out, '--force');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('표식 줄이 없다');
    expect(fs.readFileSync(path.join(out, 'AGENTS.md'), 'utf-8')).toContain('내 지침');
    // 정상 파일: 쓰고 → 내용 바꿔 → force 덮어쓰기 → 백업
    fs.rmSync(path.join(out, 'AGENTS.md'));
    expect(cli('way', 'export', '--target', 'agents-md', '--out', out).status).toBe(0);
    const f = path.join(out, 'AGENTS.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf-8').replace('# 작업 방식', '# 작업 방식 (손으로 고침)'));
    expect(cli('way', 'export', '--target', 'agents-md', '--out', out).status).toBe(1);
    const forced = cli('way', 'export', '--target', 'agents-md', '--out', out, '--force');
    expect(forced.status).toBe(0);
    const baks = fs.readdirSync(out).filter((n) => n.startsWith('AGENTS.md.forgen-bak-'));
    expect(baks).toHaveLength(1);
    expect(fs.readFileSync(path.join(out, baks[0]), 'utf-8')).toContain('손으로 고침');
  });
});

describe('다른 모델 산출물', () => {
  it('도입문, 호스트 꼬리 절 제거, 계기 생략, 프로젝트 누수 경고', () => {
    const r = cli('way', 'export', '--target', 'agents-md');
    expect(r.stdout).toContain('작업 범위와 무관한 항목은 무시한다');
    expect(r.stdout).not.toContain('모두 따른다');
    expect(r.stdout).toContain('배포 전에 롤백 절차를 확인한다.');
    expect(r.stdout).not.toContain('secret-filter');
    expect(r.stdout).not.toContain('계기');
    expect(r.stdout).not.toContain('alpha-app'); // 프로젝트 전용 룰은 빠진다
    expect(r.stderr).toMatch(/호스트 전용 꼬리 절 제거/);
    expect(r.stderr).toContain('프로젝트 전용일 수 있음');
    expect(r.stderr).toContain('forgen rule classify-projects');
    // Claude 대상은 호스트 용어를 그대로 두고, 계기도 싣되 다른 프로젝트 이름을 말하는 계기는 숨긴다
    const c = cli('way', 'export', '--target', 'claude-rules');
    expect(c.stdout).toContain('secret-filter hook');
    expect(c.stdout).toContain('계기');
    expect(c.stdout).not.toContain('alpha-app 화면에서');
  });
  it('요약에 프로젝트 전용 의심이 나오고, 같은 render_key 는 하나만, 예산 우선순위는 강도 순', () => {
    expect(cli('way').stdout).toContain('프로젝트 전용일 수 있는 전역 룰');
    const r = cli('way', 'export', '--target', 'system-prompt');
    expect(r.stdout).toContain('테스트를 먼저 돌린다');
    expect(r.stdout).not.toContain('테스트 먼저\n');
    expect(r.stderr).toContain('duplicate 1');
    const small = cli('way', 'export', '--target', 'system-prompt', '--budget', '420');
    expect(small.stdout).toContain('비밀키는 커밋하지 않는다'); // hard 가 먼저 남는다
    expect(small.stderr).toContain('예산으로 뺌');
    expect(small.stdout.indexOf('운영 DB')).toBeLessThan(small.stdout.indexOf('커밋 메시지는 짧게') === -1 ? Infinity : small.stdout.indexOf('커밋 메시지는 짧게')); // strong 이 default 보다 먼저
  });
  it('--habits: 템플릿 잔재는 없다', () => {
    const r = cli('way', 'export', '--target', 'system-prompt', '--habits');
    expect(r.stdout).not.toContain('패턴 설명');
    expect(r.stdout).toContain('병렬 에이전트는 팀으로만');
  });
});

describe('skill 대상', () => {
  it('룰은 사용 시점이 없어 기본 제외(draft 안내), 솔루션만. 이름은 설명 슬러그, 금지 룰은 절차가 아니다', () => {
    const out = path.join(root, 'o-skill');
    const r = cli('way', 'export', '--target', 'skill', '--out', out);
    expect(r.status, r.stderr).toBe(0);
    const names = fs.readdirSync(path.join(out, '.claude', 'skills')).sort();
    expect(names).toContain('docker-cache-bust');
    expect(names.some((n) => /^way-/.test(n))).toBe(false);
    expect(names.find((n) => n !== 'docker-cache-bust')).toMatch(/^kaesi-muhyohwa/); // 한글 이름은 로마자 슬러그
    expect(names).toHaveLength(2);
    const ban = cli('way', 'export', '--target', 'skill', '--item', 'r-ban');
    expect(ban.stdout).toContain('## 금지');
    expect(ban.stdout).not.toContain('## 절차');
    expect(ban.stdout.match(/^description: .*$/m)?.[0]).not.toContain('작업을 시작하기 전 확인할 때'); // trigger 가 description 에 안 들어간다
    expect(ban.stderr).toContain('낮은 품질');
    expect(ban.stderr).toContain('forgen way draft skill');
  });
});

describe('import 신뢰 경계', () => {
  const imp = (obj: unknown, ...flags: string[]) => {
    const f = path.join(root, `imp-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(obj)); return cli('way', 'import', f, ...flags);
  };
  const base = (o: Record<string, unknown>) => ({ applies_when: '', why: '', projects: [], enforceable: false, provenance: { kind: 'imported', from: 'x/y.md' }, kind: 'rule', ...o });
  it('알 수 없는 필드, hard 신규, 새 룰의 비활성 상태, 같은 파일 중복 id 를 거부한다', () => {
    const j = (items: unknown[]) => ({ schema: 'forgen-way/1', items });
    const unk = imp(j([base({ id: 'n1', statement: '새 규칙 하나 추가한다', strength: 'soft', evil: 1 })]), '--apply');
    expect(unk.status).toBe(1); expect(unk.stderr).toContain('알 수 없는 필드');
    const hard = imp(j([base({ id: 'n2', statement: '새 규칙 둘 추가한다', strength: 'hard' })]), '--apply');
    expect(hard.status).toBe(1); expect(hard.stdout + hard.stderr).toContain('hard');
    const st = imp(j([base({ id: 'n3', statement: '새 규칙 셋 추가한다', strength: 'soft', status: 'suppressed' })]), '--apply');
    expect(st.status).toBe(1); expect(st.stdout + st.stderr).toContain('active 로만');
    const dupId = imp(j([base({ id: 'n4', statement: '가나다라마바사 규칙', strength: 'soft' }), base({ id: 'n4', statement: '아자차카타파하 규칙', strength: 'soft' })]));
    expect(dupId.status).toBe(1); expect(dupId.stderr).toContain('id 가 중복');
  });
  it('같은 파일 내 중복·제거된 룰과의 중복은 무시, 기존 hard 는 강도 하향 거부, 새로 hard 승급 거부', () => {
    const d = imp({ schema: 'forgen-way/1', items: [base({ id: 'm1', statement: '리뷰 요청 전에 린트를 돌려 본다', strength: 'soft' }), base({ id: 'm2', statement: '리뷰 요청 전에 린트를 돌려 본다.', strength: 'soft' }), base({ id: 'm3', statement: '로그에 토큰을 찍지 않는다 제거된 룰이다', strength: 'soft' })] });
    expect(d.stdout).toContain('변경 1건, 무시 2건');
    const low = imp({ schema: 'forgen-way/1', items: [base({ id: 'r-hard', statement: '비밀키는 커밋하지 않는다', strength: 'soft', provenance: { kind: 'mined' } })] }, '--apply');
    expect(low.status).toBe(1); expect(low.stdout + low.stderr).toContain('--allow-enforced-edit');
    expect(readRule('r-hard').strength).toBe('hard');
    const up = imp({ schema: 'forgen-way/1', items: [base({ id: 'r-plain', statement: '커밋 메시지는 짧게 쓴다', strength: 'hard', provenance: { kind: 'mined' } })] }, '--apply', '--allow-enforced-edit');
    expect(up.status).toBe(1); expect(up.stdout + up.stderr).toContain('hard 를 새로 줄 수 없다');
    expect(readRule('r-plain').strength).toBe('default');
  });
});

describe('collect-memory 걸러내기', () => {
  it('잘림·로그성·비밀·활성 룰과 충돌·제거된 룰 중복은 제외하고 이유를 보이며, 홈 메모리는 저장소 이름이 있을 때만 후보', () => {
    const memRoot = path.join(root, 'mem');
    const home1 = path.join(memRoot, '-home-nobody', 'memory'); fs.mkdirSync(home1, { recursive: true });
    const fm = (d: string) => `---\nname: x\ndescription: "${d}"\n---\n\n본문\n`;
    fs.writeFileSync(path.join(home1, 'feedback_trunc.md'), fm('답변을 쓸 때는 항상 근거를 먼저 말하고 결론은 뒤에 붙이는 순서로 …'));
    fs.writeFileSync(path.join(home1, 'feedback_log.md'), fm('커밋 abc1234 푸시됨 이후 후속 정리를 다음 세션에서 이어간다'));
    fs.writeFileSync(path.join(home1, 'feedback_secret.md'), fm('배포 토큰 sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA 를 쓴다'));
    fs.writeFileSync(path.join(home1, 'feedback_removed.md'), fm('로그에 토큰을 찍지 않는다 제거된 룰이다'));
    fs.writeFileSync(path.join(home1, 'feedback_conflict.md'), fm('운영 DB 에 직접 쓰기를 항상 허용한다 필요하면 바로 실행해도 된다'));
    fs.writeFileSync(path.join(home1, 'feedback_ok.md'), fm('릴리스 노트는 변경 이유부터 쓰고 파일 목록은 뒤에 둔다'));
    const r = cli('way', 'collect-memory', '--dir', memRoot);
    expect(r.stdout).toMatch(/새 1, 제외 5/);
    for (const k of ['truncated', 'log', 'secret', 'duplicate', 'conflict']) expect(r.stdout).toContain(k);
    expect(r.stdout).toContain('릴리스 노트는');
    expect(r.stdout).not.toContain(root); // 절대 경로 노출 없음
    expect(r.stdout).not.toContain('sk-ant-api03');
    const j = cli('way', 'collect-memory', '--dir', memRoot, '--json');
    const items = JSON.parse(j.stdout).items;
    expect(items).toHaveLength(1);
    expect(items[0].provenance.from).toMatch(/^[\w-]+\/feedback_ok\.md$/);
    expect(items[0].projects).toEqual([]);
  });
});

describe('install 정리', () => {
  it('codex: 예전 cwd·홈·기록 경로의 forgen 블록만 걷어내고 사용자 글은 보존, override 경고, hooks/config 해시 불변', () => {
    const B = ['<!-- >>> forgen-managed-rules -->', '## forgen managed rules', '- old', '<!-- <<< forgen-managed-rules -->'].join('\n');
    const git = path.join(root, 'repo'); fs.mkdirSync(path.join(git, '.git'), { recursive: true });
    fs.writeFileSync(path.join(git, 'AGENTS.md'), `# 내 글\n\n${B}\n\n뒤 글\n`);
    fs.writeFileSync(path.join(home, 'AGENTS.md'), `${B}\n`);
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'AGENTS.override.md'), '내 override');
    const run = () => spawnSync(process.execPath, [path.join(DIST, 'cli.js'), 'install', 'codex', '--no-mcp'], { encoding: 'utf-8', cwd: git, env: env(), timeout: 120_000 });
    const first = run(); expect(first.status, first.stderr).toBe(0);
    const h = () => ['hooks.json', 'config.toml'].map((f) => fs.readFileSync(path.join(home, '.codex', f), 'utf-8'));
    const h1 = h();
    expect(first.stdout).toContain('cleaned old forgen block');
    expect(first.stdout).toContain('AGENTS.override.md exists');
    expect(fs.readFileSync(path.join(git, 'AGENTS.md'), 'utf-8')).toBe('# 내 글\n\n뒤 글\n');
    expect(fs.existsSync(path.join(home, 'AGENTS.md'))).toBe(false); // 블록뿐이던 파일
    expect(fs.readFileSync(path.join(home, '.codex', 'AGENTS.override.md'), 'utf-8')).toBe('내 override');
    fs.writeFileSync(path.join(git, 'AGENTS.md'), `# 내 글\n\n${B}\n`);
    expect(run().status).toBe(0);
    expect(h()).toEqual(h1); // 재승인을 부르는 hooks.json/config.toml 변화 없음
    expect(fs.readFileSync(path.join(git, 'AGENTS.md'), 'utf-8')).toBe('# 내 글\n');
  }, 250_000);
  it('opencode: cwd 가 아니라 <config>/AGENTS.md 에 쓰고 예전 cwd 블록을 걷어낸다', () => {
    const B = ['<!-- >>> forgen-managed-rules -->', '## forgen managed rules', '<!-- <<< forgen-managed-rules -->'].join('\n');
    const git = path.join(root, 'repo2'); fs.mkdirSync(path.join(git, '.git'), { recursive: true });
    fs.writeFileSync(path.join(git, 'AGENTS.md'), `메모\n\n${B}\n`);
    const r = spawnSync(process.execPath, [path.join(DIST, 'cli.js'), 'install', 'opencode', '--no-mcp'], { encoding: 'utf-8', cwd: git, env: env(), timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(git, 'AGENTS.md'), 'utf-8')).toBe('메모\n');
    expect(fs.readFileSync(path.join(home, '.config', 'opencode', 'AGENTS.md'), 'utf-8')).toContain('forgen-managed-rules');
  }, 130_000);
});
