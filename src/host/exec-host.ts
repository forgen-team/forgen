/**
 * Host-aware exec — feat/codex-support Phase 2 (P2-2/P2-3 공통)
 *
 * compound-extractor + auto-compound-runner 가 *어느 host CLI 로 LLM 호출* 할지
 * 결정. profile.default_host 우선 + override 가능.
 *
 * 출력은 단일 string (agent message) 으로 통일 — caller 가 stdout 파싱 안 해도 됨.
 *
 * 호환성: 기존 'claude -p prompt --model haiku' 호출은 default_host 가 'claude' 인
 * 경우 동일 동작. Codex 메인 사용자는 자동으로 codex exec --json 호출.
 */

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { resolveDefaultHost } from '../store/profile-store.js';
import { parseCodexJsonlOutput } from './codex-output-parser.js';
import type { HostId } from '../core/trust-layer-intent.js';

export interface ExecHostOptions {
  /**
   * ADR-015 C-G1: forgen 훅을 끄고(FORGEN_NESTED_RUN=1) 세션을 남기지 않는 "추출용 중첩 실행" 모드.
   * 기본 true. 위임 에이전트(invoke-agent)처럼 훅이 살아 있어야 하는 호출은 false.
   */
  nestedRun?: boolean;
  /** prompt — `-p`/`exec` 의 본문 */
  prompt: string;
  /** model 힌트 (claude: --model haiku, codex: 무시 — codex CLI 가 default 사용) */
  model?: string;
  /** child process timeout (ms). 미지정 시 host 별 기본값: claude 30s, codex 90s. */
  timeout?: number;
  /** working directory */
  cwd?: string;
  /** explicit host override (default: profile.default_host). */
  host?: HostId;
  /** ENV vars 추가 (기존 process.env 위에 머지) */
  env?: NodeJS.ProcessEnv;
}

/**
 * Host 별 기본 timeout. Phase 3 deferred fix:
 *   - claude -p 는 보통 1~5s 응답이라 30s 충분.
 *   - codex exec --json 은 cold start + reasoning 모드로 60~90s 정상이라
 *     30s default 가 false-positive ETIMEDOUT 발생. 90s 마진 필요.
 *   - 명시 timeout 옵션은 그대로 우선.
 */
export const DEFAULT_TIMEOUT_BY_HOST: Record<HostId, number> = {
  claude: 30_000,
  codex: 90_000,
  // opencode headless CLI: reasoning-mode 응답이 codex 처럼 길 수 있어 넉넉히(P1 실측 후 조정).
  opencode: 90_000,
};

export interface ExecHostResult {
  message: string;
  host: HostId;
  /** 토큰 사용량 (codex 만 노출. claude 는 null). */
  usage: { input_tokens?: number; output_tokens?: number } | null;
}

/**
 * 실 host CLI 를 호출하여 prompt 응답 받기.
 * - claude: `claude -p <prompt> --model <model>`
 * - codex:  `codex exec --json -s read-only -c approval_policy="never" --ephemeral --skip-git-repo-check <prompt>`
 *
 * Codex 호출은 sandbox read-only + approval never + ephemeral 로 *자동 추출 안전성*
 * 보장 (사용자 환경 미오염). compound-extractor / auto-compound-runner 같은
 * 백그라운드 학습 호출에 적합.
 */
/** ADR-015 C-G1 — forgen 이 띄우는 중첩 claude 실행의 공통 표식. hook-config.isHookEnabled 가 읽는다. */
export const NESTED_RUN_ENV: Readonly<Record<string, string>> = { FORGEN_NESTED_RUN: '1' };
/** `--no-session-persistence` 는 --print 전용 — 추출 run 의 transcript 를 디스크에 남기지 않는다. */
export const NESTED_RUN_CLAUDE_ARGS: ReadonlyArray<string> = ['--no-session-persistence'];

export function withNestedRunClaudeArgs(args: string[]): string[] {
  return args.includes('--no-session-persistence') ? args : [...args, ...NESTED_RUN_CLAUDE_ARGS];
}

export function execHost(opts: ExecHostOptions): ExecHostResult {
  const resolved = resolveDefaultHost(opts.host);
  // 'ask' 는 자동 호출 컨텍스트라 명시 fallback. 그러나 Codex-only 사용자가 'ask'
  // 설정 후 claude 가 PATH 에 없으면 ENOENT 발생 → 명시 안내. (Phase 2 critic fix)
  const host: HostId = resolved === 'codex' ? 'codex' : 'claude';
  if (resolved === 'ask' && opts.host === undefined) {
    // 자동 호출에서 'ask' 도달 — caller 가 명시 host 안 줬으므로 default fallback 안내.
    process.stderr.write(
      '[forgen exec-host] default_host="ask" — auto-call falling back to claude. ' +
      'If claude CLI is missing, set: forgen config default-host {claude|codex}\n',
    );
  }
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_BY_HOST[host];
  const baseOpts: ExecFileSyncOptions = {
    encoding: 'utf-8',
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
  };

  if (host === 'claude') {
    // ADR-015 C-G1: 중첩 실행 표식 + 세션 비영속 (추출 run 의 transcript 가 다음 SessionStart 의
    // "이전 세션 auto-compound" 후보로 잡히거나 forgen 훅이 재귀 발화하지 않도록).
    const nested = opts.nestedRun ?? true;
    const args = ['-p', opts.prompt, ...(nested ? NESTED_RUN_CLAUDE_ARGS : [])];
    if (opts.model) args.push('--model', opts.model);
    const env = nested ? { ...(baseOpts.env ?? {}), ...NESTED_RUN_ENV } : baseOpts.env;
    const stdout = execFileSync('claude', args, { ...baseOpts, env }) as unknown as string;
    return { message: stdout.toString().trim(), host: 'claude', usage: null };
  }

  // host === 'codex'
  // Phase 2 critic fix: -c approval_policy="never" 의 인용부호는 shell 처리 없이
  // execFileSync 인자라 codex 가 literal `"never"` 로 받을 위험. quote 제거 + 실측 검증.
  const args = [
    'exec',
    '--json',
    '-s', 'read-only',
    '-c', 'approval_policy=never',
    '--ephemeral',
    '--skip-git-repo-check',
    opts.prompt,
  ];
  const stdout = execFileSync('codex', args, baseOpts) as unknown as string;
  const parsed = parseCodexJsonlOutput(stdout.toString());
  return {
    message: parsed.message,
    host: 'codex',
    usage: parsed.usage ? { input_tokens: parsed.usage.input_tokens, output_tokens: parsed.usage.output_tokens } : null,
  };
}

/** 1회 retry — transient 에러(ETIMEDOUT 등) 대응. */
export function execHostRetry(opts: ExecHostOptions): ExecHostResult {
  try {
    return execHost(opts);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ETIMEDOUT' || code === 'ECONNRESET') {
      return execHost(opts);
    }
    throw e;
  }
}
