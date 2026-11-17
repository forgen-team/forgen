/**
 * D12-A/B/D: 강제 hook 프로세스 테스트 — dist hook 을 실제로 spawn 해 stdout JSON 1개와 판정을 고정한다.
 * mock 없음. HOME/FORGEN_HOME/cwd 는 임시 디렉터리로 격리. 위험·비밀 문자열은 조립해서 쓴다.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DIST = path.resolve(import.meta.dirname, '..', '..', 'dist', 'hooks');
const have = fs.existsSync(path.join(DIST, 'pre-tool-use.js'));
const RM = ['r', 'm'].join('');
const RF = ['-r', 'f'].join('');
const AWS = ['AKIA', 'Z7XQ4MNP2LKJ5HRT'].join('');
const SK = ['sk', '-', 'proj', '-', 'abcdefghijklmnopqrstuvwxyz0123'].join('');

let root: string; let home: string; let work: string;

function run(hook: string, payload: unknown, env: Record<string, string> = {}, raw?: string) {
  const r = spawnSync(process.execPath, [path.join(DIST, `${hook}.js`)], {
    input: raw ?? JSON.stringify(payload), encoding: 'utf-8', timeout: 15000, cwd: work,
    env: { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), FORGEN_NO_BLOCK_JUDGE: '1', FORGEN_NESTED_RUN: '', ...env },
  });
  const lines = r.stdout.split('\n').filter((l) => l.trim());
  return { lines, json: lines.length ? JSON.parse(lines[0]) : null, status: r.status, stderr: r.stderr };
}
const bash = (command: string, env?: Record<string, string>) =>
  run('pre-tool-use', { session_id: '11111111-1111-4111-8111-111111111111', tool_name: 'Bash', tool_input: { command }, cwd: work }, env);
const decision = (o: ReturnType<typeof run>) => (o.json?.hookSpecificOutput?.permissionDecision as string | undefined) ?? 'pass';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-enf-'));
  home = path.join(root, 'home'); work = path.join(root, 'work');
  fs.mkdirSync(path.join(home, '.forgen'), { recursive: true }); fs.mkdirSync(work, { recursive: true });
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

type Case = [string, string, 'pass' | 'ask' | 'deny'];
const cases: Case[] = [
  ['plain', `${RM} ${RF} build`, 'ask'],
  ['split', `${RM} -r -f build`, 'ask'],
  ['-fr', `${RM} -fr build`, 'ask'],
  ['-Rf', `${RM} -Rf build`, 'ask'],
  ['long', `${RM} --recursive --force build`, 'ask'],
  ['bash -c', `bash -c "${RM} ${RF} build"`, 'ask'],
  ['sh -c', `sh -c '${RM} -r -f build'`, 'ask'],
  ['eval', `eval "${RM} ${RF} build"`, 'ask'],
  ['after &&', `cd src && ${RM} ${RF} out`, 'ask'],
  ['after ;', `ls; ${RM} ${RF} out`, 'ask'],
  ['xargs', `ls | xargs ${RM} ${RF}`, 'ask'],
  ['find -delete', 'find . -name "*.o" -delete', 'ask'],
  ['find -exec', `find build -exec ${RM} ${RF} {} +`, 'ask'],
  ['rmtree', 'python3 -c "import shutil; shutil.rmtree(\'build\')"', 'ask'],
  ['os.remove', 'python3 -c "import os; os.remove(\'a.db\')"', 'ask'],
  ['root', `${RM} ${RF} /`, 'deny'],
  ['home tilde', `${RM} ${RF} ~`, 'deny'],
  ['$HOME', `${RM} ${RF} $HOME`, 'deny'],
  ['sudo bash -c root', `sudo bash -c '${RM} -fr /'`, 'deny'],
  ['mkfs', 'mkfs.ext4 /dev/sda1', 'deny'],
  ['claude temp', `${RM} ${RF} /tmp/claude-1001/x/y`, 'pass'],
  ['echo pre_mkfs', 'echo pre_mkfs foo', 'pass'],
  ['echo rm text', `echo "${RM} ${RF} /"`, 'pass'],
  ['grep rm', `grep "${RM} ${RF}" notes.md`, 'pass'],
  ['commit msg', `git commit -m "docs: mention ${RM} ${RF} / hazard"`, 'pass'],
  ['comment', `ls # ${RM} ${RF} /`, 'pass'],
  ['heredoc', `cat > n.md <<'EOF'\n${RM} ${RF} /\nEOF`, 'pass'],
  ['grep DROP', 'grep "DROP TABLE" schema.sql', 'pass'],
  ['rm file', `${RM} -f a.log`, 'pass'],
];

describe.skipIf(!have)('pre-tool-use 위험 명령 판정 (프로세스)', () => {
  it.each(cases)('%s', (_n, cmd, expected) => {
    const o = bash(cmd);
    expect(o.lines).toHaveLength(1); // stdout JSON 1개
    expect(decision(o)).toBe(expected);
  });

  it('ask 사유에 확인 안내가 있다', () => {
    const o = bash(`${RM} ${RF} build`);
    expect(o.json.hookSpecificOutput.permissionDecisionReason).toContain('확인');
  });

  it('FORGEN_USER_CONFIRMED=1 이면 ask 는 통과하고 deny(root)는 그대로 막힌다', () => {
    expect(decision(bash(`${RM} ${RF} build`, { FORGEN_USER_CONFIRMED: '1' }))).toBe('pass');
    expect(decision(bash(`${RM} ${RF} /`, { FORGEN_USER_CONFIRMED: '1' }))).toBe('deny');
  });
});

describe.skipIf(!have)('db-guard (프로세스)', () => {
  const db = (command: string, env?: Record<string, string>) =>
    run('db-guard', { session_id: 's', tool_name: 'Bash', tool_input: { command } }, env);
  const rows: Array<[string, string, 'pass' | 'deny']> = [
    ['psql -c', 'psql -c "DROP TABLE users"', 'deny'],
    ['docker psql', 'docker exec db psql -c "DROP TABLE users"', 'deny'],
    ['echo | psql', 'echo "DROP TABLE users;" | psql mydb', 'deny'],
    ['heredoc psql', 'psql mydb <<EOF\nDROP TABLE users;\nEOF', 'deny'],
    ['sqlite3 delete', 'sqlite3 a.db "DELETE FROM users"', 'deny'],
    ['sqlite3 delete where', 'sqlite3 a.db "DELETE FROM users WHERE id=1"', 'pass'],
    ['grep', 'grep "DROP TABLE" schema.sql', 'pass'],
    ['echo', 'echo DROP TABLE users', 'pass'],
    ['commit msg', 'git commit -m "remove DROP TABLE migration"', 'pass'],
    ['comment', 'ls # DROP TABLE x', 'pass'],
  ];
  it.each(rows)('%s', (_n, cmd, expected) => {
    const o = db(cmd);
    expect(o.lines).toHaveLength(1);
    expect(decision(o)).toBe(expected);
  });
});

describe.skipIf(!have)('secret-filter (프로세스) — Bash tool_response 객체 (H3)', () => {
  const post = (tool_response: unknown, extra: Record<string, unknown> = {}, env?: Record<string, string>) =>
    run('secret-filter', { session_id: 's', tool_name: 'Bash', tool_input: { command: 'cat config' }, tool_response, ...extra }, env);

  it('stdout 객체 안의 AWS 키를 탐지하고 모델 컨텍스트로 전달하되 값은 싣지 않는다', () => {
    const o = post({ stdout: `aws_access_key_id=${AWS}\n`, stderr: '', interrupted: false });
    expect(o.lines).toHaveLength(1);
    const ctx = o.json.hookSpecificOutput?.additionalContext as string;
    expect(o.json.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(ctx).toContain('AWS Access Key');
    expect(o.lines[0]).not.toContain(AWS);
  });
  it('stderr 안의 키도 탐지', () => {
    const o = post({ stdout: '', stderr: `token ${SK}` });
    expect(o.json.hookSpecificOutput?.additionalContext).toContain('API Key');
  });
  it('문자열 응답(레거시)도 탐지', () => {
    expect(post(`key=${AWS}`).json.hookSpecificOutput?.additionalContext).toContain('AWS');
  });
  it('비밀 없는 객체 응답은 조용히 통과하고 [object Object] 를 만들지 않는다', () => {
    const o = post({ stdout: 'hello', stderr: '' });
    expect(o.json).toEqual({ continue: true });
  });
  it('중첩 실행(FORGEN_NESTED_RUN=1)에서도 secret-filter 는 유지된다 (D12-D)', () => {
    const o = post({ stdout: AWS, stderr: '' }, {}, { FORGEN_NESTED_RUN: '1' });
    expect(o.json.hookSpecificOutput?.additionalContext).toContain('AWS');
  });
});

describe.skipIf(!have)('slop-detector (프로세스) — 모델 전달', () => {
  it('Write 에 슬롭이 있으면 additionalContext 로 전달', () => {
    const o = run('slop-detector', { session_id: 's', tool_name: 'Write', tool_input: { file_path: 'a.ts', content: 'const x = y as any;\n' }, tool_response: { type: 'create' } });
    expect(o.lines).toHaveLength(1);
    expect(o.json.hookSpecificOutput?.additionalContext).toContain('as any');
  });
  it('깨끗한 코드는 통과', () => {
    const o = run('slop-detector', { session_id: 's', tool_name: 'Write', tool_input: { file_path: 'a.ts', content: 'export const x = 1;\n' }, tool_response: { type: 'create' } });
    expect(o.json).toEqual({ continue: true });
  });
});

describe.skipIf(!have)('git add/commit 비밀 차단 (실제 staged 확인)', () => {
  let repo: string;
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf-8' });
  const pre = (command: string) => run('pre-tool-use', { session_id: '22222222-2222-4222-8222-222222222222', tool_name: 'Bash', tool_input: { command }, cwd: repo });
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(root, 'repo-'));
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n'); g('add', 'README.md'); g('commit', '-qm', 'init');
  });
  const reset = () => { try { g('reset', '-q'); } catch { /* */ } for (const f of fs.readdirSync(repo)) if (f !== '.git' && f !== 'README.md') fs.rmSync(path.join(repo, f), { recursive: true, force: true }); };

  it('git add .env → ask (사유 표시)', () => {
    reset(); fs.writeFileSync(path.join(repo, '.env'), 'A=1\n');
    const o = pre('git add .env');
    expect(decision(o)).toBe('ask'); expect(o.json.hookSpecificOutput.permissionDecisionReason).toContain('.env');
  });
  it('git add -A 는 untracked .env 를 찾아 ask', () => {
    reset(); fs.writeFileSync(path.join(repo, '.env.local'), 'A=1\n'); fs.writeFileSync(path.join(repo, 'a.ts'), 'x\n');
    expect(decision(pre('git add -A'))).toBe('ask');
    expect(decision(pre('git add . && git commit -m wip'))).toBe('ask');
  });
  it('.gitignore 로 제외된 .env 는 git add . 가 넣지 않으므로 통과', () => {
    reset(); fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n'); fs.writeFileSync(path.join(repo, '.env'), 'A=1\n');
    expect(decision(pre('git add .'))).toBe('pass');
    fs.rmSync(path.join(repo, '.gitignore'));
  });
  it('.env.example 은 통과', () => {
    reset(); fs.writeFileSync(path.join(repo, '.env.example'), 'A=\n');
    expect(decision(pre('git add .env.example'))).toBe('pass');
  });
  it('credentials.json staged → git commit ask', () => {
    reset(); fs.writeFileSync(path.join(repo, 'credentials.json'), '{}\n'); g('add', 'credentials.json');
    expect(decision(pre('git commit -m x'))).toBe('ask');
  });
  it('staged 파일 내용의 AWS 키 → git commit ask, 값은 메시지에 없다', () => {
    reset(); fs.writeFileSync(path.join(repo, 'cfg.ts'), `export const k = "${AWS}";\n`); g('add', 'cfg.ts');
    const o = pre('git commit -m feat');
    expect(decision(o)).toBe('ask');
    expect(JSON.stringify(o.json)).not.toContain(AWS);
    expect(o.json.hookSpecificOutput.permissionDecisionReason).toContain('cfg.ts');
  });
  it('git commit -a 는 tracked 변경의 키도 본다', () => {
    reset(); fs.writeFileSync(path.join(repo, 'README.md'), `hi ${AWS}\n`);
    expect(decision(pre('git commit -am x'))).toBe('ask');
    g('checkout', '--', 'README.md');
  });
  it('깨끗한 변경은 통과', () => {
    reset(); fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 1;\n'); g('add', 'b.ts');
    expect(decision(pre('git commit -m ok'))).toBe('pass');
    expect(decision(pre('git add b.ts'))).toBe('pass');
  });
});

describe.skipIf(!have)('FORGEN_NESTED_RUN=1 (D12-D) — 위험 차단 유지, 학습·주입 hook 은 끔', () => {
  const N = { FORGEN_NESTED_RUN: '1' };
  it('pre-tool-use 위험 차단 유지', () => {
    expect(decision(bash(`${RM} ${RF} /`, N))).toBe('deny');
    expect(decision(bash(`${RM} ${RF} build`, N))).toBe('ask');
    expect(decision(bash('mkfs.ext4 /dev/sda1', N))).toBe('deny');
  });
  it('db-guard 유지', () => {
    expect(decision(run('db-guard', { session_id: 's', tool_name: 'Bash', tool_input: { command: 'psql -c "DROP TABLE t"' } }, N))).toBe('deny');
  });
  it('slop-detector(학습/품질 hook)는 중첩에서 꺼진다', () => {
    const o = run('slop-detector', { session_id: 's', tool_name: 'Write', tool_input: { file_path: 'a.ts', content: 'x as any' }, tool_response: '' }, N);
    expect(o.json).toEqual({ continue: true });
  });
});
