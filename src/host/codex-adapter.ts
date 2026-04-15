#!/usr/bin/env node

/**
 * Codex 훅 어댑터
 *
 * 목적:
 * - codex 런타임에서 실행되는 훅 스크립트 출력을 Claude Hook schema로 정규화
 * - continue 누락 또는 codex 특화 판정 필드(approved/decision) 대응
 * - 파싱 실패/실행 실패 시 fail-open(continue: true)
 */

import { spawnSync } from 'node:child_process';
import { type HookEventInput, type HookEventOutput } from '../core/types.js';

function parseDecision(raw: unknown): { continueFlag: boolean; permissionDecision?: string } {
  if (typeof raw === 'boolean') {
    return { continueFlag: raw };
  }
  if (typeof raw === 'string') {
    const normalized = raw.toLowerCase();
    if (normalized === 'continue') return { continueFlag: true };
    if (normalized === 'stop' || normalized === 'deny' || normalized === 'reject' || normalized === 'block') {
      return { continueFlag: false, permissionDecision: normalized };
    }
    return { continueFlag: true };
  }
  if (typeof raw !== 'object' || raw === null) return { continueFlag: true };
  const value = (raw as { decision?: unknown }).decision;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (normalized === 'deny' || normalized === 'reject' || normalized === 'block') {
      return { continueFlag: false, permissionDecision: normalized };
    }
    if (normalized === 'ask' || normalized === 'prompt' || normalized === 'confirm') {
      return { continueFlag: true, permissionDecision: normalized };
    }
  }
  if (typeof (raw as { approved?: unknown }).approved === 'boolean') {
    const approved = (raw as { approved: boolean }).approved;
    return approved
      ? { continueFlag: true, permissionDecision: (raw as { decision?: string }).decision || 'approve' }
      : { continueFlag: false, permissionDecision: 'deny' };
  }
  if (typeof (raw as { continue: unknown }).continue === 'boolean') {
    return { continueFlag: (raw as { continue: boolean }).continue };
  }
  return { continueFlag: true };
}

function lastJSONObjectFromText(raw: string): unknown | null {
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeOutput(raw: unknown, input: HookEventInput): HookEventOutput {
  const result: HookEventOutput = { continue: true };
  const decision = parseDecision(raw);
  result.continue = decision.continueFlag;

  if (typeof raw === 'object' && raw !== null) {
    const payload = raw as Record<string, unknown>;
    if (typeof payload.continue === 'boolean') result.continue = payload.continue;
    if (typeof payload.systemMessage === 'string') result.systemMessage = payload.systemMessage;
    if (typeof payload.suppressOutput === 'boolean') result.suppressOutput = payload.suppressOutput;
    if (typeof payload.hookSpecificOutput === 'object' && payload.hookSpecificOutput !== null) {
      result.hookSpecificOutput = { ...(payload.hookSpecificOutput as Record<string, unknown>) };
    }

    if (typeof (payload as { decision?: unknown }).decision === 'string') {
      result.hookSpecificOutput = {
        ...(result.hookSpecificOutput ?? {}),
        permissionDecision: (payload as { decision: string }).decision,
      };
    }
  }

  const eventName = result.hookSpecificOutput?.hookEventName ?? input.hookEventName ?? input.event;
  if (eventName) {
    result.hookSpecificOutput = {
      hookEventName: eventName,
      ...(result.hookSpecificOutput ?? {}),
    };
  }

  if (!result.continue && !result.hookSpecificOutput?.permissionDecision) {
    if (decision.permissionDecision) result.hookSpecificOutput = {
      ...(result.hookSpecificOutput ?? {}),
      permissionDecision: decision.permissionDecision,
    };
    else result.hookSpecificOutput = { ...(result.hookSpecificOutput ?? {}), permissionDecision: 'deny' };
  }

  return result;
}

async function main(): Promise<void> {
  const [delegatePath, ...restArgs] = process.argv.slice(2);
  if (!delegatePath) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  const input = await (async () => {
    const chunks: Array<Buffer | string> = [];
    let totalBytes = 0;
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > 10 * 1024 * 1024) break;
    }
    const raw = Buffer.concat(chunks.map(c => typeof c === 'string' ? Buffer.from(c) : c)).toString('utf-8').trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw) as HookEventInput;
    } catch {
      return {};
    }
  })();

  try {
    const result = spawnSync(process.execPath, [delegatePath, ...restArgs], {
      encoding: 'utf-8',
      input: JSON.stringify(input),
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.error) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const parsed = lastJSONObjectFromText(result.stdout ?? '');
    if (!parsed) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const output = normalizeOutput(parsed, input as HookEventInput);
    console.log(JSON.stringify(output));
  } catch {
    console.log(JSON.stringify({ continue: true }));
  }
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
});
