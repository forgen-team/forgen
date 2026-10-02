#!/usr/bin/env node

/**
 * Codex `notify` 폴백 — ADR-016 D1
 *
 * Codex 는 config.toml 의 top-level `notify = [argv…]` 프로그램을 **턴 완료마다**(Stop 훅 뒤) detached 로
 * 실행하고, JSON 페이로드를 마지막 argv 로 넘긴다. 훅과 달리 **신뢰(trust) 승인과 무관**하게 돈다.
 * forgen 은 이것을 "훅이 조용히 skip 되는 동안의 안전망" 으로만 쓴다:
 *
 *   1. forgen 훅이 살아 있으면(codex-adapter 가 방금 alive 마커를 갱신) 아무것도 하지 않는다 —
 *      auto-compound 는 Stop 훅(context-guard) 소관이다.
 *   2. 훅이 돌지 않았으면 silent 플래그를 남기고(`forgen doctor` 가 노출), 세션이 충분히 길면 Stop 훅과
 *      같은 디바운스 경로로 auto-compound 를 띄운다.
 *
 * 페이로드 (codex-rs/hooks/src/legacy_notify.rs, 0.153.4):
 *   { "type":"agent-turn-complete", "thread-id", "turn-id", "cwd", "client"?, "input-messages":[…],
 *     "last-assistant-message" }  — transcript 경로는 없다. `thread-id` 로 rollout 파일을 찾는다.
 *
 * argv: `codex-notify.js [-- <chain program> <args…>] <payload JSON>`
 *   `--` 뒤는 사용자가 수동으로 체인한 자기 notifier (단일 argv 제약 우회). 페이로드를 붙여 먼저 전달한다.
 *
 * 실패 정책: 모든 단계 fail-open. stdout/stderr 는 Codex 가 /dev/null 로 버린다.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from '../core/paths.js';
import { isCodexHookAlive } from './codex-hook-alive.js';
import { countCodexUserPrompts, findCodexRollout } from './codex-rollout.js';

export const CODEX_HOOKS_SILENT_PATH = path.join(STATE_DIR, 'codex-hooks-silent.json');

/** silent 플래그 유효기간 — 이보다 오래된 관측은 doctor 가 무시한다. */
const SILENT_TTL_MS = 24 * 60 * 60 * 1000;
/** Stop 훅 경로와 같은 "의미 있는 세션" 임계. */
const MIN_USER_PROMPTS = 10;

export interface CodexNotifyPayload {
  type?: string;
  'thread-id'?: string;
  'turn-id'?: string;
  cwd?: string;
  client?: string;
}

export interface CodexHooksSilent {
  detectedAt: string;
  sessionId: string;
  cwd: string;
  /** 연속으로 관측된 silent 턴 수 */
  count: number;
}

export type NotifyOutcome =
  | 'nested-run'
  | 'no-payload'
  | 'ignored-event'
  | 'hooks-alive'
  | 'silent-recorded'
  | 'silent-compound-spawned';

/** argv(스크립트 뒤) → 체인 프로그램 + 페이로드. 페이로드는 항상 마지막 argv. */
export function parseNotifyArgv(argv: string[]): { chain: string[]; payloadRaw: string | null; payload: CodexNotifyPayload | null } {
  if (argv.length === 0) return { chain: [], payloadRaw: null, payload: null };
  const payloadRaw = argv[argv.length - 1];
  const chain = argv[0] === '--' ? argv.slice(1, -1) : [];
  let payload: CodexNotifyPayload | null = null;
  try {
    const parsed = JSON.parse(payloadRaw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as CodexNotifyPayload;
  } catch { /* 페이로드 아님 */ }
  return { chain, payloadRaw, payload };
}

/** doctor 용 — 유효(24h 이내)한 silent 관측만 반환. */
export function readCodexHooksSilent(now: number = Date.now()): CodexHooksSilent | null {
  try {
    const s = JSON.parse(fs.readFileSync(CODEX_HOOKS_SILENT_PATH, 'utf-8')) as CodexHooksSilent;
    const at = Date.parse(s.detectedAt);
    if (!Number.isFinite(at) || now - at > SILENT_TTL_MS) return null;
    if (typeof s.sessionId !== 'string' || typeof s.count !== 'number') return null;
    return s;
  } catch {
    return null;
  }
}

function recordSilent(sessionId: string, cwd: string, now: number): void {
  const prev = readCodexHooksSilent(now);
  const next: CodexHooksSilent = {
    detectedAt: new Date(now).toISOString(),
    sessionId,
    cwd,
    count: (prev?.count ?? 0) + 1,
  };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CODEX_HOOKS_SILENT_PATH, JSON.stringify(next));
}

function clearSilent(): void {
  try { fs.rmSync(CODEX_HOOKS_SILENT_PATH, { force: true }); } catch { /* noop */ }
}

function runChain(chain: string[], payloadRaw: string): void {
  if (chain.length === 0) return;
  try {
    const child = spawn(chain[0], [...chain.slice(1), payloadRaw], { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* 사용자 notifier 부재 — 무시 */ });
    child.unref();
  } catch { /* fail-open */ }
}

export interface NotifyDeps {
  now?: number;
  env?: NodeJS.ProcessEnv;
  /** 테스트 주입: auto-compound 디바운스 트리거 */
  spawnCompound?: (sessionId: string, transcriptPath: string, promptCount: number, cwd: string) => Promise<boolean>;
}

export async function handleNotify(argv: string[], deps: NotifyDeps = {}): Promise<NotifyOutcome> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now();

  // forgen 자신의 추출용 `codex exec` — 재귀/오탐 방지 (env 는 Codex 세션 시작 시점 스냅샷으로 상속된다).
  if (env.FORGEN_NESTED_RUN === '1') return 'nested-run';

  const { chain, payloadRaw, payload } = parseNotifyArgv(argv);
  if (payloadRaw !== null) runChain(chain, payloadRaw);
  if (!payload) return 'no-payload';
  if (payload.type !== 'agent-turn-complete') return 'ignored-event';

  if (isCodexHookAlive(now)) {
    clearSilent();
    return 'hooks-alive';
  }

  const sessionId = typeof payload['thread-id'] === 'string' ? payload['thread-id'] : 'unknown';
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : process.cwd();
  try { recordSilent(sessionId, cwd, now); } catch { /* fail-open */ }

  // 훅이 돌지 않으므로 Stop 트리거 auto-compound 도 없다 → 같은 디바운스 경로로 대신 띄운다.
  try {
    const codexHome = env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const rollout = findCodexRollout(codexHome, sessionId);
    if (!rollout) return 'silent-recorded';
    const prompts = countCodexUserPrompts(rollout);
    if (prompts < MIN_USER_PROMPTS) return 'silent-recorded';
    const spawnCompound = deps.spawnCompound ?? (async (sid, transcript, count, dir) => {
      // 러너가 host 를 codex 로 해석하도록 (훅 경로에선 codex-adapter 가 주입한다).
      process.env.FORGEN_RUNTIME = 'codex';
      const { maybeSpawnAutoCompound } = await import('../hooks/context-guard.js');
      return maybeSpawnAutoCompound(sid, transcript, count, dir);
    });
    return (await spawnCompound(sessionId, rollout, prompts, cwd)) ? 'silent-compound-spawned' : 'silent-recorded';
  } catch {
    return 'silent-recorded';
  }
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  handleNotify(process.argv.slice(2)).catch(() => { /* fail-open */ });
}
