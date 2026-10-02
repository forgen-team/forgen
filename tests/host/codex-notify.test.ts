/**
 * ADR-016 D1 — Codex notify 폴백 + 훅 생존 마커 + rollout 헬퍼
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const tmpRoot = path.join(os.tmpdir(), `forgen-codex-notify-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const stateDir = path.join(tmpRoot, 'forgen', 'state');
const codexHome = path.join(tmpRoot, 'codex');

vi.mock('../../src/core/paths.js', () => ({
  STATE_DIR: stateDir,
  FORGEN_HOME: path.join(stateDir, '..'),
}));

// Must import AFTER mock setup
const { markCodexHookAlive, isCodexHookAlive, readCodexHookAlive, CODEX_HOOK_ALIVE_WINDOW_MS } = await import('../../src/host/codex-hook-alive.js');
const { handleNotify, parseNotifyArgv, readCodexHooksSilent, CODEX_HOOKS_SILENT_PATH } = await import('../../src/host/codex-notify.js');
const { findCodexRollout, countCodexUserPrompts } = await import('../../src/host/codex-rollout.js');

const THREAD = '01a0fa9f-935c-77c1-929f-58c6f496b18c';
const payload = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'agent-turn-complete',
  'thread-id': THREAD,
  'turn-id': '01a0fa9f-9455-7000-8000-000000000000',
  cwd: tmpRoot,
  client: 'codex_exec',
  'input-messages': ['hi'],
  'last-assistant-message': 'pong',
  ...over,
});

/** 실 rollout 과 같은 compact JSONL: 프롬프트마다 event_msg/user_message + 무거운 tool 출력. */
function writeRollout(prompts: number, opts: { padBytes?: number } = {}): string {
  const dir = path.join(codexHome, 'sessions', '2026', '10', '02');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-02T03-19-17-${THREAD}.jsonl`);
  const lines: string[] = [JSON.stringify({ type: 'session_meta', payload: { id: THREAD } })];
  for (let i = 0; i < prompts; i += 1) {
    lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: `prompt ${i}` } }));
    lines.push(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: `prompt ${i}` } }));
    // 문자열 값 안의 같은 텍스트는 따옴표가 이스케이프되므로 세지 않아야 한다
    lines.push(JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: `{"type":"user_message"} ${'x'.repeat(opts.padBytes ?? 10)}` } }));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

beforeEach(() => {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('codex-hook-alive 마커', () => {
  it('턴 경계 이벤트(Stop/SubagentStop/UserPromptSubmit)만 기록한다', () => {
    expect(markCodexHookAlive({ hook_event_name: 'PreToolUse', session_id: 's' }, 1000)).toBe(false);
    expect(readCodexHookAlive()).toBeNull();
    expect(markCodexHookAlive({ hook_event_name: 'Stop', session_id: 's' }, 1000)).toBe(true);
    expect(readCodexHookAlive()).toEqual({ at: 1000, event: 'Stop', sessionId: 's' });
    expect(markCodexHookAlive({ hook_event_name: 'SubagentStop' }, 2000)).toBe(true);
    expect(markCodexHookAlive({ hookEventName: 'UserPromptSubmit' }, 3000)).toBe(true);
    expect(readCodexHookAlive()?.at).toBe(3000);
  });

  it('빈/비객체 입력은 no-op, 신선도는 window 로 판정', () => {
    expect(markCodexHookAlive(null)).toBe(false);
    expect(markCodexHookAlive({})).toBe(false);
    expect(isCodexHookAlive(5000)).toBe(false); // 마커 없음
    markCodexHookAlive({ hook_event_name: 'Stop' }, 10_000);
    expect(isCodexHookAlive(10_000 + CODEX_HOOK_ALIVE_WINDOW_MS - 1)).toBe(true);
    expect(isCodexHookAlive(10_000 + CODEX_HOOK_ALIVE_WINDOW_MS)).toBe(false);
    expect(isCodexHookAlive(9_000)).toBe(false); // 미래 마커(시계 역행)는 신뢰하지 않음
  });
});

describe('parseNotifyArgv', () => {
  it('페이로드는 마지막 argv, `--` 뒤는 체인 프로그램', () => {
    expect(parseNotifyArgv([])).toEqual({ chain: [], payloadRaw: null, payload: null });
    const p = payload();
    expect(parseNotifyArgv([p]).payload?.['thread-id']).toBe(THREAD);
    const chained = parseNotifyArgv(['--', 'terminal-notifier', '-title', 'codex', p]);
    expect(chained.chain).toEqual(['terminal-notifier', '-title', 'codex']);
    expect(chained.payload?.type).toBe('agent-turn-complete');
    // `--` 없이 붙은 여분 인자는 체인으로 실행하지 않는다
    expect(parseNotifyArgv(['extra', p]).chain).toEqual([]);
  });

  it('JSON 이 아니거나 객체가 아니면 payload=null', () => {
    expect(parseNotifyArgv(['not json']).payload).toBeNull();
    expect(parseNotifyArgv(['[1,2]']).payload).toBeNull();
  });
});

describe('codex-rollout 헬퍼', () => {
  it('findCodexRollout — thread id 로 최근 날짜 디렉토리에서 찾는다', () => {
    const file = writeRollout(1);
    expect(findCodexRollout(codexHome, THREAD)).toBe(file);
    expect(findCodexRollout(codexHome, '00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(findCodexRollout(codexHome, '../etc/passwd')).toBeNull(); // 형식 검증
    expect(findCodexRollout(path.join(tmpRoot, 'nope'), THREAD)).toBeNull();
  });

  it('countCodexUserPrompts — 실제 프롬프트만 센다 (role=user 주입·문자열 내부 텍스트 제외)', () => {
    expect(countCodexUserPrompts(writeRollout(12))).toBe(12);
  });

  it('countCodexUserPrompts — 청크 경계를 넘는 큰 파일에서도 정확하고 빠르다', () => {
    const file = writeRollout(40, { padBytes: 150_000 }); // ~6MB → 1MB 청크 여러 개
    expect(fs.statSync(file).size).toBeGreaterThan(4 * 1024 * 1024);
    const t0 = Date.now();
    expect(countCodexUserPrompts(file)).toBe(40);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('countCodexUserPrompts — maxBytes 까지만 읽는다 (하한 추정)', () => {
    const file = writeRollout(40, { padBytes: 150_000 });
    const partial = countCodexUserPrompts(file, 1024 * 1024);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(40);
  });
});

describe('handleNotify', () => {
  const env = { CODEX_HOME: codexHome } as NodeJS.ProcessEnv;

  it('forgen 자신의 추출용 중첩 실행이면 아무것도 하지 않는다', async () => {
    const spawnCompound = vi.fn(async () => true);
    writeRollout(20);
    expect(await handleNotify([payload()], { env: { ...env, FORGEN_NESTED_RUN: '1' }, spawnCompound })).toBe('nested-run');
    expect(spawnCompound).not.toHaveBeenCalled();
    expect(fs.existsSync(CODEX_HOOKS_SILENT_PATH)).toBe(false);
  });

  it('페이로드 없음 / 다른 이벤트 타입은 무시', async () => {
    expect(await handleNotify([], { env })).toBe('no-payload');
    expect(await handleNotify(['garbage'], { env })).toBe('no-payload');
    expect(await handleNotify([payload({ type: 'approval-requested' })], { env })).toBe('ignored-event');
    expect(fs.existsSync(CODEX_HOOKS_SILENT_PATH)).toBe(false);
  });

  it('훅이 살아 있으면 silent 플래그를 지우고 auto-compound 를 띄우지 않는다 (Stop 훅 소관)', async () => {
    const spawnCompound = vi.fn(async () => true);
    writeRollout(20);
    fs.writeFileSync(CODEX_HOOKS_SILENT_PATH, JSON.stringify({ detectedAt: new Date(50_000).toISOString(), sessionId: 'old', cwd: '/', count: 3 }));
    markCodexHookAlive({ hook_event_name: 'Stop', session_id: THREAD }, 100_000);
    expect(await handleNotify([payload()], { env, now: 101_000, spawnCompound })).toBe('hooks-alive');
    expect(spawnCompound).not.toHaveBeenCalled();
    expect(fs.existsSync(CODEX_HOOKS_SILENT_PATH)).toBe(false);
  });

  it('훅이 돌지 않았고 세션이 짧으면 silent 만 기록 (연속 관측 횟수 누적)', async () => {
    const spawnCompound = vi.fn(async () => true);
    writeRollout(3);
    const now = Date.now();
    expect(await handleNotify([payload()], { env, now, spawnCompound })).toBe('silent-recorded');
    expect(await handleNotify([payload()], { env, now: now + 1000, spawnCompound })).toBe('silent-recorded');
    expect(spawnCompound).not.toHaveBeenCalled();
    const silent = readCodexHooksSilent(now + 2000);
    expect(silent?.sessionId).toBe(THREAD);
    expect(silent?.count).toBe(2);
    expect(silent?.cwd).toBe(tmpRoot);
  });

  it('훅이 돌지 않았고 프롬프트 ≥10 이면 Stop 과 같은 디바운스 경로로 auto-compound 를 띄운다', async () => {
    const spawnCompound = vi.fn(async () => true);
    const rollout = writeRollout(12);
    expect(await handleNotify([payload()], { env, spawnCompound })).toBe('silent-compound-spawned');
    expect(spawnCompound).toHaveBeenCalledWith(THREAD, rollout, 12, tmpRoot);
  });

  it('디바운스가 skip 하면(쿨다운/in-flight) silent-recorded', async () => {
    writeRollout(12);
    expect(await handleNotify([payload()], { env, spawnCompound: async () => false })).toBe('silent-recorded');
  });

  it('rollout 을 못 찾거나 trigger 가 던져도 fail-open', async () => {
    expect(await handleNotify([payload()], { env, spawnCompound: async () => true })).toBe('silent-recorded'); // rollout 없음
    writeRollout(12);
    expect(await handleNotify([payload()], { env, spawnCompound: async () => { throw new Error('boom'); } })).toBe('silent-recorded');
  });

  it('오래된(>24h) alive 마커는 alive 가 아니다; 오래된 silent 관측은 doctor 에 노출되지 않는다', async () => {
    markCodexHookAlive({ hook_event_name: 'Stop' }, 1000);
    writeRollout(1);
    const now = 1000 + 25 * 60 * 60 * 1000;
    expect(await handleNotify([payload()], { env, now })).toBe('silent-recorded');
    expect(readCodexHooksSilent(now)?.count).toBe(1);
    expect(readCodexHooksSilent(now + 25 * 60 * 60 * 1000)).toBeNull();
  });

  it('체인 프로그램에 페이로드를 그대로 전달한다', async () => {
    const out = path.join(tmpRoot, 'chain-out.txt');
    const script = path.join(tmpRoot, 'chain.cjs');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(out)}, process.argv.slice(2).join('\\n'));`);
    const p = payload();
    markCodexHookAlive({ hook_event_name: 'Stop' });
    expect(await handleNotify(['--', process.execPath, script, 'extra-arg', p], { env })).toBe('hooks-alive');
    for (let i = 0; i < 100 && !fs.existsSync(out); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(fs.readFileSync(out, 'utf-8')).toBe(`extra-arg\n${p}`);
  });

  it('존재하지 않는 체인 프로그램은 조용히 무시', async () => {
    markCodexHookAlive({ hook_event_name: 'Stop' });
    expect(await handleNotify(['--', '/nonexistent/forgen-test-notifier', payload()], { env })).toBe('hooks-alive');
  });
});
