/**
 * Forge Loop State — RC6 가드 (US-M1)
 *
 * 직전 forge-loop 의 findings 또는 진행 중 stories 를 ≤1KB 요약으로 렌더한다.
 * SessionStart 와 UserPromptSubmit 두 hook 이 공유하는 단일 진입점.
 *
 * RC6 자기증거: 본 세션 R1 에서 head -80 으로 forge-loop.json 을 읽어 findings
 * 8줄(line 92~99)이 잘렸음. 결과적으로 직전 결론을 컨텍스트에 못 가져 같은
 * 가설을 재발. 이 모듈은 그 회귀를 시스템 레벨에서 차단한다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from '../../core/paths.js';

const FORGE_LOOP_PATH = path.join(STATE_DIR, 'forge-loop.json');
const SOFT_STALE_MS = 24 * 60 * 60 * 1000;
const HARD_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INJECT_BYTES = 1024;
const MAX_TASK_CHARS = 240;
const MAX_FINDING_CHARS = 240;
const MAX_PENDING = 5;

interface ForgeLoopStory {
  id: string;
  title: string;
  passes?: boolean;
}

export interface ForgeLoopState {
  active?: boolean;
  task?: string;
  startedAt?: string;
  completedAt?: string;
  stories?: ForgeLoopStory[];
  findings?: Record<string, string>;
}

export function readForgeLoopState(filePath: string = FORGE_LOOP_PATH): ForgeLoopState | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (typeof raw !== 'object' || raw === null) return null;
    return raw as ForgeLoopState;
  } catch {
    return null;
  }
}

function ageMs(state: ForgeLoopState, now: number = Date.now()): number {
  const ts = state.completedAt ?? state.startedAt;
  if (!ts) return Number.POSITIVE_INFINITY;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return now - t;
}

function clipBlock(block: string): string {
  if (block.length <= MAX_INJECT_BYTES) return block;
  return `${block.slice(0, MAX_INJECT_BYTES - 3)}...`;
}

function escXml(s: string): string {
  return s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c);
}

/** SessionStart 용 — 완료된 forge-loop 의 findings 또는 진행 중 stories 요약. */
export function renderForgeLoopForSession(state: ForgeLoopState | null, now: number = Date.now()): string | null {
  if (!state) return null;
  const age = ageMs(state, now);
  if (age > HARD_STALE_MS) return null;
  const stale = age > SOFT_STALE_MS;
  const lines: string[] = [];
  const task = String(state.task ?? '').trim();
  if (task) lines.push(`Task: ${escXml(task.slice(0, MAX_TASK_CHARS))}`);

  if (state.active && Array.isArray(state.stories)) {
    const total = state.stories.length;
    const done = state.stories.filter(s => s?.passes).length;
    lines.push(`Status: in-progress ${done}/${total}${stale ? ' (stale)' : ''}`);
    const pending = state.stories
      .filter(s => !s?.passes)
      .slice(0, MAX_PENDING)
      .map(s => `- ${escXml(String(s.id))}: ${escXml(String(s.title))}`);
    if (pending.length) {
      lines.push('Pending:');
      lines.push(...pending);
    }
  } else if (state.findings && typeof state.findings === 'object') {
    lines.push(`Status: completed${stale ? ' (stale)' : ''}`);
    for (const [id, val] of Object.entries(state.findings)) {
      const text = String(val ?? '').slice(0, MAX_FINDING_CHARS);
      if (text) lines.push(`- ${escXml(id)}: ${escXml(text)}`);
    }
  } else {
    return null;
  }

  if (lines.length === 0) return null;
  const tag = stale ? '<forge-loop-state stale="true">' : '<forge-loop-state>';
  const body = lines.join('\n');
  return clipBlock(`${tag}\n${body}\n</forge-loop-state>`);
}

/** UserPromptSubmit 용 — active=true 시에만 짧은 진행 상황 1~2줄. */
export function renderForgeLoopForPrompt(state: ForgeLoopState | null, now: number = Date.now()): string | null {
  if (!state || !state.active || !Array.isArray(state.stories)) return null;
  const age = ageMs(state, now);
  if (age > HARD_STALE_MS) return null;
  const total = state.stories.length;
  const done = state.stories.filter(s => s?.passes).length;
  const next = state.stories.find(s => !s?.passes);
  if (!next) return null;
  const stale = age > SOFT_STALE_MS;
  const tag = stale ? '<forge-loop-active stale="true">' : '<forge-loop-active>';
  const body = `Progress: ${done}/${total} | next: ${escXml(String(next.id))} ${escXml(String(next.title))}`;
  return clipBlock(`${tag}\n${body}\n</forge-loop-active>`);
}

/** 테스트 노출용 상수 — 회귀 시 임계값 변경 즉시 감지. */
export const FORGE_LOOP_LIMITS = {
  SOFT_STALE_MS,
  HARD_STALE_MS,
  MAX_INJECT_BYTES,
  MAX_PENDING,
} as const;
