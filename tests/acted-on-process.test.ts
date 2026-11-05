/**
 * D6 acted_on 신뢰: 어떤 신호가 실제로 돌고 오탐은 없는지 프로세스로 검증한다.
 * 실제 hook 프로세스(solution-injector, post-tool-use)와 관측 DB(sessions.db)를 쓴다. 대역 없음.
 *  - prompt-keyword: 제거됨 (사용자의 다음 프롬프트가 주제를 이어 말하는 것은 행동이 아니다)
 *  - tool-pattern: 도구 이름이 아니라 도구가 실제 건드린 경로·명령·내용에서, 식별자 또는 흔하지 않은 태그 2개 이상
 *  - commit-diff: 추가된 줄에서 같은 기준
 *  - 응답 인용: 구현되어 있지 않음 (별도 신호 없음)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

const DIST = path.resolve(__dirname, '..', 'dist');
let root: string, home: string, forgen: string, work: string;
const env = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, FORGEN_HOME: forgen, FORGEN_SYNTHETIC: '1', FORGEN_CWD: work, FORGEN_NO_BLOCK_JUDGE: '1' });

function hook(name: string, payload: object) {
  return spawnSync(process.execPath, [path.join(DIST, 'hooks', name)], { input: JSON.stringify({ cwd: work, ...payload }), encoding: 'utf-8', cwd: work, env: env(), timeout: 60_000 });
}
function events(type: string): Array<{ solution_id: string; signal_source: string; meta: string | null }> {
  const db = new DatabaseSync(path.join(forgen, 'sessions.db'));
  try { return db.prepare('SELECT solution_id, signal_source, meta FROM solution_events WHERE event_type = ?').all(type) as never; } finally { db.close(); }
}
function writeSolution(name: string, tags: string[], identifiers: string[] = []) {
  const md = ['---', `name: ${name}`, 'version: 1', 'status: candidate', 'confidence: 0.9', 'type: pattern', 'scope: me',
    'tags:', ...tags.map((t) => `  - ${JSON.stringify(t)}`), `identifiers: ${identifiers.length ? JSON.stringify(identifiers) : '[]'}`,
    'evidence:', '  injected: 0', '  reflected: 0', '  negative: 0', '  sessions: 0', '  reExtracted: 0',
    'created: 2026-11-01', 'updated: 2026-11-01', 'supersedes: null', 'extractedBy: manual', '---', '', '## Context', '', '', '## Content',
    '레디스 캐시 무효화는 ttl 을 짧게 두고 invalidate 시점을 명시한다. 근거와 주의를 포함한 충분히 긴 본문입니다.', ''].join('\n');
  fs.writeFileSync(path.join(forgen, 'me', 'solutions', `${name}.md`), md);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-acted-'));
  home = path.join(root, 'home'); forgen = path.join(home, '.forgen'); work = path.join(root, 'work');
  fs.mkdirSync(path.join(forgen, 'me', 'solutions'), { recursive: true }); fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(forgen, 'forge-profile.json'), '{}');
  writeSolution('redis-cache-invalidate', ['redis', 'invalidate', 'ttl', 'cache'], ['CacheManager']);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const SID = 'acted-1';
const surface = () => {
  hook('solution-injector.js', { session_id: SID, prompt: 'redis cache invalidate ttl 정책을 어떻게 잡을까', hook_event_name: 'UserPromptSubmit' });
  expect(events('surfaced').map((e) => e.solution_id)).toContain('redis-cache-invalidate');
};

describe('acted_on 신호 검증 (D6)', () => {
  it('prompt-keyword: 다음 프롬프트가 같은 주제를 말해도 acted_on 이 생기지 않는다', () => {
    surface();
    hook('solution-injector.js', { session_id: SID, prompt: 'redis invalidate ttl 에 대해 더 설명해줘', hook_event_name: 'UserPromptSubmit' });
    expect(events('acted_on')).toEqual([]);
  }, 120_000);

  it('tool-pattern: 도구 이름만 겹치거나 태그가 1개뿐이면 기록하지 않는다', () => {
    surface();
    hook('post-tool-use.js', { session_id: SID, tool_name: 'redis', tool_input: { command: 'ls' }, tool_response: 'ok', hook_event_name: 'PostToolUse' });
    hook('post-tool-use.js', { session_id: SID, tool_name: 'Edit', tool_input: { file_path: 'src/app.ts', new_string: 'const redis = 1;' }, tool_response: 'ok', hook_event_name: 'PostToolUse' });
    expect(events('acted_on')).toEqual([]);
  }, 120_000);

  it('tool-pattern: 흔하지 않은 태그 2개 이상, 또는 식별자가 실제 작업 내용에 있으면 기록한다', () => {
    surface();
    hook('post-tool-use.js', { session_id: SID, tool_name: 'Edit', tool_input: { file_path: 'src/cache.ts', new_string: 'await redis.set(k, v, { ttl: 30 });' }, tool_response: 'ok', hook_event_name: 'PostToolUse' });
    const got = events('acted_on');
    expect(got.map((e) => e.signal_source)).toEqual(['tool-pattern']);
    expect(got[0].solution_id).toBe('redis-cache-invalidate');
    // 식별자 단독
    fs.rmSync(path.join(forgen, 'sessions.db'), { force: true });
    surface2();
    function surface2() { hook('solution-injector.js', { session_id: 'acted-2', prompt: 'redis cache invalidate ttl 정책을 어떻게 잡을까', hook_event_name: 'UserPromptSubmit' }); }
    hook('post-tool-use.js', { session_id: 'acted-2', tool_name: 'Edit', tool_input: { file_path: 'src/x.ts', new_string: 'new CacheManager()' }, tool_response: 'ok', hook_event_name: 'PostToolUse' });
    expect(events('acted_on').map((e) => e.signal_source)).toEqual(['tool-pattern']);
  }, 180_000);

  it('commit-diff: 추가된 줄에 증거가 있을 때만 기록하고, 삭제된 줄·메시지의 단어는 무시한다', async () => {
    surface();
    const git = (...a: string[]) => execFileSync('git', a, { cwd: work, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git('init', '-q');
    const startedAt = Date.now() - 60_000;
    fs.writeFileSync(path.join(work, 'a.ts'), 'export const a = 1;\n');
    git('add', '.'); git('commit', '-qm', 'redis invalidate ttl notes'); // 메시지에만 증거
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { scanCommitDiffForActedOn } from ${JSON.stringify(path.join(DIST, 'core', 'spawn.js'))};
      await scanCommitDiffForActedOn(${JSON.stringify(SID)}, ${JSON.stringify(work)}, ${startedAt});`], { encoding: 'utf-8', env: env() });
    run();
    expect(events('acted_on')).toEqual([]);
    fs.writeFileSync(path.join(work, 'b.ts'), 'redis.set(key, value, { ttl: 10 });\n');
    git('add', '.'); git('commit', '-qm', 'add cache write');
    run();
    expect(events('acted_on').map((e) => e.signal_source)).toEqual(['commit-diff']);
  }, 180_000);
});
