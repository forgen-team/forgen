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
import { type RuntimeHost } from './types.js';

const log = createLogger('spawn');

/** claude CLI 경로 탐색 */
function findClaude(): string {
  return 'claude';
}

function findRuntimeLauncher(runtime: RuntimeHost): string {
  return runtime === 'codex' ? 'codex' : findClaude();
}

/**
 * 가장 최근 transcript 파일을 찾는다.
 * Claude Code는 세션 대화를 ~/.claude/projects/{sanitized-cwd}/{uuid}.jsonl에 저장.
 */
function findLatestTranscript(cwd: string): string | null {
  // Claude Code는 cwd의 /를 -로 치환하고 선행 -를 유지
  const sanitized = cwd.replace(/\//g, '-');
  const projectDir = path.join(os.homedir(), '.claude', 'projects', sanitized);
  if (!fs.existsSync(projectDir)) return null;

  const jsonlFiles = fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  return jsonlFiles.length > 0 ? path.join(projectDir, jsonlFiles[0].name) : null;
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

  // 세션 시작 전 timestamp 기록 (종료 후 transcript 찾기 위해)
  const sessionStartTime = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(launcher, cleanArgs, {
      stdio: 'inherit',
      env: { ...process.env, ...env },
      cwd: context.cwd,
    });

    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (runtime === 'codex') {
          reject(new Error('Codex is not installed.'));
        } else {
          reject(new Error('Claude Code is not installed. npm install -g @anthropic-ai/claude-code'));
        }
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
        const transcript = findLatestTranscript(context.cwd);
        if (!transcript) {
          log.debug('transcript 파일을 찾을 수 없음');
        } else {
          const stat = fs.statSync(transcript);
          // 이 세션에서 생성/수정된 transcript만
          if (stat.mtimeMs <= sessionStartTime) {
            log.debug(`transcript mtime(${stat.mtimeMs}) <= sessionStart(${sessionStartTime}), 건너뜀`);
          } else {
            const sessionId = path.basename(transcript, '.jsonl');

            // 1. FTS5 인덱싱
            await indexTranscriptToFTS(context.cwd, transcript, sessionId);

            // 2. 자동 compound (10+ user 메시지인 경우만)
            const content = fs.readFileSync(transcript, 'utf-8');
            const userMsgCount = content.split('\n')
              .filter(l => { try { const t = JSON.parse(l).type; return t === 'user' || t === 'queue-operation'; } catch { return false; } })
              .length;

            if (userMsgCount >= 10) {
              await runAutoCompound(context.cwd, transcript, sessionId);
            } else {
              console.log(`[forgen] 세션이 짧아 auto-compound 생략 (${userMsgCount} messages)`);
            }
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
