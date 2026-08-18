/**
 * 결함2 회귀 테스트 — auto-compound solution extraction 이 조용히 항상 실패하던 문제.
 *
 * (A) spawn.ts: detached runner 를 `stdio: 'ignore'` 통짜로 spawn 하면 러너의
 *     stdout/stderr(진단 메시지 포함)가 통째로 버려진다. 그 결과 98/98 sweep 이
 *     `extractedSolutions=0` 을 기록해도 원인을 알 방법이 없었다(완전 무음 실패).
 *     이제 세션별 로그 파일 fd 로 stdout/stderr 를 리다이렉트한다.
 *
 * (B) auto-compound-runner.ts: 솔루션 추출 호출에 `--permission-mode dontAsk` 를
 *     추가해, sparse env(cron/비로그인 셸 — 이 러너는 항상 detached·headless 로
 *     실행됨)에서 haiku 가 "승인이 필요하다"고 오판해 forgen compound 를 실행하지
 *     않고 산문으로 응답하던 문제를 fix. `Bash(forgen compound:*)` 스코프는 그대로
 *     유지되어야 하며, 전체 Bash 나 `--dangerously-skip-permissions`/`bypassPermissions`
 *     로 넓히면 안 된다(보안 회귀).
 *
 * (B) 는 auto-compound-runner.ts 를 직접 import 하지 않는다 — 이 모듈은 최상위
 * 스코프에서 `process.exit()` 를 여러 번 호출하는 CLI 스크립트라서(예: transcript
 * 요약이 200자 미만이면 `process.exit(0)`), 테스트 프로세스 안으로 직접 import 하면
 * vitest 워커 프로세스 자체가 죽을 위험이 있다 — 기존 auto-compound-dedup.test.ts 가
 * parseTags/isDuplicate 를 인라인 재구현해 테스트하는 이유와 동일한 제약. 대신 실제
 * 배포되는 소스 텍스트를 읽어 호출부의 argv 계약을 정규식/문자열 매칭으로 검증한다 —
 * 재구현본과 달리 실제 소스와 drift 될 수 없다는 장점도 있다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── Part B: 소스 텍스트 기반 argv 계약 가드 ──

const RUNNER_SRC = fs.readFileSync(
  path.resolve(__dirname, '../src/core/auto-compound-runner.ts'),
  'utf-8',
);

/**
 * 솔루션 추출 호출부만 잘라낸다. `'Bash(forgen compound:*)'` 리터럴은 파일 전체에서
 * 이 호출부(실제 args 배열 원소)에만 등장한다 — 주석에서는 백틱으로 감싸 표기하므로
 * 겹치지 않는다.
 */
function extractSolutionCallBlock(src: string): string {
  const anchor = "'Bash(forgen compound:*)'";
  const idx = src.indexOf(anchor);
  expect(idx, 'solution extraction call site를 찾지 못함 — 호출부가 이동/리팩터됐는지 확인').toBeGreaterThan(-1);
  return src.slice(Math.max(0, idx - 80), idx + 260);
}

describe('Part B — solution extraction argv 계약 (source guard)', () => {
  it('Bash(forgen compound:*) 스코프를 그대로 유지한다', () => {
    const block = extractSolutionCallBlock(RUNNER_SRC);
    expect(block).toContain("'--allowedTools'");
    expect(block).toContain("'Bash(forgen compound:*)'");
  });

  it('sparse env 오판을 막는 --permission-mode dontAsk 를 포함한다', () => {
    const block = extractSolutionCallBlock(RUNNER_SRC);
    expect(block).toContain("'--permission-mode'");
    expect(block).toContain("'dontAsk'");
  });

  it('회귀 가드: 전체 Bash 나 --dangerously-skip-permissions/bypassPermissions 로 넓히지 않는다', () => {
    const block = extractSolutionCallBlock(RUNNER_SRC);
    expect(block).not.toContain('--dangerously-skip-permissions');
    expect(block).not.toContain('bypassPermissions');
    // 스코프 없는 단독 'Bash' 허용 금지 (P1-S1 회귀 방지)
    expect(block).not.toMatch(/'Bash'/);
  });

  it('회귀 가드: 파일 전체 어디에도 위험 플래그가 실제 인자로 등장하지 않는다', () => {
    // 주석 설명은 백틱으로 표기하므로 걸리지 않고, 코드에서 실제로 쓰이려면
    // 반드시 따옴표로 감싼 토큰이어야 하므로 이 형태만 검사.
    expect(RUNNER_SRC).not.toMatch(/['"]--dangerously-skip-permissions['"]/);
    expect(RUNNER_SRC).not.toMatch(/['"]bypassPermissions['"]/);
  });
});

// ── Part A: 로그 파일 캡처 ──

let tmpHome: string;
let stateDir: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-autocompound-log-'));
  process.env.FORGEN_HOME = tmpHome;
  stateDir = path.join(tmpHome, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.FORGEN_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.doUnmock('node:child_process');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('Part A — autoCompoundLogPath', () => {
  it('세션 ID 로부터 state/auto-compound/<sessionId>.log 경로를 계산한다', async () => {
    const { autoCompoundLogPath } = await import('../src/core/spawn.js');
    const p = autoCompoundLogPath('sess-abc123');
    expect(p).toBe(path.join(stateDir, 'auto-compound', 'sess-abc123.log'));
  });

  it('세션 ID 의 특수문자를 파일명 안전하게 치환한다', async () => {
    const { autoCompoundLogPath } = await import('../src/core/spawn.js');
    const p = autoCompoundLogPath('sess/../weird:id');
    expect(path.basename(p)).toBe('sess____weird_id.log');
  });
});

describe('Part A — fd 리다이렉션 메커니즘 (실제 서브프로세스, 실제 파일 read-back)', () => {
  it('실제 자식 프로세스의 stdout/stderr 가 로그 파일에 그대로 기록된다', async () => {
    // 실제(unmocked) node:child_process.spawn — runAutoCompound 가 쓰는 것과 동일한
    // fd 리다이렉션 메커니즘(stdio: ['ignore', fd, fd])을 진짜 자식 프로세스로 검증.
    const { spawn: realSpawn } = await import('node:child_process');
    const { autoCompoundLogPath } = await import('../src/core/spawn.js');

    const sessionId = 'sess-fd-real';
    const logPath = autoCompoundLogPath(sessionId);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, 'a');

    const fakeRunner = path.join(tmpHome, 'fake-runner.cjs');
    fs.writeFileSync(
      fakeRunner,
      "process.stdout.write('hello-stdout\\n'); process.stderr.write('hello-stderr\\n');",
    );

    await new Promise<void>((resolve, reject) => {
      const child = realSpawn('node', [fakeRunner], {
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      child.on('error', reject);
      child.on('exit', () => resolve());
      child.unref();
    });
    fs.closeSync(fd);

    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('hello-stdout');
    expect(content).toContain('hello-stderr');
  });
});

describe('Part A — runAutoCompound 배선 (mocked spawn)', () => {
  it('spawn 전에 state/auto-compound/ 디렉토리를 자동 생성한다', async () => {
    const mockSpawn = vi.fn().mockReturnValue({ unref: vi.fn() });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>();
      return { ...actual, spawn: mockSpawn };
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runAutoCompound, autoCompoundLogPath } = await import('../src/core/spawn.js');
    const sessionId = 'sess-dir-autocreate';
    expect(fs.existsSync(path.dirname(autoCompoundLogPath(sessionId)))).toBe(false);
    runAutoCompound('/tmp/cwd', '/tmp/transcript.jsonl', sessionId);
    expect(fs.existsSync(path.dirname(autoCompoundLogPath(sessionId)))).toBe(true);
  });

  it('stdout/stderr 를 세션별 로그 파일 fd 로 넘긴다 (stdin은 ignore 유지)', async () => {
    // 실제 child_process.spawn 은 fd 를 자식에게 dup 해 넘기므로, 부모가 spawn 직후
    // fd 를 닫아도 안전하다(우리 구현도 이렇게 함). mock 은 실제 dup 을 하지 않으므로
    // fd 가 살아있는 "spawn 호출 시점"에 inode 를 캡처해야 한다 — 호출 후에는 production
    // 코드가 이미 부모 측 fd 를 닫는다(아래 별도 assertion으로 검증).
    let capturedIno: number | undefined;
    const mockSpawn = vi.fn((_cmd: string, _args: string[], opts: { stdio: [string, number, number] }) => {
      capturedIno = fs.fstatSync(opts.stdio[1]).ino;
      return { unref: vi.fn() };
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>();
      return { ...actual, spawn: mockSpawn };
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runAutoCompound, autoCompoundLogPath } = await import('../src/core/spawn.js');
    const sessionId = 'sess-fd-wiring';
    runAutoCompound('/tmp/cwd', '/tmp/transcript.jsonl', sessionId);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const opts = mockSpawn.mock.calls[0][2] as { stdio: [string, number, number] };
    expect(Array.isArray(opts.stdio)).toBe(true);
    expect(opts.stdio[0]).toBe('ignore');
    const [, outFd, errFd] = opts.stdio;
    expect(typeof outFd).toBe('number');
    expect(outFd).toBe(errFd); // stdout/stderr 동일 로그 파일로 합쳐짐

    // spawn 호출 시점에 그 fd 가 가리킨 파일이 정확히 autoCompoundLogPath(sessionId) 였는지 검증.
    const pathStat = fs.statSync(autoCompoundLogPath(sessionId));
    expect(capturedIno).toBe(pathStat.ino);

    // runAutoCompound 가 spawn 이후 부모 측 fd 를 닫으므로(실제 child는 dup 본을 가짐) 재사용 불가.
    expect(() => fs.fstatSync(outFd)).toThrow();
  });

  it('로그 디렉토리 생성이 실패해도 fail-open으로 stdio: "ignore" 폴백하여 spawn한다', async () => {
    const mockSpawn = vi.fn().mockReturnValue({ unref: vi.fn() });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>();
      return { ...actual, spawn: mockSpawn };
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runAutoCompound, autoCompoundLogPath } = await import('../src/core/spawn.js');
    const sessionId = 'sess-fallback';

    // autoCompoundLogPath 의 부모 디렉토리 자리에 "파일"을 미리 만들어 mkdirSync 를 실패시킨다.
    const logPath = autoCompoundLogPath(sessionId);
    fs.mkdirSync(path.dirname(path.dirname(logPath)), { recursive: true });
    fs.writeFileSync(path.dirname(logPath), 'not-a-directory'); // auto-compound/ 자리에 파일

    const ret = runAutoCompound('/tmp/cwd', '/tmp/transcript.jsonl', sessionId);
    expect(ret).toBe('spawned');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const opts = mockSpawn.mock.calls[0][2];
    expect(opts.stdio).toBe('ignore'); // fd 열기 실패 → 기존 동작으로 폴백
  });
});
