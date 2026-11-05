/**
 * 컨텍스트 안내: 실제 사용량(statusline 페이로드·transcript usage)이 창 대비 높을 때만, 사용자에게 보이는 안내로만.
 * 실제 hook 프로세스와 statusline 프로세스를 돌린다 (대역 없음). 프롬프트 글자 수는 판단에 쓰지 않는다.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DIST = path.resolve(__dirname, '..', 'dist');
let root: string, home: string, forgen: string;
const env = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, FORGEN_HOME: forgen, FORGEN_SYNTHETIC: '1' });
const guard = (payload: object) => {
  const r = spawnSync(process.execPath, [path.join(DIST, 'hooks', 'context-guard.js')], { input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', ...payload }), encoding: 'utf-8', env: env(), timeout: 30_000 });
  return JSON.parse(r.stdout.trim().split('\n')[0]) as { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };
};
const statusline = (payload: object) => spawnSync(process.execPath, [path.join(DIST, 'cli.js'), 'statusline'], { input: JSON.stringify(payload), encoding: 'utf-8', env: env(), timeout: 30_000 });
const big = 'x'.repeat(130_000); // 예전 로직이라면 120K 문자 임계를 넘겨 "즉시 /compact" 지시가 나갔을 길이

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-ctx-')); home = path.join(root, 'home'); forgen = path.join(home, '.forgen');
  fs.mkdirSync(forgen, { recursive: true });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('context-guard 실제 사용량 기반 안내', () => {
  it('1M 창에서 12% 면 프롬프트가 아무리 길어도 아무 말도 하지 않는다 (작업 중단 지시 없음)', () => {
    statusline({ session_id: 's1', model: { id: 'claude-x', display_name: 'X' }, context_window: { used_percentage: 12, context_window_size: 1_000_000 } });
    const out = guard({ session_id: 's1', prompt: big });
    expect(out.systemMessage).toBeUndefined();
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it('창 대비 높으면(85%) 사용자에게만 보이는 안내를 내고 모델에는 아무것도 주입하지 않는다', () => {
    statusline({ session_id: 's2', context_window: { used_percentage: 85, context_window_size: 1_000_000 } });
    const out = guard({ session_id: 's2', prompt: '다음 작업' });
    expect(out.systemMessage).toContain('85%');
    expect(out.hookSpecificOutput).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/마무리하지 말|즉시|forgen-auto-compact/);
    // 쿨다운: 바로 다음 프롬프트에는 다시 내지 않는다
    expect(guard({ session_id: 's2', prompt: '다음' }).systemMessage).toBeUndefined();
  });

  it('사용량을 모르면(statusline 값·transcript 없음) 긴 프롬프트에도 지시하지 않는다', () => {
    const out = guard({ session_id: 's3', prompt: big });
    expect(out.systemMessage).toBeUndefined();
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it('transcript usage: 토큰이 200K 를 넘으면 1M 창으로 보고 비율을 낸다, 200K 이하는 모른다', () => {
    const line = (tokens: number) => `${JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 2, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: 10 } } })}\n`;
    const hi = path.join(root, 'hi.jsonl'); fs.writeFileSync(hi, line(100) + line(800_000));
    const lo = path.join(root, 'lo.jsonl'); fs.writeFileSync(lo, line(150_000));
    expect(guard({ session_id: 's4', prompt: 'a', transcript_path: hi }).systemMessage).toContain('80%');
    expect(guard({ session_id: 's5', prompt: 'a', transcript_path: lo }).systemMessage).toBeUndefined();
  });
});
