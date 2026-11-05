/**
 * D12-E: 모든 등록 hook 은 stdout 에 JSON 값 **하나**만 낸다 (C1 이중 출력, H10 비JSON 문구 회귀).
 * 격리 HOME 에서 실제 프로세스로 실행. 주입이 일어나는 입력과 일어나지 않는 입력을 둘 다 넣는다.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DIST = path.resolve(import.meta.dirname, '..', '..', 'dist');
const REG = path.resolve(import.meta.dirname, '..', '..', 'assets', 'shared', 'hook-registry.json');
const have = fs.existsSync(path.join(DIST, 'hooks', 'pre-tool-use.js'));
type Entry = { name: string; event: string; script: string };
const registry: Entry[] = JSON.parse(fs.readFileSync(REG, 'utf-8'));

let root: string; let home: string; let work: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-inv-'));
  home = path.join(root, 'home'); work = path.join(root, 'work');
  fs.mkdirSync(path.join(home, '.forgen', 'state'), { recursive: true }); fs.mkdirSync(work, { recursive: true });
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

const SID = '33333333-3333-4333-8333-333333333333';
function payloads(event: string): Array<[string, string]> {
  const base = { session_id: SID, cwd: '__WORK__', transcript_path: '__ROOT__/none.jsonl' };
  switch (event) {
    case 'UserPromptSubmit': return [
      ['주입 없음(짧은 프롬프트)', JSON.stringify({ ...base, prompt: 'hi' })],
      ['주입 후보(키워드·개발 프롬프트)', JSON.stringify({ ...base, prompt: 'autopilot: refactor the typescript hook rate-limiter and run tests, 코드 리뷰도 해줘' })],
    ];
    case 'SessionStart': return [['startup', JSON.stringify({ ...base, source: 'startup' })], ['resume', JSON.stringify({ ...base, source: 'resume' })]];
    case 'PreToolUse': return [['Bash', JSON.stringify({ ...base, tool_name: 'Bash', tool_input: { command: 'ls' } })], ['Read', JSON.stringify({ ...base, tool_name: 'Read', tool_input: { file_path: '/x' } })]];
    case 'PostToolUse': return [['Bash 객체 응답', JSON.stringify({ ...base, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a', stderr: '' } })], ['Write', JSON.stringify({ ...base, tool_name: 'Write', tool_input: { file_path: 'a.ts', content: 'x as any' }, tool_response: { type: 'create' } })]];
    case 'PostToolUseFailure': return [['fail', JSON.stringify({ ...base, tool_name: 'Bash', tool_input: { command: 'false' }, error: 'exit 1' })]];
    case 'PreCompact': return [['auto', JSON.stringify({ ...base, trigger: 'auto' })], ['manual', JSON.stringify({ ...base, trigger: 'manual' })]];
    case 'PermissionRequest': return [['Bash', JSON.stringify({ ...base, tool_name: 'Bash', tool_input: { command: 'ls' } })]];
    case 'Stop': return [['stop', JSON.stringify({ ...base, stop_hook_active: false, last_assistant_message: '작업 완료했습니다.' })]];
    case 'SubagentStart': case 'SubagentStop': return [['sub', JSON.stringify({ ...base, agent_id: 'a1', agent_type: 'executor' })]];
    case 'SessionEnd': return [['end', JSON.stringify({ ...base, reason: 'other' })]];
    default: return [['generic', JSON.stringify(base)]];
  }
}

describe.skipIf(!have)('hook stdout JSON 1개 불변식 (전 hook, 프로세스)', () => {
  const rows: Array<[string, string, string, string[]]> = [];
  for (const h of registry) {
    const [rel, ...args] = h.script.split(' ');
    for (const [label, payload] of payloads(h.event)) rows.push([`${h.name} / ${label}`, rel, payload, args]);
    rows.push([`${h.name} / 빈 stdin`, rel, '', args]);
    rows.push([`${h.name} / 깨진 JSON`, rel, '{not json', args]);
  }
  it.each(rows)('%s', (_n, rel, payload, args) => {
    const r = spawnSync(process.execPath, [path.join(DIST, rel), ...args], {
      input: payload.replaceAll('__WORK__', work).replaceAll('__ROOT__', root), encoding: 'utf-8', timeout: 20000, cwd: work,
      env: { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), FORGEN_NO_BLOCK_JUDGE: '1', FORGEN_NESTED_RUN: '', FORGEN_CWD: work },
    });
    expect(r.status, r.stderr.slice(0, 300)).toBe(0);
    const out = r.stdout.trim();
    expect(out.length).toBeGreaterThan(0);
    // JSON 값 정확히 하나: 통째로 parse 되어야 하고, 줄 단위 JSON 이 둘 이상이면 실패
    expect(() => JSON.parse(out), `stdout=${out.slice(0, 200)}`).not.toThrow();
    expect(out.split('\n').filter((l) => l.trim()).length === 1 || (() => { try { JSON.parse(out); return true; } catch { return false; } })()).toBe(true);
    const topLevelObjects = out.split('\n').filter((l) => l.trim().startsWith('{') && l.trim().endsWith('}')).length;
    expect(topLevelObjects).toBeLessThanOrEqual(1);
  });
});
