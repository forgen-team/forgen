/** 명령 프롬프트(`/`, `!`)는 솔루션 회수에서 제외. 빌드된 hook 을 격리 HOME 에서 실제로 실행한다. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HOOK = path.resolve(__dirname, '..', 'dist', 'hooks', 'solution-injector.js');
let root: string, home: string, work: string;

function run(prompt: string, sid: string): string {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: sid, prompt, cwd: work, hook_event_name: 'UserPromptSubmit' }),
    encoding: 'utf-8', cwd: work,
    env: { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), FORGEN_SYNTHETIC: '1', FORGEN_CWD: work, FORGEN_NO_BLOCK_JUDGE: '1' },
    timeout: 60_000,
  });
  return JSON.parse(r.stdout.trim().split('\n')[0]).hookSpecificOutput?.additionalContext ?? '';
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-cmdprompt-'));
  home = path.join(root, 'home'); work = path.join(root, 'work');
  const dir = path.join(home, '.forgen', 'me', 'solutions');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(home, '.forgen', 'forge-profile.json'), '{}');
  fs.writeFileSync(path.join(dir, 'zebra-quartz-fix.md'), ['---', 'name: zebra-quartz-fix', 'version: 1', 'status: verified', 'confidence: 0.9', 'type: pattern', 'scope: me',
    'tags:', '  - "zebra"', '  - "quartz"', '  - "marmalade"', 'identifiers: []', 'evidence:', '  injected: 0', '  reflected: 0', '  negative: 0', '  sessions: 0', '  reExtracted: 0',
    'created: 2026-11-01', 'updated: 2026-11-01', 'supersedes: null', 'extractedBy: manual', '---', '', '## Context', 'zebra quartz marmalade 상황', '', '## Content',
    'zebra quartz marmalade 에서는 이렇게 한다. 충분히 긴 본문이다.', ''].join('\n'));
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('솔루션 회수: 명령 프롬프트 제외', () => {
  const body = 'zebra quartz marmalade 문제를 해결해줘';
  it('대조군: 일반 프롬프트는 회수된다', () => {
    expect(run(body, 'sid-plain')).toContain('zebra-quartz-fix');
  }, 90_000);
  it.each([`/review ${body}`, `!echo ${body}`, `  /compact ${body}`])('명령 %s 는 회수하지 않는다', (p) => {
    expect(run(p, `sid-${p.length}`)).not.toContain('zebra-quartz-fix');
  }, 90_000);
  it('경로로 시작하는 프롬프트는 명령이 아니다', () => {
    expect(run(`/tmp/x/y.ts 에서 ${body}`, 'sid-path')).toContain('zebra-quartz-fix');
  }, 90_000);
});
