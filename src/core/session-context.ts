/**
 * 세션별 현재 작업 위치 (0.8.0 S1).
 *
 * MCP 서버와 러너는 자기가 어느 세션·어느 폴더에서 불렸는지 모른다(MCP 는 뜰 때 폴더를 고정한다).
 * 훅은 매번 실제 session_id 와 그 시점 cwd 를 받으므로, 훅이 그 값을 여기 적어 두고
 * MCP·러너는 이 파일과 훅이 붙여 준 origin 으로 위치를 푼다.
 *
 * 파일: `state/work-context-<세션>.json` (state-gc 가 세션 파일로 정리한다)
 * 위치 판정은 resolveWorkContext() 하나로 한다. 추측하지 않는다: 못 풀면 { kind: 'none' }.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from './paths.js';
import { atomicWriteJSON, safeReadJSON } from '../hooks/shared/atomic-write.js';
import { withFileLockSync } from '../hooks/shared/file-lock.js';
import { projectKeyFor } from '../store/rule-scope.js';

export interface WorkContextFile {
  version: 1;
  session_id: string;
  cwd: string;
  project: string | null;
  updated_at: string;
  /** 프로젝트별 사용자 턴 수(프로젝트 밖은 '-'). 러너가 세션의 주 프로젝트를 정할 때 쓴다. */
  turns: Record<string, number>;
  /** 이 세션에서 룰을 이미 넣어 준 프로젝트 (S5 위치 전환 주입). */
  injected?: string[];
  /** 0.8.0 M2: 이 세션에 실제로 들어간 룰 ID(세션 시작 블록 + 위치 전환 주입). 교정 3분류의 "주입됐다" 판정. */
  rules?: string[];
}

export type WorkVia = 'hook-input' | 'session-file' | 'process-cwd';
export type WorkContext =
  | { kind: 'project'; key: string; cwd: string; via: WorkVia }
  | { kind: 'none'; cwd?: string; via?: WorkVia };

const NO_PROJECT = '-';
const SID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function workContextPath(sessionId: string): string | null {
  if (!SID_RE.test(sessionId)) return null;
  // 새 설치에는 state 폴더가 없을 수 있다 — 잠금 파일을 만들 자리가 없으면 "한 번만 넣기" 기록이 안 남는다.
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { /* 쓰기 불가는 호출부가 fail-open */ }
  return path.join(STATE_DIR, `work-context-${sessionId}.json`);
}

export function readWorkContext(sessionId: string | undefined): WorkContextFile | null {
  if (!sessionId) return null;
  const p = workContextPath(sessionId);
  if (!p) return null;
  const f = safeReadJSON<WorkContextFile | null>(p, null);
  return f && f.version === 1 && typeof f.cwd === 'string' ? f : null;
}

/**
 * 훅이 본 위치를 적는다. countTurn 은 UserPromptSubmit 에서만 true.
 * 위치가 같고 턴을 세지 않으면 쓰지 않는다(도구 호출마다 쓰지 않게).
 * 읽기-수정-쓰기는 파일 잠금 안에서 한다(UserPromptSubmit 과 도구 훅이 겹쳐도 턴 수가 사라지지 않게).
 */
export function recordWorkContext(sessionId: string | undefined, cwd: string | undefined, opts: { countTurn?: boolean } = {}): WorkContextFile | null {
  if (!sessionId || !cwd || !path.isAbsolute(cwd)) return null;
  const p = workContextPath(sessionId);
  if (!p) return null;
  const quick = readWorkContext(sessionId);
  if (quick && quick.cwd === cwd && !opts.countTurn) return quick;
  try {
    return withFileLockSync(p, () => writeWorkContext(p, sessionId, cwd, opts));
  } catch {
    return writeWorkContext(p, sessionId, cwd, opts); // 잠금 실패 시에도 위치 기록은 남긴다(fail-open)
  }
}

function writeWorkContext(p: string, sessionId: string, cwd: string, opts: { countTurn?: boolean }): WorkContextFile {
  const prev = readWorkContext(sessionId);
  if (prev && prev.cwd === cwd && !opts.countTurn) return prev;
  const project = prev && prev.cwd === cwd ? prev.project : projectKeyFor(cwd);
  const turns = { ...(prev?.turns ?? {}) };
  if (opts.countTurn) { const k = project ?? NO_PROJECT; turns[k] = (turns[k] ?? 0) + 1; }
  const next: WorkContextFile = {
    version: 1, session_id: sessionId, cwd, project, updated_at: new Date().toISOString(), turns,
    ...(prev?.injected?.length ? { injected: prev.injected } : {}),
  };
  atomicWriteJSON(p, next, { mode: 0o600 });
  return next;
}

function fromCwd(cwd: string, via: WorkVia): WorkContext {
  const key = projectKeyFor(cwd);
  return key ? { kind: 'project', key, cwd, via } : { kind: 'none', cwd, via };
}

/**
 * 호출 시점의 작업 위치. 순서:
 *   1. 훅이 호출 입력에 붙인 origin.cwd (Claude PreToolUse updatedInput — 세션이 몇 개든 그 호출의 값)
 *   2. 세션 파일 (모델이 넘긴 session_id 로 찾음)
 *   3. fallbackCwd (MCP 프로세스 폴더 등) — allowProcessCwd 일 때만
 * 어느 것도 없으면 none. "가장 최근 세션" 같은 추측은 하지 않는다.
 */
export function resolveWorkContext(opts: { originCwd?: string; sessionId?: string; fallbackCwd?: string; allowProcessCwd?: boolean }): WorkContext {
  if (opts.originCwd && path.isAbsolute(opts.originCwd)) return fromCwd(opts.originCwd, 'hook-input');
  const f = readWorkContext(opts.sessionId);
  if (f) return f.project ? { kind: 'project', key: f.project, cwd: f.cwd, via: 'session-file' } : { kind: 'none', cwd: f.cwd, via: 'session-file' };
  if (opts.allowProcessCwd && opts.fallbackCwd) return fromCwd(opts.fallbackCwd, 'process-cwd');
  return { kind: 'none' };
}

/**
 * 세션 단위 작업(러너의 추론 교정)의 주 프로젝트: 사용자 턴의 80% 이상이 한 프로젝트면 그 키.
 * 세션 파일이 없으면 fallbackCwd 로 판정한다(예전 동작). 프로젝트가 섞였거나 밖이면 none.
 */
export function dominantProject(sessionId: string | undefined, fallbackCwd?: string, threshold = 0.8): WorkContext {
  const f = readWorkContext(sessionId);
  if (f) {
    const entries = Object.entries(f.turns ?? {});
    const total = entries.reduce((n, [, v]) => n + v, 0);
    if (total === 0) return f.project ? { kind: 'project', key: f.project, cwd: f.cwd, via: 'session-file' } : { kind: 'none', cwd: f.cwd, via: 'session-file' };
    const [top, count] = entries.sort((a, b) => b[1] - a[1])[0];
    if (top !== NO_PROJECT && count / total >= threshold) return { kind: 'project', key: top, cwd: f.cwd, via: 'session-file' };
    return { kind: 'none', cwd: f.cwd, via: 'session-file' };
  }
  return fallbackCwd ? fromCwd(fallbackCwd, 'process-cwd') : { kind: 'none' };
}

/**
 * 이 세션에서 룰을 넣어 준 프로젝트 목록을 바꾼다(잠금 안에서). reset 이면 목록을 새로 시작한다(세션 시작·압축 뒤).
 * 이미 들어 있던 키는 false 를 돌려준다 — "한 번만 넣기"의 판정.
 */
export function markProjectInjected(sessionId: string, key: string, opts: { reset?: boolean; cwd?: string; ruleIds?: string[] } = {}): boolean {
  const p = workContextPath(sessionId);
  if (!p) return false;
  const run = (): boolean => {
    const prev = readWorkContext(sessionId);
    const injected = opts.reset ? [] : [...(prev?.injected ?? [])];
    if (injected.includes(key)) return false;
    injected.push(key);
    // reset(세션 시작·압축 뒤): 그 전에 넣었던 룰은 압축으로 컨텍스트에서 사라졌으므로 "들어가 있음"에서 뺀다.
    // 그 뒤 같은 프로젝트에서 교정이 오면 위치 전환 주입이 다시 일어나 들어간 것으로 기록된다.
    const rules = [...new Set([...(opts.reset ? [] : prev?.rules ?? []), ...(opts.ruleIds ?? [])])];
    const base: WorkContextFile = prev ?? {
      version: 1, session_id: sessionId, cwd: opts.cwd ?? '', project: opts.cwd ? projectKeyFor(opts.cwd) : null, updated_at: '', turns: {},
    };
    atomicWriteJSON(p, { ...base, ...(opts.cwd ? { cwd: opts.cwd, project: projectKeyFor(opts.cwd) } : {}), updated_at: new Date().toISOString(), injected, rules }, { mode: 0o600 });
    return true;
  };
  // 잠금을 못 잡으면 "넣지 않음"이 아니라 "넣음"으로 본다 — 같은 룰이 한 번 더 들어가는 편이 영영 빠지는 것보다 낫다.
  try { return withFileLockSync(p, run); } catch { return true; }
}

/** 위치 전환 주입으로 넣은 룰 ID 를 이 세션 기록에 더한다(키 표시는 이미 markProjectInjected 가 했다). */
export function addSessionRules(sessionId: string, ruleIds: string[]): void {
  const p = workContextPath(sessionId);
  if (!p || ruleIds.length === 0) return;
  try {
    withFileLockSync(p, () => {
      const prev = readWorkContext(sessionId);
      if (!prev) return;
      atomicWriteJSON(p, { ...prev, rules: [...new Set([...(prev.rules ?? []), ...ruleIds])] }, { mode: 0o600 });
    });
  } catch { /* 기록 실패는 분류 정확도만 낮춘다 */ }
}

/** 테스트·정리용 */
export function removeWorkContext(sessionId: string): void {
  const p = workContextPath(sessionId);
  if (p) try { fs.unlinkSync(p); } catch { /* 없음 */ }
}
