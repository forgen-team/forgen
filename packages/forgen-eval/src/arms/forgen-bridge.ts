/**
 * forgen-bridge — invokes real forgen hooks with synthetic Claude Code payloads.
 *
 * Maps hooks (registered in ~/.claude/settings.json):
 *   UserPromptSubmit → notepad-injector.js  (rule context injection)
 *   Stop             → context-guard.js     (block / pass decision)
 *
 * Spawns child processes — no Claude Code subprocess needed. Real forgen execution.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FORGEN_HOOKS_DIR = process.env.FORGEN_HOOKS_DIR ?? '/Users/jang-ujin/study/forgen/dist/hooks';

export interface UserPromptSubmitPayload {
  prompt: string;
  session_id: string;
  cwd: string;
}

export interface UserPromptSubmitResult {
  continue: boolean;
  additionalContext?: string;
  systemMessage?: string;
}

export interface StopHookPayload {
  transcript_path: string;
  stop_hook_active: boolean;
  session_id: string;
  /** synthetic transcript content — what would normally be on disk */
  response?: string;
}

export interface StopHookResult {
  continue: boolean;
  decision?: 'block' | 'approve';
  reason?: string;
  systemMessage?: string;
}

async function invokeHook<T>(
  scriptName: string,
  stdinPayload: object,
  timeoutMs = 5000,
  env: Record<string, string> = {},
): Promise<T> {
  const scriptPath = join(FORGEN_HOOKS_DIR, scriptName);
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Hook ${scriptName} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on('data', (b) => (stdout += String(b)));
    proc.stderr.on('data', (b) => (stderr += String(b)));
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== 2) {
        reject(new Error(`Hook ${scriptName} exit ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      try {
        const parsed = stdout.trim() ? (JSON.parse(stdout.trim()) as T) : ({ continue: true } as T);
        resolve(parsed);
      } catch (e) {
        // Some hooks emit nothing or non-JSON on success — treat as continue
        resolve({ continue: true } as T);
      }
    });
    proc.stdin.write(JSON.stringify(stdinPayload));
    proc.stdin.end();
  });
}

export async function userPromptSubmitHook(p: UserPromptSubmitPayload): Promise<UserPromptSubmitResult> {
  return invokeHook<UserPromptSubmitResult>('notepad-injector.js', p);
}

export async function stopGuardHook(p: StopHookPayload): Promise<StopHookResult> {
  // Mech-B real check is in stop-guard.js (with FORGEN_SPIKE_LAST_MESSAGE env hatch).
  // This invokes the actual self-score-inflation + conclusion-ratio + fact-vs-agreement checks.
  const env: Record<string, string> = {};
  if (p.response) env.FORGEN_SPIKE_LAST_MESSAGE = p.response;
  return invokeHook<StopHookResult>('stop-guard.js', p, 8000, env);
}

export function newSessionId(): string {
  return `forgen-eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getHomeForgenDir(): string {
  return join(homedir(), '.forgen');
}
