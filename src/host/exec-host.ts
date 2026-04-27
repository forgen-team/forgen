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

export interface ExecHostOptions {
  /** prompt — `-p`/`exec` 의 본문 */
  prompt: string;
  /** model 힌트 (claude: --model haiku, codex: 무시 — codex CLI 가 default 사용) */
  model?: string;
  /** child process timeout (ms). default 30s. */
  timeout?: number;
  /** working directory */
  cwd?: string;
  /** explicit host override (default: profile.default_host). */
  host?: 'claude' | 'codex';
  /** ENV vars 추가 (기존 process.env 위에 머지) */
  env?: NodeJS.ProcessEnv;
}

export interface ExecHostResult {
  message: string;
  host: 'claude' | 'codex';
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
export function execHost(opts: ExecHostOptions): ExecHostResult {
  const resolved = resolveDefaultHost(opts.host);
  // 'ask' 는 자동 호출 컨텍스트라 명시 fallback. 그러나 Codex-only 사용자가 'ask'
  // 설정 후 claude 가 PATH 에 없으면 ENOENT 발생 → 명시 안내. (Phase 2 critic fix)
  const host: 'claude' | 'codex' = resolved === 'codex' ? 'codex' : 'claude';
  if (resolved === 'ask' && opts.host === undefined) {
    // 자동 호출에서 'ask' 도달 — caller 가 명시 host 안 줬으므로 default fallback 안내.
    process.stderr.write(
      '[forgen exec-host] default_host="ask" — auto-call falling back to claude. ' +
      'If claude CLI is missing, set: forgen config default-host {claude|codex}\n',
    );
  }
  const timeout = opts.timeout ?? 30000;
  const baseOpts: ExecFileSyncOptions = {
    encoding: 'utf-8',
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
  };

  if (host === 'claude') {
    const args = ['-p', opts.prompt];
    if (opts.model) args.push('--model', opts.model);
    const stdout = execFileSync('claude', args, baseOpts) as unknown as string;
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
