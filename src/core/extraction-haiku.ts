/**
 * 추출용 중첩 Haiku 호출 (D4) + 호출 가능 여부 판정 (D2).
 *
 * - 중첩 호출은 사용자의 플러그인·hook·MCP·슬래시 명령·도구를 전혀 끌어오지 않는다:
 *   `--tools "" --strict-mcp-config --setting-sources "" --disable-slash-commands --no-session-persistence`
 *   (실측 2026-11-04: init 이벤트 tools=[] mcp_servers=[] skills=[] slash_commands=[], 로그인 유지).
 *   프롬프트는 argv 가 아니라 stdin 으로 넘긴다(32K자 한글은 argv 상한 128KB 에 근접).
 * - 호출마다 소요 ms·결과·사유를 extraction-events.jsonl 에 남긴다. 실패는 분류해서 돌려주고, 재시도 정책은
 *   호출자(러너 + 대기열)가 가진다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { FORGEN_HOME, STATE_DIR } from './paths.js';
import { rotateIfBig } from '../engine/lifecycle/signals.js';
import { NESTED_RUN_ENV, execHost } from '../host/exec-host.js';
import { resolveDefaultHost } from '../store/profile-store.js';

/**
 * 호출당 타임아웃. 실측(재생 13회, 2026-11-04): 입력 0.9~17K자에서 응답 3~35초(최대 34.8초, 17K자 학습 단계).
 * 최악의 3.4배 여유로 120초. 이보다 오래 걸리면 호출이 아니라 환경 문제이므로 대기열로 보낸다.
 */
export const HAIKU_TIMEOUT_MS = 120_000;

/** 재생/장애 주입 실험용 재정의 (1초 미만은 무시). */
function timeoutOverride(): number | undefined {
  const n = Number(process.env.FORGEN_HAIKU_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? n : undefined;
}

export type HaikuOutcome = 'ok' | 'timeout' | 'rate-limited' | 'unavailable' | 'error';
export interface HaikuResult {
  ok: boolean;
  outcome: HaikuOutcome;
  output: string;
  ms: number;
  reason?: string;
  /** 대기열에서 재시도할 가치가 있는가 (미설치·미로그인은 재시도해도 같다) */
  retriable: boolean;
}

export const NESTED_ISOLATION_ARGS: ReadonlyArray<string> = [
  '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
];

/** 격리 옵션을 빼면 사용자 플러그인·hook·MCP·도구가 중첩 호출로 새어 들어오므로, 이 옵션을 모르는 CLI 에서는 재호출하지 않고 멈춘다. */
const ISOLATION_CRITICAL_OPTIONS = new Set(['--tools', '--strict-mcp-config', '--setting-sources']);
/** 값을 받는 옵션 (빼면 값도 함께 뺀다). */
const OPTIONS_WITH_VALUE = new Set(['--tools', '--setting-sources', '--model']);
const UNKNOWN_OPTION_RE = /unknown (?:option|argument|flag)[:\s'"`]*(--[a-z][a-z0-9-]*)|unrecognized (?:option|argument)[:\s'"`]*(--[a-z][a-z0-9-]*)|(--[a-z][a-z0-9-]*)['"`]?\s+(?:is not|not a) (?:a )?(?:valid|recognized|supported)/i;

/** stderr 에서 CLI 가 모른다고 한 옵션 이름을 뽑는다 (없으면 null). */
export function parseUnknownOption(text: string): string | null {
  const m = text.match(UNKNOWN_OPTION_RE);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/** args 에서 옵션(과 값)을 제거한다. */
export function dropOption(args: ReadonlyArray<string>, opt: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === opt) { if (OPTIONS_WITH_VALUE.has(opt)) i++; continue; }
    out.push(args[i]);
  }
  return out;
}

/**
 * 인증이 settings 파일(apiKeyHelper·프록시 base URL/토큰)에서 오는가. 중첩 호출은 `--setting-sources ""` 로 settings 를
 * 읽지 않으므로 이런 환경에서는 인증이 빠져 실패한다 — "로그인 필요"와 다른 원인이라 구분해 보여 준다.
 */
export function settingsProvidedAuth(): string | null {
  const dirs = [process.env.CLAUDE_CONFIG_DIR, path.join(process.env.HOME ?? '', '.claude')].filter((d): d is string => !!d);
  for (const dir of dirs) {
    for (const f of ['settings.json', 'settings.local.json']) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as { apiKeyHelper?: unknown; env?: Record<string, unknown> };
        if (j.apiKeyHelper) return 'apiKeyHelper';
        if (j.env && (j.env.ANTHROPIC_BASE_URL || j.env.ANTHROPIC_AUTH_TOKEN || j.env.ANTHROPIC_API_KEY)) return 'env(프록시/토큰)';
      } catch { /* 없음 */ }
    }
  }
  return null;
}

const AUTH_RE = /not logged in|please run \/login|invalid api key|authentication|unauthorized|credit balance/i;
const RATE_RE = /usage limit|rate.?limit|429|overloaded|quota/i;

export function classifyFailure(err: { code?: string; signal?: string | null; stderr?: string; stdout?: string; message?: string }): { outcome: HaikuOutcome; reason: string; retriable: boolean } {
  const text = `${err.stderr ?? ''}\n${err.stdout ?? ''}\n${err.message ?? ''}`;
  if (err.code === 'ENOENT') return { outcome: 'unavailable', reason: 'claude CLI 를 찾지 못함', retriable: false };
  if (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM') return { outcome: 'timeout', reason: `타임아웃 ${(timeoutOverride() ?? HAIKU_TIMEOUT_MS) / 1000}s`, retriable: true };
  const unknownOpt = parseUnknownOption(text);
  if (unknownOpt) return { outcome: 'unavailable', reason: `claude CLI 가 옵션 ${unknownOpt} 를 모름 — claude 업데이트 필요`, retriable: false };
  if (AUTH_RE.test(text)) {
    const viaSettings = settingsProvidedAuth();
    if (viaSettings) return { outcome: 'unavailable', reason: `인증이 settings(${viaSettings})에서 오는데 추출 호출은 격리를 위해 settings 를 읽지 않음 — 환경변수로 인증을 주거나 forgen compound consent off`, retriable: false };
    return { outcome: 'unavailable', reason: 'claude 로그인 필요 (claude /login)', retriable: false };
  }
  if (RATE_RE.test(text)) return { outcome: 'rate-limited', reason: '사용량 한도/과부하', retriable: true };
  return { outcome: 'error', reason: (text.trim().split('\n')[0] || 'unknown').slice(0, 160), retriable: true };
}

export function appendExtractionEvent(ev: Record<string, unknown>): void {
  const p = path.join(FORGEN_HOME, 'state', 'extraction-events.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  rotateIfBig(p);
  fs.appendFileSync(p, `${JSON.stringify({ at: new Date().toISOString(), ...ev })}\n`);
}

/** 마지막 호출 결과 — status/세션 시작이 "왜 Haiku 가 안 도는지"를 말하는 근거. */
export function writeHaikuStatus(s: { ok: boolean; outcome: HaikuOutcome; reason?: string }): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'haiku-status.json'), JSON.stringify({ at: new Date().toISOString(), ...s }));
  } catch { /* 기록 실패는 무시 */ }
}

export function readHaikuStatus(): { at: string; ok: boolean; outcome: HaikuOutcome; reason?: string } | null {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'haiku-status.json'), 'utf-8')); } catch { return null; }
}

/** 호출 없이 판정: claude 미설치 / 미로그인(`claude auth status`는 모델을 호출하지 않는다). */
export function probeClaudeAvailability(): { available: boolean; reason?: string } {
  try {
    const out = execFileSync('claude', ['auth', 'status'], { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...NESTED_RUN_ENV } });
    try {
      const j = JSON.parse(out) as { loggedIn?: boolean };
      if (j.loggedIn === false) return { available: false, reason: 'claude 로그인 필요 (claude /login)' };
    } catch { /* 형식이 달라도 성공 종료면 가용으로 본다 */ }
    return { available: true };
  } catch (e) {
    const er = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (er.code === 'ENOENT') return { available: false, reason: 'claude CLI 를 PATH 에서 찾지 못함' };
    if (er.code === 'ETIMEDOUT') return { available: true }; // 판정 불가 → 시도는 허용
    const text = `${er.stdout ?? ''}${er.stderr ?? ''}`;
    if (/loggedIn"?\s*:\s*false|not logged in/i.test(text)) return { available: false, reason: 'claude 로그인 필요 (claude /login)' };
    return { available: true };
  }
}

/**
 * Haiku 한 번 호출 (동기). 러너는 detached 프로세스라 이 대기는 다른 세션을 막지 않는다.
 * prompt 는 stdin 으로 전달한다.
 */
export function callHaiku(phase: string, prompt: string, opts: { cwd: string; timeoutMs?: number; attempt?: number; sessionId?: string }): HaikuResult {
  const t0 = Date.now();
  const timeout = opts.timeoutMs ?? timeoutOverride() ?? HAIKU_TIMEOUT_MS;
  if (resolveDefaultHost() === 'codex') return callCodex(phase, prompt, opts.cwd, timeout, opts.attempt ?? 0, opts.sessionId);
  const run = (args: string[]) => spawnSync('claude', args, {
    input: prompt, cwd: opts.cwd, encoding: 'utf-8', timeout, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...NESTED_RUN_ENV },
  });
  let args = ['-p', '--model', 'haiku', ...NESTED_ISOLATION_ARGS];
  let r = run(args);
  // 구버전 Claude Code 가 격리 옵션 중 일부를 모를 때(`unknown option`): 격리에 필수가 아닌 옵션이면 그것만 빼고 **1회만** 다시 부른다.
  // 필수 격리 옵션(--tools/--strict-mcp-config/--setting-sources)이면 격리 없이 돌릴 수 없으니 재시도하지 않고 사유를 남긴다.
  const droppedOptions: string[] = [];
  // 옵션을 거절한 CLI 는 stdin 을 읽기 전에 끝나므로 프롬프트 쓰기가 EPIPE 로 실패할 수 있다. 프로세스는 정상 종료했으니 실행 실패가 아니다.
  const firstRunFailed = r.error && (r.error as NodeJS.ErrnoException).code !== 'EPIPE';
  if (r.status !== 0 && !firstRunFailed) {
    const unknownOpt = parseUnknownOption(`${r.stderr ?? ''}\n${r.stdout ?? ''}`);
    if (unknownOpt && args.includes(unknownOpt) && !ISOLATION_CRITICAL_OPTIONS.has(unknownOpt)) {
      args = dropOption(args, unknownOpt);
      droppedOptions.push(unknownOpt);
      r = run(args);
    }
  }
  const ms = Date.now() - t0;
  let res: HaikuResult;
  const errObj = r.error as (NodeJS.ErrnoException | undefined);
  if (!errObj && r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim().length > 0) {
    res = { ok: true, outcome: 'ok', output: r.stdout, ms, retriable: false };
  } else {
    const c = classifyFailure({
      code: errObj?.code, signal: r.signal, stderr: r.stderr, stdout: r.stdout,
      message: errObj?.message ?? (r.status === 0 ? '빈 응답' : `exit ${r.status}`),
    });
    res = { ok: false, outcome: c.outcome, output: '', ms, reason: c.reason, retriable: c.retriable };
  }
  try {
    appendExtractionEvent({ kind: 'haiku-call', phase, ms, outcome: res.outcome, ...(res.reason ? { reason: res.reason } : {}), attempt: opts.attempt ?? 0, promptChars: prompt.length, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}), ...(droppedOptions.length ? { droppedOptions } : {}) });
  } catch { /* 기록 실패는 무시 */ }
  writeHaikuStatus({ ok: res.ok, outcome: res.outcome, reason: res.reason });
  return res;
}

/** Codex 호스트 사용자: 같은 경계(소요·사유 기록)로 codex exec 를 쓴다. 격리는 exec-host 의 ephemeral/read-only. */
function callCodex(phase: string, prompt: string, cwd: string, timeout: number, attempt: number, sessionId?: string): HaikuResult {
  const t0 = Date.now();
  let res: HaikuResult;
  try {
    const r = execHost({ prompt: prompt.slice(0, 36_000), host: 'codex', timeout, cwd });
    res = { ok: true, outcome: 'ok', output: r.message, ms: Date.now() - t0, retriable: false };
  } catch (e) {
    const er = e as NodeJS.ErrnoException & { stderr?: string; stdout?: string; signal?: string };
    const c = classifyFailure({ code: er.code, signal: er.signal, stderr: String(er.stderr ?? ''), stdout: String(er.stdout ?? ''), message: er.message });
    res = { ok: false, outcome: c.outcome, output: '', ms: Date.now() - t0, reason: c.reason, retriable: c.retriable };
  }
  try { appendExtractionEvent({ kind: 'haiku-call', host: 'codex', phase, ms: res.ms, outcome: res.outcome, ...(res.reason ? { reason: res.reason } : {}), attempt, promptChars: prompt.length, ...(sessionId ? { sessionId } : {}) }); } catch { /* ignore */ }
  writeHaikuStatus({ ok: res.ok, outcome: res.outcome, reason: res.reason });
  return res;
}
