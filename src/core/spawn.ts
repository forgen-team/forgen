import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildEnv } from './config-injector.js';
import type { V1HarnessContext } from './harness.js';
import { loadGlobalConfig } from './global-config.js';
import { createLogger } from './logger.js';
import { STATE_DIR } from './paths.js';
import type { RuntimeHost } from './types.js';
import { getHostRuntime } from '../host/host-runtime.js';

const log = createLogger('spawn');

/** Phase 2: host-runtime 어댑터 위임. */
function findRuntimeLauncher(runtime: RuntimeHost): string {
  return getHostRuntime(runtime).launcher;
}

function transcriptProjectDir(cwd: string): string {
  // Claude Code는 cwd의 /를 -로 치환하고 선행 -를 유지
  const sanitized = cwd.replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', sanitized);
}

/** 스냅샷용 — 세션 시작 전 존재하는 transcript basename 집합. */
function snapshotExistingTranscripts(cwd: string): Set<string> {
  const dir = transcriptProjectDir(cwd);
  if (!fs.existsSync(dir)) return new Set();
  try {
    return new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')));
  } catch {
    return new Set();
  }
}

/**
 * 세션 시작 후 새로 생성된 transcript 파일을 고른다.
 *
 * Audit fix #8 (2026-04-21): 이전 findLatestTranscript는 mtime 최신 파일을
 * 선택했기에, 같은 cwd에서 동시에 두 세션이 돌면 더 늦게 시작된 세션의
 * transcript가 두 세션의 exit 핸들러 모두에서 선택되어 transcript
 * attribution이 섞였다. 이제는
 *   1) 세션 시작 시점의 "이미 존재하던" 파일 스냅샷을 preSnapshot으로 전달받고
 *   2) exit 시점에 스냅샷에 없던 새 파일만 후보로 보고
 *   3) mtime이 세션 시작 시각 이후인 것 중 최신을 선택한다.
 * 여전히 후보가 여러 개이면 (rare: 훅이 추가 파일을 쓴 경우) 가장 최근 수정본
 * 을 고르되 debug 로그를 남긴다.
 */
function findSessionTranscript(
  cwd: string,
  sessionStartMs: number,
  preSnapshot: Set<string>,
): string | null {
  const dir = transcriptProjectDir(cwd);
  if (!fs.existsSync(dir)) return null;

  let candidates: Array<{ name: string; mtime: number }>;
  try {
    candidates = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') && !preSnapshot.has(f))
      .map((f) => {
        try {
          return { name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { name: string; mtime: number } => x !== null && x.mtime >= sessionStartMs);
  } catch {
    return null;
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates.length > 1) {
    log.debug(
      `multiple new transcripts after session start — picking ${candidates[0].name} ` +
        `(others: ${candidates.slice(1).map((c) => c.name).join(', ')})`,
    );
  }
  return path.join(dir, candidates[0].name);
}

/**
 * 사용자 메시지 수 카운트 (streaming).
 *
 * Audit fix #8 (2026-04-21): 이전에는 `fs.readFileSync(transcript, 'utf-8')`로
 * 파일 전체를 메모리에 올렸다. 수백 MB 규모 transcript에서는 heap spike가
 * 발생했고, 카운트 외엔 내용이 필요 없으니 streaming line-by-line로 충분하다.
 */
async function countUserMessages(transcriptPath: string): Promise<number> {
  const { createInterface } = await import('node:readline');
  const stream = fs.createReadStream(transcriptPath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of rl) {
      if (!line) continue;
      try {
        const t = (JSON.parse(line) as { type?: unknown }).type;
        if (t === 'user' || t === 'queue-operation') count++;
      } catch { /* skip malformed */ }
    }
  } finally {
    rl.close();
    stream.close();
  }
  return count;
}


/**
 * 세션 종료 후 자동 compound 추출 + USER.md 업데이트.
 * auto-compound-runner.ts를 동기 실행하여 솔루션 추출 + 사용자 패턴 관찰.
 */
async function runAutoCompound(cwd: string, transcriptPath: string, sessionId: string): Promise<void> {
  console.log('\n[forgen] 세션 분석 중... (자동 compound)');

  const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'auto-compound-runner.js');
  try {
    execFileSync('node', [runnerPath, cwd, transcriptPath, sessionId], {
      cwd,
      timeout: 120_000,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    console.log('[forgen] 자동 compound 완료\n');
  } catch (e) {
    log.debug('auto-compound 실패', e);
  }
}

/**
 * Transcript를 SQLite FTS5에 인덱싱 (추후 session-search MCP 도구용).
 */
async function indexTranscriptToFTS(cwd: string, transcriptPath: string, sessionId: string): Promise<void> {
  try {
    const { indexSession } = await import('./session-store.js');
    await indexSession(cwd, transcriptPath, sessionId);
  } catch (e) {
    log.debug('FTS5 인덱싱 실패 (session-store 미구현 시 정상)', e);
  }
}

/** Claude Code를 하네스 환경으로 실행. exit code를 반환. */
export async function spawnClaude(
  args: string[],
  context: V1HarnessContext,
  runtime: RuntimeHost = 'claude',
): Promise<number> {
  const launcher = findRuntimeLauncher(runtime);
  const env = buildEnv(context.cwd, context.v1.session?.session_id, runtime);
  const cleanArgs = [...args];

  // config.json에서 dangerouslySkipPermissions 기본값 적용
  const globalConfig = loadGlobalConfig();
  if (
    runtime === 'claude' &&
    globalConfig.dangerouslySkipPermissions &&
    !cleanArgs.includes('--dangerously-skip-permissions')
  ) {
    cleanArgs.unshift('--dangerously-skip-permissions');
  }

  // 세션 시작 전 timestamp + 기존 transcript 스냅샷 기록 (종료 후 finder 용).
  // Audit fix #8 (2026-04-21): 스냅샷으로 동시 세션 transcript 오선택을 차단.
  const sessionStartTime = Date.now();
  const preSnapshot = snapshotExistingTranscripts(context.cwd);

  return new Promise((resolve, reject) => {
    const child = spawn(launcher, cleanArgs, {
      stdio: 'inherit',
      env: { ...process.env, ...env },
      cwd: context.cwd,
    });

    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(getHostRuntime(runtime).missingInstallMessage));
      } else {
        reject(err);
      }
    });

    child.on('exit', async (code) => {
      if (runtime !== 'claude') {
        resolve(code ?? 0);
        return;
      }

      // 세션 종료 후 하네스 작업
      try {
        const transcript = findSessionTranscript(context.cwd, sessionStartTime, preSnapshot);
        if (!transcript) {
          log.debug('이 세션에서 생성된 transcript를 찾을 수 없음 (snapshot diff)');
        } else {
          const sessionId = path.basename(transcript, '.jsonl');

          // 1. FTS5 인덱싱
          await indexTranscriptToFTS(context.cwd, transcript, sessionId);

          // 2. 자동 compound (10+ user 메시지인 경우만) — streaming line count
          const userMsgCount = await countUserMessages(transcript);
          if (userMsgCount >= 10) {
            await runAutoCompound(context.cwd, transcript, sessionId);
          } else {
            console.log(`[forgen] 세션이 짧아 auto-compound 생략 (${userMsgCount} messages)`);
          }
        }
      } catch (e) {
        console.error('[forgen] 세션 종료 후 처리 실패:', e instanceof Error ? e.message : e);
      }

      resolve(code ?? 0);
    });
  });
}

const RESUME_COOLDOWN_MS = 30_000;
const MAX_RESUMES = 3;

/**
 * 토큰 한도 도달 시 자동 재시작을 지원하는 claude 실행 래퍼.
 * context-guard가 pending-resume.json 마커를 생성하면 쿨다운 후 재시작.
 */
export async function spawnClaudeWithResume(
  args: string[],
  context: V1HarnessContext,
  contextFactory: () => Promise<V1HarnessContext>,
  runtime: RuntimeHost = 'claude',
): Promise<void> {
  let resumeCount = 0;
  let currentContext = context;

  while (true) {
    const exitCode = await spawnClaude(args, currentContext, runtime);
    if (runtime !== 'claude') {
      if (exitCode !== 0) process.exit(exitCode);
      break;
    }

    const resumePath = path.join(STATE_DIR, 'pending-resume.json');
    if (!fs.existsSync(resumePath)) {
      if (exitCode !== 0) process.exit(exitCode);
      break;
    }

    try {
      const marker = JSON.parse(fs.readFileSync(resumePath, 'utf-8'));
      fs.unlinkSync(resumePath);

      if (marker.reason !== 'token-limit') {
        if (exitCode !== 0) process.exit(exitCode);
        break;
      }
      if (resumeCount >= MAX_RESUMES) {
        console.log(`[forgen] 최대 자동 재시작 횟수(${MAX_RESUMES}) 도달. 수동으로 다시 시작하세요.`);
        break;
      }

      resumeCount++;
      console.log(`[forgen] 토큰 한도 도달. ${RESUME_COOLDOWN_MS / 1000}초 후 자동 재시작합니다... (${resumeCount}/${MAX_RESUMES})`);
      await new Promise<void>(resolve => setTimeout(resolve, RESUME_COOLDOWN_MS));

      console.log('[forgen] 세션 재시작 중...');
      currentContext = await contextFactory();
    } catch {
      if (exitCode !== 0) process.exit(exitCode);
      break;
    }
  }
}
