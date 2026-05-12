/**
 * Driver LLM — plays the "agent under test" role in simulated multi-turn dialogue.
 *
 * v0.4.4 까지: Ollama qwen2.5:14b. judge stack 만 claude-cli + codex-cli 로 옮겼고
 *   driver 는 그대로 → judge/driver stack 불일치, qwen base error rate (~30-50%)
 *   가 측정 noise 의 주요 원인.
 *
 * v0.4.5 (2026-05-11): driver 를 subscription-mode CLI (claude / codex) 로 통일.
 *   `DRIVER_TRACK` env 로 선택:
 *     - `claude` (default): claude CLI, default model = sonnet
 *     - `codex`           : codex CLI
 *     - `ollama`          : 기존 OllamaDriverLLM (회귀 비교용 leave-in)
 *   wireup: `pickDriver()` 팩토리 호출.
 *
 * 구조: 모든 driver 는 `Driver` interface 를 구현 — `chat(history) → string`.
 *   subprocess 기반 driver 는 multi-turn history 를 단일 prompt 로 flatten 한다
 *   (claude -p / codex exec 는 단일-shot 호출이라 turn 메타데이터 보존 불가).
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface Driver {
  readonly id: string;
  chat(history: ChatTurn[]): Promise<string>;
}

export interface DriverConfig {
  host?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  cwd?: string;
}

// ── Ollama (legacy) ─────────────────────────────────────────────────────────

export class OllamaDriverLLM implements Driver {
  readonly id = 'ollama' as const;
  private readonly host: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(cfg: DriverConfig = {}) {
    this.host = cfg.host ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
    this.model = cfg.model ?? process.env.OLLAMA_DRIVER_MODEL ?? 'qwen2.5:14b';
    this.temperature = cfg.temperature ?? 0.3;
    this.maxTokens = cfg.maxTokens ?? Number(process.env.OLLAMA_DRIVER_MAX_TOKENS ?? 512);
  }

  async chat(history: ChatTurn[]): Promise<string> {
    const res = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: history,
        stream: false,
        options: { temperature: this.temperature, num_predict: this.maxTokens },
      }),
    });
    if (!res.ok) throw new Error(`Ollama chat ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? '';
  }
}

// ── Shared: retry with exponential backoff ──────────────────────────────────

/**
 * Retry transient driver/judge failures with exponential backoff.
 *
 * 2026-05-12 fix: claude CLI subscription rate-limit (~108 calls/window) 발동 시
 *   "Command failed: claude -p ..." 로 모든 후속 cases arm fail. N=20 시도 →
 *   N=9 effective 로 종료 (track-N20-claude-20260511-180658). retry + backoff 로
 *   transient 한 rate-limit / network 오류 자동 회복.
 *
 * isRetryable 기본 동작 — 다음 패턴은 retry:
 *   - "Command failed" (CLI exec 실패 — 대체로 rate-limit / transient)
 *   - "rate" + "limit" 동시 포함
 *   - 5xx HTTP 류 ("503", "429", "502")
 *   - "ECONNRESET", "ETIMEDOUT" (네트워크)
 *   - "timeout after" (driver timeout — 한 번 더 시도해볼 가치)
 *
 * 다음은 retry 안 함 (deterministic / fix 필요):
 *   - "E2BIG" (arg 길이 — 코드 fix 필요)
 *   - "ENOENT" (CLI 미설치)
 *   - "exited 1" 인데 위 patterns 매칭 안 되는 경우 (입력 문제)
 */
const DEFAULT_RETRYABLE_PATTERNS = [
  /Command failed/i,
  /rate.{0,5}limit/i,
  /\b(429|502|503|504)\b/,
  /ECONNRESET|ETIMEDOUT|ENETUNREACH/,
  /timeout after/i,
  /Input exceeds the maximum length/i, // codex 1MB — 가끔 transient (response 길이 변동)
];

function defaultIsRetryable(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  if (/E2BIG|ENOENT|EACCES/.test(msg)) return false;
  return DEFAULT_RETRYABLE_PATTERNS.some((p) => p.test(msg));
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseDelayMs?: number; isRetryable?: (e: unknown) => boolean; label?: string } = {},
): Promise<T> {
  const max = opts.maxAttempts ?? Number(process.env.DRIVER_RETRY_MAX_ATTEMPTS ?? 5);
  const base = opts.baseDelayMs ?? Number(process.env.DRIVER_RETRY_BASE_MS ?? 2000);
  const retryable = opts.isRetryable ?? defaultIsRetryable;
  const label = opts.label ?? 'driver';
  let lastErr: unknown;
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!retryable(e) || attempt === max - 1) throw e;
      const delay = base * Math.pow(2, attempt);
      const reason = ((e as Error)?.message ?? String(e)).slice(0, 120);
      process.stderr.write(`  [${label}] retry ${attempt + 1}/${max - 1} after ${delay}ms — ${reason}\n`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── Shared: history → flat prompt ───────────────────────────────────────────

/** Flatten multi-turn history into a single prompt for subprocess CLI drivers.
 *  System messages 가 여러 개여도 [System] 섹션으로 그대로 보존하여 forgen rule
 *  inject + claude-mem recall 가 LLM 에 그대로 전달되게 한다. 마지막 user 메시지
 *  뒤에 "respond now" 류 trailing instruction 은 붙이지 않음 — 이미 user 가 질문.
 */
function flattenHistory(history: ChatTurn[]): string {
  const parts: string[] = [];
  for (const turn of history) {
    const tag = turn.role === 'system' ? 'System' : turn.role === 'user' ? 'User' : 'Assistant';
    parts.push(`[${tag}]\n${turn.content}`);
  }
  return parts.join('\n\n');
}

// ── Claude CLI driver ───────────────────────────────────────────────────────

const CLAUDE_DRIVER_SYSTEM_PROMPT =
  'You are a coding assistant playing the role of an LLM under behavioral evaluation. The conversation history is provided as plain text with [System]/[User]/[Assistant] tags — respond as the assistant would to the most recent [User] message, taking earlier [System] context (rules, recall) into account. Output prose only — no tool use, no file access, no markdown fences around the whole response.';

export class ClaudeCliDriver implements Driver {
  readonly id = 'claude-cli' as const;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly cwd: string;

  constructor(cfg: DriverConfig = {}) {
    this.model = cfg.model ?? process.env.CLAUDE_CLI_DRIVER_MODEL ?? 'sonnet';
    this.timeoutMs = cfg.timeoutMs ?? Number(process.env.CLAUDE_CLI_DRIVER_TIMEOUT_MS ?? 90_000);
    this.cwd = cfg.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-eval-claude-driver-'));
  }

  async chat(history: ChatTurn[]): Promise<string> {
    const prompt = flattenHistory(history);
    return await retryWithBackoff(
      async () => {
        const { stdout } = await execFileAsync(
          'claude',
          ['-p', prompt, '--model', this.model, '--system-prompt', CLAUDE_DRIVER_SYSTEM_PROMPT],
          {
            encoding: 'utf-8',
            timeout: this.timeoutMs,
            cwd: this.cwd,
            env: { ...process.env },
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        return stdout.trim();
      },
      { label: 'claude-driver' },
    );
  }
}

// ── Codex CLI driver ────────────────────────────────────────────────────────

/** spawn-based exec — long prompt 는 stdin 으로 pipe (E2BIG 방지).
 *  args 의 마지막 원소가 `-` 이면 stdinPrompt 를 stdin 에 써준다.
 */
function runCodex(
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; stdinPrompt?: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const usesStdin = args[args.length - 1] === '-' && typeof opts.stdinPrompt === 'string';
    const child = spawn('codex', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: [usesStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`codex driver timeout after ${opts.timeoutMs}ms (stderr=${stderr.slice(0, 200)})`));
    }, opts.timeoutMs);
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf-8'); });
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf-8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`codex exited ${code}: ${stderr.slice(0, 200)}`)); return; }
      resolve(stdout);
    });
    if (usesStdin && child.stdin) {
      child.stdin.on('error', (e) => { /* swallow EPIPE; close 가 reject 처리 */ void e; });
      child.stdin.end(opts.stdinPrompt);
    }
  });
}

/** Parse codex --json line-delimited output to extract assistant text. */
function parseCodexJsonOutput(raw: string): string {
  // codex exec --json 은 NDJSON 형태로 이벤트들을 출력. 마지막 assistant message
  // 콘텐츠를 추출. 형식 변경에 견고하게: agent_message / message.content 등 다양한
  // shape 를 fallback 으로 시도.
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      // 우선순위: agent_message → message.content → content
      const text =
        ev?.msg?.message ??
        ev?.agent_message ??
        ev?.message?.content ??
        ev?.content ??
        (typeof ev === 'string' ? ev : null);
      if (typeof text === 'string' && text.trim()) return text.trim();
    } catch {
      /* not JSON, skip */
    }
  }
  // fallback — raw stdout 전체
  return raw.trim();
}

export class CodexCliDriver implements Driver {
  readonly id = 'codex-cli' as const;
  private readonly timeoutMs: number;
  private readonly cwd: string;

  constructor(cfg: DriverConfig = {}) {
    this.timeoutMs = cfg.timeoutMs ?? Number(process.env.CODEX_CLI_DRIVER_TIMEOUT_MS ?? 240_000);
    this.cwd = cfg.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-eval-codex-driver-'));
  }

  async chat(history: ChatTurn[]): Promise<string> {
    const prompt = flattenHistory(history);
    // long prompt → stdin pipe (E2BIG 회피). codex exec 는 prompt arg 가 `-` 면
    // stdin 에서 읽음. judge 와 동일 격리 플래그: ignore-user-config + ignore-rules
    // + ephemeral 로 사용자 AGENTS.md / 글로벌 설정 / 세션 leakage 차단. read-only
    // sandbox + never approval 로 파괴 명령 / 승인 프롬프트 진입 차단. skip-git-
    // repo-check 로 mktemp cwd 의 non-git 환경 허용.
    return await retryWithBackoff(
      async () => {
        const raw = await runCodex(
          [
            'exec',
            '--json',
            '--ignore-user-config',
            '--ignore-rules',
            '--ephemeral',
            '-s',
            'read-only',
            '-c',
            'approval_policy="never"',
            '--skip-git-repo-check',
            '-',
          ],
          { cwd: this.cwd, timeoutMs: this.timeoutMs, stdinPrompt: prompt },
        );
        return parseCodexJsonOutput(raw);
      },
      { label: 'codex-driver' },
    );
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function pickDriver(): Driver {
  const track = (process.env.DRIVER_TRACK ?? 'claude').toLowerCase();
  if (track === 'claude' || track === 'claude-cli') return new ClaudeCliDriver();
  if (track === 'codex' || track === 'codex-cli') return new CodexCliDriver();
  if (track === 'ollama') return new OllamaDriverLLM();
  throw new Error(
    `Unknown DRIVER_TRACK=${track} — use 'claude' (default), 'codex', or 'ollama'`,
  );
}
