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
import { sendNotification } from './notify.js';

const log = createLogger('spawn');

/** Phase 2: host-runtime 어댑터 위임. */
function findRuntimeLauncher(runtime: RuntimeHost): string {
  return getHostRuntime(runtime).launcher;
}

/**
 * 0.4.6 — runtime 별 transcript 디렉토리.
 *
 * - claude: ~/.claude/projects/<sanitized-cwd>/<session>.jsonl
 * - codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl
 *
 * Codex 는 cwd 별 격리 없이 날짜별 격리 — 같은 사용자의 모든 codex 세션이
 * 동일 날짜 dir 에 들어감. session attribution 은 파일 basename 의 session-id 로.
 *
 * Note: codex 는 일별 dir 라 자정 가로지르는 세션은 두 dir 에 걸칠 수 있음 —
 * 본 함수는 시작 시점 dir 만 반환. 호출 측이 needed 시 보강.
 */
function transcriptProjectDir(cwd: string, runtime: RuntimeHost = 'claude'): string {
  if (runtime === 'codex') {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return path.join(os.homedir(), '.codex', 'sessions', String(y), m, day);
  }
  // Claude Code는 cwd의 /를 -로 치환하고 선행 -를 유지
  const sanitized = cwd.replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', sanitized);
}

/** 스냅샷용 — 세션 시작 전 존재하는 transcript basename 집합. */
function snapshotExistingTranscripts(cwd: string, runtime: RuntimeHost = 'claude'): Set<string> {
  const dir = transcriptProjectDir(cwd, runtime);
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
  runtime: RuntimeHost = 'claude',
): string | null {
  const dir = transcriptProjectDir(cwd, runtime);
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
/**
 * 0.4.6 — claude/codex 양 schema 호환.
 *
 * Claude JSONL: {type: 'user' | 'queue-operation', ...}
 * Codex JSONL: {type: 'response_item', payload: {role: 'user' | 'developer' | 'assistant', ...}}
 *
 * 단일 함수에서 둘 다 처리 — schema 자동 감지.
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
        const obj = JSON.parse(line) as { type?: unknown; payload?: { role?: unknown } };
        const t = obj.type;
        // Claude schema
        if (t === 'user' || t === 'queue-operation') { count++; continue; }
        // Codex schema (response_item with role=user)
        if (t === 'response_item' && obj.payload?.role === 'user') count++;
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
 *
 * v0.4.8 (A1): runtime 별 schema 차이로 분기. Claude 는 `entry.type === 'user'|
 * 'assistant'`, Codex 는 `entry.type === 'response_item' && entry.payload.role`.
 */
async function indexTranscriptToFTS(cwd: string, transcriptPath: string, sessionId: string, runtime: RuntimeHost = 'claude'): Promise<void> {
  try {
    const store = await import('./session-store.js');
    if (runtime === 'codex') {
      await store.indexCodexSession(cwd, transcriptPath, sessionId);
    } else {
      await store.indexSession(cwd, transcriptPath, sessionId);
    }
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
  const preSnapshot = snapshotExistingTranscripts(context.cwd, runtime);

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
      if (runtime !== 'claude' && runtime !== 'codex') {
        resolve(code ?? 0);
        return;
      }

      // 세션 종료 후 하네스 작업.
      // 0.4.6 — codex 도 transcript 인식 (~/.codex/sessions/YYYY/MM/DD/rollout-<sid>.jsonl).
      // Codex transcript 의 schema 는 claude 와 다르므로 auto-compound 의 input parsing 은
      // 별개 작업 (0.4.7). 현재 단계는 *transcript 위치 인식 + count* 만 codex 호환.
      try {
        const transcript = findSessionTranscript(context.cwd, sessionStartTime, preSnapshot, runtime);
        if (!transcript) {
          log.debug('이 세션에서 생성된 transcript를 찾을 수 없음 (snapshot diff)');
        } else {
          // 0.4.6 — claude/codex 양 schema 호환 (countUserMessages + extractSummary).
          // codex transcript 의 sessionId 는 파일명 패턴 'rollout-<ts>-<sid>.jsonl' 의 끝부분.
          let sessionId: string;
          if (runtime === 'codex') {
            const m = path.basename(transcript, '.jsonl').match(/rollout-[\dT-]+-(.+)$/);
            sessionId = m ? m[1] : path.basename(transcript, '.jsonl');
          } else {
            sessionId = path.basename(transcript, '.jsonl');
          }

          // 1. FTS5 인덱싱 — v0.4.8 (A1) 부터 Claude/Codex 모두 지원.
          await indexTranscriptToFTS(context.cwd, transcript, sessionId, runtime);

          // 2. 자동 compound (10+ user 메시지인 경우만) — 양 runtime 호환
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
const MAX_RESUMES_TOKEN = 3;
const MAX_RESUMES_RATE = 10; // ADR-008: rate-limit wait 은 5h 단위라 더 관대
const MAX_RESUMES = MAX_RESUMES_TOKEN; // backward compat — 기존 token-limit 호출자

const RATE_LIMIT_HARD_CAP_MS = 6 * 60 * 60 * 1000; // 6h max single wait
const COUNTDOWN_INTERVAL_MS = 30_000;

/**
 * Exponential backoff for rate-limit when resetAt 파싱 실패.
 * 1m → 5m → 15m → 30m → 1h → 2h cap. 합 ≤ 6h.
 */
export function rateLimitBackoffMs(attempt: number): number {
  const schedule = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 60 * 60_000];
  return schedule[Math.min(attempt, schedule.length - 1)];
}

/**
 * Foreground countdown — 30s 마다 남은 시간 단일 라인 갱신, Ctrl+C 시 abort.
 */
async function countdownSleep(totalMs: number, label: string): Promise<void> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const remainMs = deadline - Date.now();
    const remainMin = Math.floor(remainMs / 60_000);
    const remainSec = Math.floor((remainMs % 60_000) / 1000);
    const eta = remainMin >= 60
      ? `${Math.floor(remainMin / 60)}h ${remainMin % 60}m`
      : `${remainMin}m ${remainSec}s`;
    process.stdout.write(`\r[forgen] ${label} — ${eta} remaining (Ctrl+C to abort)    `);
    const tick = Math.min(COUNTDOWN_INTERVAL_MS, remainMs);
    await new Promise<void>(resolve => setTimeout(resolve, tick));
  }
  process.stdout.write('\n');
}

/**
 * 토큰 한도 / API rate-limit 도달 시 자동 재시작을 지원하는 claude 실행 래퍼.
 * context-guard가 pending-resume.json 마커를 생성하면 reason 별 정책으로 처리.
 *
 * - reason='token-limit': 30s 쿨다운, MAX_RESUMES_TOKEN=3
 * - reason='rate-limit': resetAt 정밀 sleep (+60s 버퍼) 또는 exponential backoff,
 *                        MAX_RESUMES_RATE=10, hard cap 6h
 */
export async function spawnClaudeWithResume(
  args: string[],
  context: V1HarnessContext,
  contextFactory: () => Promise<V1HarnessContext>,
  runtime: RuntimeHost = 'claude',
): Promise<void> {
  let tokenResumeCount = 0;
  let rateResumeCount = 0;
  let currentContext = context;

  while (true) {
    const exitCode = await spawnClaude(args, currentContext, runtime);
    if (runtime !== 'claude' && runtime !== 'codex') {
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

      if (marker.reason === 'token-limit') {
        if (tokenResumeCount >= MAX_RESUMES_TOKEN) {
          console.log(`[forgen] 최대 자동 재시작 횟수(${MAX_RESUMES_TOKEN}) 도달. 수동으로 다시 시작하세요.`);
          break;
        }
        tokenResumeCount++;
        console.log(`[forgen] 토큰 한도 도달. ${RESUME_COOLDOWN_MS / 1000}초 후 자동 재시작합니다... (${tokenResumeCount}/${MAX_RESUMES_TOKEN})`);
        await new Promise<void>(resolve => setTimeout(resolve, RESUME_COOLDOWN_MS));
        console.log('[forgen] 세션 재시작 중...');
        currentContext = await contextFactory();
        continue;
      }

      if (marker.reason === 'rate-limit') {
        if (rateResumeCount >= MAX_RESUMES_RATE) {
          console.log(`[forgen] rate-limit 자동 재시작 한도(${MAX_RESUMES_RATE}) 도달. 수동 재시작 필요.`);
          break;
        }
        rateResumeCount++;

        let sleepMs: number;
        let label: string;
        if (marker.resetAt) {
          const resetMs = Date.parse(marker.resetAt);
          if (Number.isFinite(resetMs)) {
            const target = resetMs - Date.now() + 60_000; // 60s 버퍼
            sleepMs = Math.min(Math.max(target, 0), RATE_LIMIT_HARD_CAP_MS);
            label = `Rate limit. Resuming after reset (${marker.resetAt})`;
          } else {
            sleepMs = rateLimitBackoffMs(rateResumeCount - 1);
            label = `Rate limit. Backoff #${rateResumeCount}`;
          }
        } else {
          sleepMs = rateLimitBackoffMs(rateResumeCount - 1);
          label = `Rate limit. Backoff #${rateResumeCount}`;
        }

        if (sleepMs >= RATE_LIMIT_HARD_CAP_MS) {
          console.log(`[forgen] rate-limit reset 시각이 hard cap(6h) 초과 — 수동 재시작 필요. handoff 저장됨.`);
          break;
        }

        await countdownSleep(sleepMs, label);
        console.log('[forgen] 세션 재시작 중...');
        sendNotification(
          'forgen — Rate limit 회복',
          `${runtime} 세션 재기동 중 (${rateResumeCount}/${MAX_RESUMES_RATE} resume)`,
        );
        currentContext = await contextFactory();
        continue;
      }

      // 알 수 없는 reason → exit (fail-open, 수동 처리)
      if (exitCode !== 0) process.exit(exitCode);
      break;
    } catch {
      if (exitCode !== 0) process.exit(exitCode);
      break;
    }
  }
}

// MAX_RESUMES re-export for backward-compat tests
export { MAX_RESUMES };
