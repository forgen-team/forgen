/**
 * 0.8.0 S5: 프로젝트 밖에서 시작한 세션은 전역·미정 룰 + 색인만 받고, 작업이 프로젝트로 들어갈 때 그 룰을 한 번 받는다.
 * 실제 dist 훅 프로세스(session-recovery, context-guard, post-tool-use)로 검증한다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const have = fs.existsSync(path.join(DIST, 'hooks', 'post-tool-use.js'));

let root: string; let home: string; let fhome: string; let repoA: string; let repoB: string;

const env = () => {
  const e: Record<string, string | undefined> = { ...process.env, HOME: home, FORGEN_HOME: fhome, FORGEN_NO_BLOCK_JUDGE: '1', FORGEN_NESTED_RUN: '' };
  delete e.FORGEN_CWD; delete e.COMPOUND_CWD; delete e.FORGEN_SESSION_ID; delete e.FORGEN_RUNTIME; delete e.FORGEN_HOST;
  return e as NodeJS.ProcessEnv;
};
function hook(name: string, payload: Record<string, unknown>) {
  const r = spawnSync(process.execPath, [path.join(DIST, 'hooks', `${name}.js`)], { input: JSON.stringify(payload), encoding: 'utf-8', timeout: 20000, cwd: home, env: env() });
  expect(r.status, r.stderr).toBe(0);
  const line = r.stdout.trim().split('\n').filter(Boolean).pop() ?? '{}';
  const j = JSON.parse(line);
  return { ctx: String(j.hookSpecificOutput?.additionalContext ?? ''), json: j };
}
function writeRule(id: string, policy: string, extra: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(fhome, 'me', 'rules', `${id}.json`), JSON.stringify({
    rule_id: id, category: 'workflow', scope: 'me', trigger: 't', policy, strength: 'default', source: 'explicit_correction',
    status: 'active', evidence_refs: [], render_key: `k.${id}`, created_at: now, updated_at: now, ...extra,
  }));
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-switch-')));
  home = path.join(root, 'home'); fhome = path.join(home, '.forgen');
  repoA = path.join(home, 'ws', 'repo-a'); repoB = path.join(home, 'ws', 'repo-b');
  for (const d of [path.join(repoA, '.git'), path.join(repoB, '.git'), path.join(repoB, 'src'), path.join(fhome, 'me', 'rules'), path.join(fhome, 'state')]) fs.mkdirSync(d, { recursive: true });
  writeRule('g1', '전역 룰 본문입니다');
  writeRule('u1', '미정 룰 본문입니다', { scope_state: 'unresolved' });
  writeRule('a1', 'repo-a 전용 룰 본문입니다', { projects: ['repo-a'] });
  writeRule('b1', 'repo-b 전용 룰 본문입니다', { projects: ['repo-b'] });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(!have)('S5 위치 전환 주입', () => {
  const sid = 'switch-sess-1';
  it('프로젝트 밖 세션 시작: 전역·미정 + 색인, 프로젝트 룰 본문 없음', () => {
    const { ctx } = hook('session-recovery', { session_id: sid, cwd: home, source: 'startup', hook_event_name: 'SessionStart' });
    expect(ctx).toContain('전역 룰 본문');
    expect(ctx).toContain('미정 룰 본문');
    expect(ctx).toContain('project-unknown');
    expect(ctx).not.toContain('repo-a 전용 룰');
    expect(ctx).toContain('## Project Rules');
    expect(ctx).toMatch(/repo-a 1/);
  });
  it('프롬프트가 repo-a 에서 오면 repo-a 룰을 한 번 넣는다', () => {
    const first = hook('context-guard', { session_id: sid, cwd: repoA, prompt: 'do it', hook_event_name: 'UserPromptSubmit' });
    expect(first.ctx).toContain('repo-a 전용 룰');
    expect(first.ctx).not.toContain('repo-b 전용 룰');
    expect(first.ctx).not.toContain('전역 룰 본문'); // 전역은 이미 세션 시작에 들어갔다
    const again = hook('context-guard', { session_id: sid, cwd: repoA, prompt: 'again', hook_event_name: 'UserPromptSubmit' });
    expect(again.ctx).toBe('');
  });
  it('홈에서 repo-b 파일을 만지면 도구 직후 repo-b 룰을 한 번 넣는다', () => {
    const r = hook('post-tool-use', { session_id: sid, cwd: home, tool_name: 'Read', tool_input: { file_path: path.join(repoB, 'src', 'x.ts') }, tool_response: 'ok', hook_event_name: 'PostToolUse' });
    expect(r.json.hookSpecificOutput?.hookEventName).toBe('PostToolUse');
    expect(r.ctx).toContain('repo-b 전용 룰');
    const again = hook('post-tool-use', { session_id: sid, cwd: home, tool_name: 'Read', tool_input: { file_path: path.join(repoB, 'src', 'y.ts') }, tool_response: 'ok' });
    expect(again.ctx).toBe('');
  });
  it('압축 뒤 세션 재시작이면 기록을 새로 시작해 다시 넣는다', () => {
    hook('session-recovery', { session_id: sid, cwd: home, source: 'compact', hook_event_name: 'SessionStart' });
    expect(hook('context-guard', { session_id: sid, cwd: repoA, prompt: 'p', hook_event_name: 'UserPromptSubmit' }).ctx).toContain('repo-a 전용 룰');
  });
  it('프로젝트 안에서 시작한 세션은 그 프로젝트를 다시 넣지 않는다', () => {
    const s2 = 'switch-sess-2';
    const start = hook('session-recovery', { session_id: s2, cwd: repoA, source: 'startup', hook_event_name: 'SessionStart' });
    expect(start.ctx).toContain('repo-a 전용 룰');
    expect(start.ctx).not.toContain('## Project Rules');
    expect(hook('context-guard', { session_id: s2, cwd: repoA, prompt: 'p', hook_event_name: 'UserPromptSubmit' }).ctx).toBe('');
  });
  it('색인은 별칭을 등록부 키로 합쳐 센다', () => {
    fs.writeFileSync(path.join(fhome, 'projects.json'), JSON.stringify({ version: 1, projects: { prod: { paths: [repoA], aliases: ['repo-a'] } } }));
    try {
      const { ctx } = hook('session-recovery', { session_id: 'switch-sess-idx', cwd: home, source: 'startup', hook_event_name: 'SessionStart' });
      expect(ctx).toMatch(/prod 1/);
      expect(hook('context-guard', { session_id: 'switch-sess-idx', cwd: repoA, prompt: 'p', hook_event_name: 'UserPromptSubmit' }).ctx).toContain('repo-a 전용 룰');
    } finally { fs.unlinkSync(path.join(fhome, 'projects.json')); }
  });
  it('서브에이전트 도구 호출은 주입하지 않는다', () => {
    const s3 = 'switch-sess-3';
    hook('session-recovery', { session_id: s3, cwd: home, source: 'startup', hook_event_name: 'SessionStart' });
    const r = hook('post-tool-use', { session_id: s3, agent_id: 'ag1', cwd: repoB, tool_name: 'Read', tool_input: { file_path: path.join(repoB, 'a') }, tool_response: 'ok' });
    expect(r.ctx).toBe('');
    expect(hook('context-guard', { session_id: s3, cwd: repoB, prompt: 'p', hook_event_name: 'UserPromptSubmit' }).ctx).toContain('repo-b 전용 룰');
  });
});
