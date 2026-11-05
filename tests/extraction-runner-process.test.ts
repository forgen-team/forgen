/**
 * 5단계 리뷰 지적(A) 프로세스 검증. 빌드된 auto-compound-runner 를 실제 프로세스로 실행한다.
 * 대역은 PATH 의 `claude` 실행 파일뿐이다(tests/helpers/fake-claude.ts) — 러너·큐·락·커서·훅은 전부 실물이다.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeClaude, readCalls } from './helpers/fake-claude';

const DIST = path.resolve(__dirname, '..', 'dist');
let root: string, home: string, forgen: string, fakeState: string, bin: string, cwd: string, transcript: string;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, FORGEN_HOME: forgen, FAKE_STATE: fakeState, PATH: `${bin}:${process.env.PATH}`,
    FORGEN_SYNTHETIC: '1', FORGEN_NO_BLOCK_JUDGE: '1', CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    ...extra,
  };
  delete e.ANTHROPIC_API_KEY; delete e.FORGEN_NO_AUTO_COMPOUND; delete e.FORGEN_AUTO_COMPOUND;
  return { ...e, ...extra };
}

function line(role: 'user' | 'assistant', text: string): string {
  return JSON.stringify(role === 'user'
    ? { type: 'user', message: { role: 'user', content: text } }
    : { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
}
function writeTranscript(userMsgs: number, eol = '\n'): number {
  const lines: string[] = [];
  for (let i = 0; i < userMsgs; i++) {
    lines.push(line('user', `${i}번째 요청입니다. 로그인 처리 흐름을 정리하고 세션 만료 시 재시도 방식을 같이 설계해 주세요. 상세 조건은 다음과 같습니다: 토큰 갱신 실패 시 사용자에게 보여 줄 문구, 재시도 횟수 상한, 동시 요청이 겹칠 때 갱신을 한 번만 하도록 묶는 방법도 포함해 주세요.`));
    lines.push(line('assistant', `${i}번째 답변입니다. 세션 만료가 감지되면 토큰을 갱신하고 실패하면 한 번만 재시도하며, 재시도 사이에는 지연을 두는 방식을 제안합니다.`));
  }
  fs.writeFileSync(transcript, lines.join(eol) + eol);
  return fs.statSync(transcript).size;
}

function runner(sid: string, opts: { final?: boolean; extra?: Record<string, string> } = {}) {
  return spawnSync(process.execPath, [path.join(DIST, 'core', 'auto-compound-runner.js'), cwd, transcript, sid, '5', ...(opts.final ? ['final'] : [])], {
    encoding: 'utf-8', cwd, env: env(opts.extra), timeout: 120_000,
  });
}
function runnerAsync(sid: string, extra: Record<string, string> = {}): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(DIST, 'core', 'auto-compound-runner.js'), cwd, transcript, sid, '5'], { cwd, env: env(extra) });
    let stderr = '';
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => resolve({ status, stderr }));
  });
}
function queueFn<T>(expr: string): T {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import * as q from ${JSON.stringify(path.join(DIST, 'core', 'extraction-queue.js'))}; console.log(JSON.stringify(${expr}));`], { encoding: 'utf-8', env: env() });
  return JSON.parse(r.stdout.trim().split('\n').pop() ?? 'null') as T;
}
const events = (): Array<Record<string, unknown>> => {
  try { return fs.readFileSync(path.join(forgen, 'state', 'extraction-events.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const solutionFiles = (): string[] => { try { return fs.readdirSync(path.join(forgen, 'me', 'solutions')).filter((f) => f.endsWith('.md')); } catch { return []; } };
const login = (on: boolean) => { const f = path.join(fakeState, 'loggedin'); if (on) fs.writeFileSync(f, '1'); else fs.rmSync(f, { force: true }); };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-runner-'));
  home = path.join(root, 'home'); forgen = path.join(home, '.forgen'); fakeState = path.join(root, 'fake'); bin = path.join(root, 'bin');
  cwd = path.join(root, 'proj'); transcript = path.join(root, 'sess.jsonl');
  fs.mkdirSync(path.join(forgen, 'me'), { recursive: true }); fs.mkdirSync(fakeState, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(forgen, 'me', 'forge-profile.json'), '{}'); // 학습 단계도 호출되게
  installFakeClaude(bin);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('A1 유실: 못 넘긴 구간은 나중에 처리된다', () => {
  it('미로그인으로 못 넘긴 구간이 로그인 뒤 같은 크기 transcript 에서 처리된다', () => {
    const size = writeTranscript(4);
    const r1 = runner('s-login');
    expect(r1.status).toBe(0);
    expect(readCalls(fakeState)).toEqual([]); // 호출 없음
    expect(solutionFiles()).toEqual([]);
    // 크기는 그대로인데 못 넘긴 구간이 남아 있으므로 다시 돌려야 한다(로그인 직후, 사유 재시도 간격 전에도 로그인 상태 확인은 러너가 한다)
    expect(queueFn<boolean>(`q.sessionNeedsRun('s-login', ${size}, { now: Date.now() + 2 * 3600_000 })`)).toBe(true);
    login(true);
    const r2 = runner('s-login');
    expect(r2.status).toBe(0);
    expect(readCalls(fakeState).length).toBeGreaterThanOrEqual(3);
    expect(solutionFiles()).toContain('fake-process-title.md');
    // 처리를 마쳤으니 더는 필요 없다
    expect(queueFn<boolean>(`q.sessionNeedsRun('s-login', ${size})`)).toBe(false);
  }, 180_000);

  it('동의 OFF 동안은 러너를 띄울 필요가 없고, 켜면 같은 구간을 처리한다', () => {
    login(true);
    const size = writeTranscript(4);
    const r1 = runner('s-consent', { extra: { FORGEN_NO_AUTO_COMPOUND: '1' } });
    expect(r1.status).toBe(0);
    expect(readCalls(fakeState)).toEqual([]);
    expect(queueFn<boolean>(`q.sessionNeedsRun('s-consent', ${size}, { consentEnabled: false })`)).toBe(false); // 여전히 OFF → 불필요한 spawn 없음
    expect(queueFn<boolean>(`q.sessionNeedsRun('s-consent', ${size}, { consentEnabled: true })`)).toBe(true); // 켜졌다 → 다시 처리
    const r2 = runner('s-consent');
    expect(r2.status).toBe(0);
    expect(readCalls(fakeState).length).toBeGreaterThanOrEqual(3);
  }, 180_000);

  it('Stop 이 너무 적다며 미룬 마지막 구간을 세션 종료(final)가 처리한다', () => {
    login(true);
    const size = writeTranscript(1); // 새 사용자 발화 1개 < 3, 교정 후보 없음 → partial-too-small
    runner('s-final');
    expect(readCalls(fakeState)).toEqual([]);
    expect(events().some((e) => e.skipped === 'partial-too-small')).toBe(true);
    expect(queueFn<boolean>(`q.sessionNeedsRun('s-final', ${size})`)).toBe(true); // 안 자랐어도 남은 구간이 있다
    runner('s-final', { final: true });
    expect(readCalls(fakeState).length).toBeGreaterThanOrEqual(3);
    expect(queueFn<boolean>(`q.sessionNeedsRun('s-final', ${size})`)).toBe(false);
  }, 180_000);

  it('같은 크기로 내용이 교체되면 다시 처리 대상이고 커서가 처음으로 돌아간다', () => {
    login(true);
    const size = writeTranscript(4);
    runner('s-swap', { final: true });
    const sig = queueFn<string>(`q.transcriptSignature(${JSON.stringify(transcript)})`);
    expect(queueFn<boolean>(`q.sessionNeedsRun('s-swap', ${size}, { sig: ${JSON.stringify(sig)} })`)).toBe(false);
    const swapped = fs.readFileSync(transcript, 'utf-8').replace(/로그인/g, '결제 처'); // 같은 바이트 수가 되도록 아래에서 맞춘다
    const pad = size - Buffer.byteLength(swapped);
    fs.writeFileSync(transcript, pad >= 0 ? swapped + ' '.repeat(pad) : swapped.slice(0, swapped.length + pad));
    expect(fs.statSync(transcript).size).toBe(size);
    const sig2 = queueFn<string>(`q.transcriptSignature(${JSON.stringify(transcript)})`);
    expect(sig2).not.toBe(sig);
    expect(queueFn<boolean>(`q.sessionNeedsRun('s-swap', ${size}, { sig: ${JSON.stringify(sig2)} })`)).toBe(true);
    const before = readCalls(fakeState).length;
    runner('s-swap', { final: true });
    expect(events().some((e) => e.kind === 'transcript-replaced')).toBe(true);
    expect(readCalls(fakeState).length).toBeGreaterThan(before);
  }, 180_000);
});

describe('A2 러너 동시성', () => {
  it('같은 세션의 러너 2개를 동시에 띄워도 Haiku 는 한 번의 실행분만 호출된다', async () => {
    login(true);
    writeTranscript(4);
    const [a, b] = await Promise.all([runnerAsync('s-conc', { FAKE_SLEEP: '2' }), runnerAsync('s-conc', { FAKE_SLEEP: '2' })]);
    expect(a.status).toBe(0); expect(b.status).toBe(0);
    const calls = readCalls(fakeState);
    expect(calls.length).toBe(3); // solution, behavior, learning 한 세트 — 2세트(6)가 아님
    expect(events().filter((e) => e.skipped === 'runner-locked').length).toBe(1);
    expect(solutionFiles().filter((f) => f.startsWith('fake-process-title')).length).toBe(1);
    // 종료 후 락은 풀려 있다
    expect(fs.existsSync(path.join(forgen, 'state', 'runner-locks', 's-conc.lock'))).toBe(false);
  }, 180_000);

  it('죽은 러너의 락(만료/프로세스 없음)은 회수된다', () => {
    login(true);
    writeTranscript(4);
    const dir = path.join(forgen, 'state', 'runner-locks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's-dead.lock'), JSON.stringify({ pid: 999999, at: Date.now() }));
    runner('s-dead');
    expect(readCalls(fakeState).length).toBe(3);
  }, 120_000);
});

describe('A4 호환', () => {
  it('격리에 필수가 아닌 옵션을 모르면 그 옵션만 빼고 1회 다시 부른다', () => {
    login(true);
    writeTranscript(4);
    runner('s-compat', { extra: { FAKE_REJECT: '--no-session-persistence' } });
    const calls = readCalls(fakeState);
    // 단계마다 첫 호출은 거절되고(3), 옵션을 뺀 재호출 1회가 성공한다(3). 재시도가 무한히 이어지지 않는다.
    expect(calls.filter((c) => c.startsWith('reject')).length).toBe(3);
    expect(calls.filter((c) => !c.startsWith('reject'))).toEqual(['solution', 'behavior', 'learning']);
    const ev = events().filter((e) => e.kind === 'haiku-call');
    expect(ev.some((e) => Array.isArray(e.droppedOptions) && (e.droppedOptions as string[]).includes('--no-session-persistence'))).toBe(true);
  }, 120_000);

  it('격리 필수 옵션을 모르면 재시도하지 않고 사유를 남긴다', () => {
    login(true);
    writeTranscript(4);
    runner('s-compat2', { extra: { FAKE_REJECT: '--strict-mcp-config' } });
    const calls = readCalls(fakeState);
    expect(calls).toEqual(['reject --strict-mcp-config']); // 1회 시도, 재호출 없음, 다음 단계도 멈춤
    const fail = events().find((e) => e.kind === 'haiku-call' && e.outcome === 'unavailable');
    expect(String(fail?.reason)).toContain('--strict-mcp-config');
    expect(String(fail?.reason)).toContain('업데이트');
  }, 120_000);

  it('인증이 settings(apiKeyHelper)에서 오는 환경의 실패는 로그인 필요와 구분해 표시한다', () => {
    login(true);
    writeTranscript(4);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: '/usr/local/bin/get-key' }));
    runner('s-auth', { extra: { FAKE_FAIL_PHASE: 'solution' } });
    const fail = events().find((e) => e.kind === 'haiku-call' && e.outcome === 'unavailable');
    expect(String(fail?.reason)).toContain('apiKeyHelper');
    expect(String(fail?.reason)).not.toContain('claude /login');
  }, 120_000);
});

describe('A5(낮음) 부분 성공 단계 중복 호출 방지', () => {
  it('solution 만 성공하고 behavior 에서 막혔다가 풀리면 solution 을 다시 부르지 않는다', () => {
    login(true);
    writeTranscript(4);
    runner('s-part', { extra: { FAKE_FAIL_PHASE: 'behavior' } });
    expect(readCalls(fakeState)).toEqual(['solution', 'behavior']); // behavior 에서 중단
    const sol1 = readCalls(fakeState).filter((c) => c === 'solution').length;
    // 같은 transcript 크기로 다시 실행(미로그인 사유 재시도 간격 이후라고 가정하고 직접 실행)
    runner('s-part', { final: true });
    const calls = readCalls(fakeState);
    expect(calls.filter((c) => c === 'solution').length).toBe(sol1); // 중복 호출 없음
    expect(calls.slice(2)).toEqual(['behavior', 'learning']);
  }, 180_000);
});

describe('A5(낮음) 손상 복구', () => {
  it('커서 파일이 손상돼도 마지막 정상본으로 복구하고 손상본은 보존한다', () => {
    const state = path.join(forgen, 'state');
    fs.mkdirSync(state, { recursive: true });
    const run = (code: string) => spawnSync(process.execPath, ['--input-type=module', '-e', `import * as q from ${JSON.stringify(path.join(DIST, 'core', 'extraction-queue.js'))}; ${code}`], { encoding: 'utf-8', env: env() });
    run(`q.setCursor('s1', 10); q.setCursor('s1', 20);`); // 두 번째 쓰기 직전 상태가 .bak(offset 10)
    const cp = path.join(state, 'extraction-cursors.json');
    fs.writeFileSync(cp, '{"s1": {"offset": 2'); // 잘린 JSON
    const out = run(`console.log(q.getCursor('s1'));`).stdout.trim();
    expect(out).toBe('10'); // .bak 에서 복구
    expect(fs.readdirSync(state).some((f) => f.startsWith('extraction-cursors.json.corrupt-'))).toBe(true);
  });

  it('CRLF transcript 의 커서가 실제 바이트와 일치한다', () => {
    const size = writeTranscript(3, '\r\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { streamTranscriptLines } from ${JSON.stringify(path.join(DIST, 'core', 'transcript-summary.js'))};
      const lines = []; const end = await streamTranscriptLines(${JSON.stringify(transcript)}, 0, (l) => lines.push(l));
      const again = []; const end2 = await streamTranscriptLines(${JSON.stringify(transcript)}, end, (l) => again.push(l));
      console.log(JSON.stringify({ end, end2, n: lines.length, again: again.length, cr: lines.some((l) => l.endsWith('\\r')) }));`], { encoding: 'utf-8' });
    const j = JSON.parse(r.stdout.trim());
    expect(j).toEqual({ end: size, end2: size, n: 6, again: 0, cr: false });
    // 이어 붙이면 새 줄만 읽는다
    fs.appendFileSync(transcript, line('user', '추가 요청입니다') + '\r\n');
    const r2 = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { streamTranscriptLines } from ${JSON.stringify(path.join(DIST, 'core', 'transcript-summary.js'))};
      const got = []; await streamTranscriptLines(${JSON.stringify(transcript)}, ${size}, (l) => got.push(l)); console.log(got.length);`], { encoding: 'utf-8' });
    expect(r2.stdout.trim()).toBe('1');
  });
});
