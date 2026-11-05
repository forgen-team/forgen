/**
 * acted_on 실제 흐름 재생: 주입(solution-injector) → 관련 Edit(post-tool-use) 프로세스를 그대로 돌린다. 대역 없음.
 * 확인: me 가 아닌 팩·프로젝트 솔루션도 acted_on 이 생기고, 2글자 한글 태그·camelCase/snake_case 식별 표기가 세어지며,
 * 무관한 Edit 에서는 생기지 않는다.
 */
import { spawnSync } from 'node:child_process';
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
function acted(): string[] {
  const db = new DatabaseSync(path.join(forgen, 'sessions.db'));
  try { return (db.prepare("SELECT solution_id FROM solution_events WHERE event_type = 'acted_on'").all() as Array<{ solution_id: string }>).map((r) => r.solution_id); } finally { db.close(); }
}
function surfaced(): string[] {
  const db = new DatabaseSync(path.join(forgen, 'sessions.db'));
  try { return (db.prepare("SELECT solution_id FROM solution_events WHERE event_type = 'surfaced'").all() as Array<{ solution_id: string }>).map((r) => r.solution_id); } finally { db.close(); }
}
function write(dir: string, name: string, tags: string[], body: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), ['---', `name: ${name}`, 'version: 1', 'status: candidate', 'confidence: 0.9', 'type: pattern', 'scope: me', 'tags:',
    ...tags.map((t) => `  - ${JSON.stringify(t)}`), 'identifiers: []', 'evidence:', '  injected: 0', '  reflected: 0', '  negative: 0', '  sessions: 0', '  reExtracted: 0',
    'created: 2026-11-01', 'updated: 2026-11-01', 'supersedes: null', 'extractedBy: manual', '---', '', '## Context', '', '', '## Content', body, ''].join('\n'));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-actedreplay-'));
  home = path.join(root, 'home'); forgen = path.join(home, '.forgen'); work = path.join(root, 'work');
  fs.mkdirSync(path.join(forgen, 'me', 'solutions'), { recursive: true }); fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(forgen, 'forge-profile.json'), '{}');
  const body = '무효화 시점을 명시하고 만료를 짧게 둔다. 근거와 주의를 포함한 충분히 긴 본문이라서 길이 조건을 넘긴다.';
  write(path.join(forgen, 'me', 'solutions'), 'me-ko-cache', ['캐시', '무효화', '레디스'], body);
  write(path.join(forgen, 'packs', 'starter', 'solutions'), 'pack-queue-retry', ['retry', 'backoff', 'queue'], '재시도는 지수 백오프로 하고 큐에 다시 넣는다. 근거와 주의를 포함한 충분히 긴 본문이라서 길이 조건을 넘긴다.');
  write(path.join(work, '.compound', 'solutions'), 'proj-test-double', ['test-double', 'snake-case', 'fixture'], '테스트 대역은 합성으로 만든다. 근거와 주의를 포함한 충분히 긴 본문이라서 길이 조건을 넘긴다.');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const prompt = (sid: string, p: string) => hook('solution-injector.js', { session_id: sid, prompt: p, hook_event_name: 'UserPromptSubmit' });
const edit = (sid: string, file: string, text: string) => hook('post-tool-use.js', { session_id: sid, tool_name: 'Edit', tool_input: { file_path: file, new_string: text }, tool_response: 'ok', hook_event_name: 'PostToolUse' });

describe('acted_on 실제 흐름 재생', () => {
  it('2글자 한글 태그 2개 이상이 Edit 내용에 있으면 기록, 무관한 Edit 은 기록하지 않는다', () => {
    prompt('s-ko', '레디스 캐시 무효화 정책을 어떻게 잡지');
    expect(surfaced()).toContain('me-ko-cache');
    edit('s-ko', 'src/readme.ts', 'export const title = "hello";');
    expect(acted()).toEqual([]);
    edit('s-ko', 'src/cache.ts', '// 캐시 무효화 시점 처리\nexport const x = 1;');
    expect(acted()).toEqual(['me-ko-cache']);
  }, 120_000);

  it('팩 솔루션도 acted_on 이 기록된다', () => {
    prompt('s-pack', 'queue retry backoff 정책을 어떻게 잡지');
    expect(surfaced()).toContain('pack-queue-retry');
    edit('s-pack', 'src/other.ts', 'const unrelated = 1;');
    expect(acted()).toEqual([]);
    edit('s-pack', 'src/worker.ts', 'await queue.add(job, { retry: 3, backoff: 500 });');
    expect(acted()).toEqual(['pack-queue-retry']);
  }, 120_000);

  it('프로젝트 솔루션 + camelCase/snake_case 표기 태그가 기록된다', () => {
    prompt('s-proj', 'test double fixture 를 합성으로 만들려고 해');
    expect(surfaced()).toContain('proj-test-double');
    edit('s-proj', 'tests/x.test.ts', 'const loremIpsum = 1;');
    expect(acted()).toEqual([]);
    edit('s-proj', 'tests/x.test.ts', 'function makeTestDouble() { return buildFixture(); } // snake_case: test_double');
    expect(acted()).toEqual(['proj-test-double']);
  }, 120_000);
});
