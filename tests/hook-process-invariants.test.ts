/**
 * 빌드된 hook 을 실제 프로세스로 실행해 고정하는 불변식.
 * - 설치 경로에 공백·한글이 있어도 hook 이 실제로 돈다 (출력 0바이트 = 룰 강제 소멸).
 * - 주입이 일어나도 stdout 은 JSON 1개다.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isMainModule } from '../src/hooks/shared/is-main.js';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(__dirname, '..');
const SID = '11111111-1111-4111-8111-111111111111';
let root: string;
let home: string;
let work: string;
let linkedDist: string;

function run(hookFile: string, payload: object) {
  return spawnSync(process.execPath, [hookFile], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    cwd: work,
    env: { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), FORGEN_CWD: work, FORGEN_SYNTHETIC: '1' },
  });
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-공백 경로-'));
  home = path.join(root, 'home');
  work = path.join(root, 'work');
  fs.mkdirSync(path.join(home, '.forgen', 'me', 'solutions'), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  linkedDist = path.join(root, 'dist');
  fs.symlinkSync(path.join(REPO, 'dist'), linkedDist, 'dir');
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(home, '.forgen', 'me', 'solutions', 'redis-cache-ttl.md'), `---
name: redis-cache-ttl
version: 1
status: verified
confidence: 0.8
type: pattern
scope: me
tags: [redis, cache, ttl]
identifiers: [RedisCacheTtl]
evidence: {injected: 0, reflected: 0, negative: 0, sessions: 0, reExtracted: 0}
created: 2026-11-01
updated: 2026-11-01
supersedes: null
extractedBy: manual
---
## Context
redis cache ttl 을 다룰 때 적용하는 패턴. 픽스처라 내용은 중요하지 않지만 최소 길이는 넘긴다.
`);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('isMainModule', () => {
  it('공백·한글 경로와 심링크를 같은 파일로 판정', () => {
    const real = path.join(root, '실제 파일.js');
    const link = path.join(root, 'link.js');
    fs.writeFileSync(real, '');
    fs.symlinkSync(real, link);
    const url = pathToFileURL(real).href;
    expect(isMainModule(url, real)).toBe(true);
    expect(isMainModule(url, link)).toBe(true);
    expect(isMainModule(url, path.join(root, 'other.js'))).toBe(false);
    expect(isMainModule(url, undefined)).toBe(false);
  });
});

describe.each([
  ['stop-guard.js', { session_id: SID, cwd: '', stop_hook_active: false, last_assistant_message: '확인했습니다', hook_event_name: 'Stop' }],
  ['subagent-tracker.js', { session_id: SID, cwd: '', agent_type: 'explore', agent_id: 'a1', hook_event_name: 'SubagentStart' }],
  ['subagent-stop-guard.js', { session_id: SID, cwd: '', agent_type: 'explore', agent_id: 'a1', hook_event_name: 'SubagentStop' }],
])('%s: 공백·한글·심링크 경로에서도 실행된다', (name, payload) => {
  it('stdout 이 비어 있지 않고 유효한 JSON', () => {
    const r = run(path.join(linkedDist, 'hooks', name), { ...payload, cwd: work });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
    expect(() => JSON.parse(r.stdout.trim().split('\n').at(-1) as string)).not.toThrow();
  });
});

describe('solution-injector', () => {
  it('주입이 일어나도 stdout 은 JSON 1개', () => {
    const r = run(path.join(REPO, 'dist', 'hooks', 'solution-injector.js'), {
      session_id: SID, cwd: work, prompt: 'redis cache ttl RedisCacheTtl 어떻게 해?', hook_event_name: 'UserPromptSubmit',
    });
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).hookSpecificOutput?.additionalContext).toContain('redis-cache-ttl');
  });
});
