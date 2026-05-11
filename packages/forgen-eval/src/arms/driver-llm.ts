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
  }
}

// ── Codex CLI driver ────────────────────────────────────────────────────────

/** spawn-based exec — codex 가 stdin 에서 추가 input 읽는 동작을 차단. */
function runCodex(
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`codex driver timeout after ${opts.timeoutMs}ms (stderr=${stderr.slice(0, 200)})`));
    }, opts.timeoutMs);
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf-8'); });
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf-8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`codex exited ${code}: ${stderr.slice(0, 200)}`)); return; }
      resolve(stdout);
    });
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
    // judge 와 동일 격리 플래그: ignore-user-config + ignore-rules + ephemeral 로
    // 사용자 AGENTS.md / 글로벌 설정 / 세션 leakage 차단. read-only sandbox + never
    // approval 로 파괴 명령 / 승인 프롬프트 진입 차단. skip-git-repo-check 로
    // mktemp cwd 의 non-git 환경 허용.
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
        prompt,
      ],
      { cwd: this.cwd, timeoutMs: this.timeoutMs },
    );
    return parseCodexJsonOutput(raw);
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
