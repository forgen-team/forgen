/**
 * 추출 상태 저장소 (D3 커서 + D4 대기열). 전부 FORGEN_HOME/state 아래, 파일 락으로 다중 러너 안전.
 *
 * 커서: 세션별로 "어디까지 요약에 넣었는가"(바이트 오프셋). 재실행은 새 부분만 읽는다.
 * 대기열: Haiku 호출이 타임아웃/실패한 작업을 비밀 마스킹된 요약과 함께 보관했다가 다음 러너 실행
 *  (세션 시작·종료·Stop)에서 재시도한다. 비용 폭주 방지: 시도 3회, 백오프 10분→1시간→6시간, 한 러너가
 *  재시도하는 건 1건, 대기열 20건/7일 상한. 상한을 넘겨 버려지는 건 사유와 함께 이벤트로 남긴다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { STATE_DIR } from './paths.js';
import { isHaikuCompoundEnabled } from './compound-consent.js';
import { withFileLockSync } from '../hooks/shared/file-lock.js';
import { atomicWriteJSON } from '../hooks/shared/atomic-write.js';

const CURSOR_PATH = () => path.join(STATE_DIR, 'extraction-cursors.json');
const QUEUE_PATH = () => path.join(STATE_DIR, 'extraction-queue.json');

export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
export const MAX_QUEUE = 20;
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const CLAIM_MS = 10 * 60_000;
const MAX_CURSORS = 500;

/**
 * JSON 읽기. 파일이 없으면 fallback. **있는데 깨졌으면** 손상본을 `.corrupt-<ts>.bak` 으로 보존하고(최근 3개),
 * 마지막 정상 스냅샷(`.bak`)으로 복구한다. 예전에는 조용히 fallback 을 돌려줘 다음 쓰기가 손상본째 덮어썼다.
 */
function readJson<T>(p: string, fallback: T): T {
  let raw: string;
  try { raw = fs.readFileSync(p, 'utf-8'); } catch { return fallback; }
  try { return JSON.parse(raw) as T; } catch { /* 손상 — 아래 복구 */ }
  try {
    if (raw.trim().length > 0) {
      fs.writeFileSync(`${p}.corrupt-${Date.now()}.bak`, raw);
      const old = fs.readdirSync(path.dirname(p)).filter((f) => f.startsWith(`${path.basename(p)}.corrupt-`)).sort();
      for (const f of old.slice(0, Math.max(0, old.length - 3))) fs.rmSync(path.join(path.dirname(p), f), { force: true });
    }
  } catch { /* 보존 실패는 무시 */ }
  try { return JSON.parse(fs.readFileSync(`${p}.bak`, 'utf-8')) as T; } catch { return fallback; }
}
/** 정상 파일이면 쓰기 전에 직전 상태를 `.bak` 스냅샷으로 남긴다 (손상 시 복구용). */
function snapshotGood(p: string): void {
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    JSON.parse(raw);
    fs.writeFileSync(`${p}.bak`, raw);
  } catch { /* 없거나 손상이면 스냅샷하지 않는다 — 이전 .bak 유지 */ }
}
function writeJson(p: string, value: unknown): void {
  snapshotGood(p);
  atomicWriteJSON(p, value);
}
function locked<T>(p: string, fn: () => T): T {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return withFileLockSync(p, fn, { timeoutMs: 5000, staleMs: 15000 });
}

// ── 커서 ──
type Phase_ = 'solution' | 'behavior' | 'learning';
interface CursorEntry {
  offset: number;
  at: string;
  /** 마지막으로 러너가 처리한 시점의 transcript 크기 */
  runSize?: number;
  /** 처리 시점 transcript 앞부분 지문 — 같은 크기로 내용이 바뀐 교체를 감지한다. */
  sig?: string;
  /** 새 구간이 있는데 못 넘긴 사유 (동의 OFF / 미로그인). 풀리면 같은 구간을 다시 처리한다. */
  blocked?: string;
  blockedAt?: number;
  /** 같은 구간(endOffset)에서 이미 성공한 단계 — 재실행이 같은 Haiku 호출을 반복하지 않게 한다. */
  done?: { endOffset: number; phases: Phase_[] };
}
type Cursors = Record<string, CursorEntry>;

/** transcript 앞 32KB 의 해시 + 크기. 이어 붙이기(append)는 바꾸지 않고, 같은 크기 교체는 바꾼다. */
export function transcriptSignature(filePath: string): string {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(32 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return createHash('sha1').update(buf.subarray(0, n)).digest('hex').slice(0, 16);
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

export function getCursor(sessionId: string): number {
  const c = readJson<Cursors>(CURSOR_PATH(), {})[sessionId];
  return c && Number.isFinite(c.offset) ? c.offset : 0;
}

export function setCursor(sessionId: string, offset: number): void {
  const p = CURSOR_PATH();
  locked(p, () => {
    const all = readJson<Cursors>(p, {});
    all[sessionId] = { ...all[sessionId], offset, at: new Date().toISOString() };
    const keys = Object.keys(all);
    if (keys.length > MAX_CURSORS) {
      keys.sort((a, b) => (all[a].at < all[b].at ? -1 : 1)).slice(0, keys.length - MAX_CURSORS).forEach((k) => { delete all[k]; });
    }
    writeJson(p, all);
  });
}

/**
 * 러너가 이 크기의 transcript 를 **처리 끝낸 뒤** 표시한다 (승급·인덱싱·추출 결과가 확정된 다음).
 * 추출 전에 찍으면 "아직 못 넘긴 구간"이 처리된 것으로 보여 영영 건너뛰었다 (5단계 리뷰).
 * blocked 를 주면 새 구간이 남았다는 뜻이다(동의 OFF·미로그인) — 풀리면 같은 구간을 다시 처리한다.
 */
export function markRun(sessionId: string, size: number, opts: { sig?: string; blocked?: string | null } = {}): void {
  const p = CURSOR_PATH();
  locked(p, () => {
    const all = readJson<Cursors>(p, {});
    const prev = all[sessionId];
    const next: CursorEntry = { ...prev, offset: prev?.offset ?? 0, at: new Date().toISOString(), runSize: size };
    if (opts.sig !== undefined) next.sig = opts.sig;
    if (opts.blocked) { next.blocked = opts.blocked; next.blockedAt = Date.now(); } else if (opts.blocked === null) { delete next.blocked; delete next.blockedAt; }
    all[sessionId] = next;
    writeJson(p, all);
  });
}

/** 저장된 지문과 다르면 내용이 교체된 것이다 → 커서·처리 기록을 처음으로 되돌린다. 되돌렸으면 true. */
export function resetIfReplaced(sessionId: string, sig: string): boolean {
  if (!sig) return false;
  const p = CURSOR_PATH();
  return locked(p, () => {
    const all = readJson<Cursors>(p, {});
    const c = all[sessionId];
    if (!c?.sig || c.sig === sig) return false;
    all[sessionId] = { offset: 0, at: new Date().toISOString(), sig };
    writeJson(p, all);
    return true;
  });
}

export function getDonePhases(sessionId: string, endOffset: number): Phase_[] {
  const d = readJson<Cursors>(CURSOR_PATH(), {})[sessionId]?.done;
  return d && d.endOffset === endOffset ? d.phases : [];
}
export function setDonePhases(sessionId: string, endOffset: number, phases: Phase_[]): void {
  const p = CURSOR_PATH();
  locked(p, () => {
    const all = readJson<Cursors>(p, {});
    const prev = all[sessionId] ?? { offset: 0, at: new Date().toISOString() };
    if (phases.length === 0) delete prev.done; else prev.done = { endOffset, phases };
    all[sessionId] = prev;
    writeJson(p, all);
  });
}

export const BLOCKED_RETRY_MS = 60 * 60_000;

/**
 * 이 세션을 러너가 처리해야 하는가. 트리거 경로(Stop·세션 시작·종료) 공통 판정.
 *  - 처리 이력 없음 / transcript 가 마지막 처리 이후 자람 / 같은 크기로 내용이 교체됨(sig) → 예
 *  - 자라지 않았어도 커서가 파일 끝에 못 미치면 (조금이라 미뤘거나 동의 OFF·미로그인으로 못 넘긴 구간) → 예.
 *    단 동의가 여전히 OFF 이거나 미로그인 사유가 1시간 안이면 불필요한 러너를 띄우지 않는다.
 */
export function sessionNeedsRun(sessionId: string, size: number, opts: { sig?: string; now?: number; consentEnabled?: boolean } = {}): boolean {
  const c = readJson<Cursors>(CURSOR_PATH(), {})[sessionId];
  if (!c || typeof c.runSize !== 'number' || size > c.runSize) return true;
  if (opts.sig && c.sig && opts.sig !== c.sig) return true;
  if (c.offset >= size) return false;
  const now = opts.now ?? Date.now();
  if (c.blocked?.startsWith('haiku-disabled')) return opts.consentEnabled ?? isHaikuCompoundEnabled();
  if (c.blocked?.startsWith('haiku-unavailable')) return now - (c.blockedAt ?? 0) >= BLOCKED_RETRY_MS;
  return true;
}

// ── 세션별 러너 락 (중복 Haiku 호출·중복 솔루션 차단) ──
// spawn 쪽 in-flight 표식은 spawn 시점의 게이트일 뿐이라, 표식이 만료되거나 다른 경로(세션 시작·sweep)가 띄운 러너는 겹칠 수 있다.
// 러너 자신이 시작할 때 잡는 락이 최종 방어선이다. 만료(30분) + 소유 프로세스 생존 확인으로 죽은 러너의 락을 회수한다.
export const RUNNER_LOCK_TTL_MS = 30 * 60_000;
const RUNNER_LOCK_DIR = () => path.join(STATE_DIR, 'runner-locks');
const runnerLockPath = (sessionId: string) => path.join(RUNNER_LOCK_DIR(), `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.lock`);

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function acquireRunnerLock(sessionId: string, now = Date.now(), pid = process.pid): boolean {
  const lp = runnerLockPath(sessionId);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  // 점검→회수→생성을 짧은 파일 락으로 직렬화해 두 러너가 동시에 회수하는 경쟁을 막는다.
  return withFileLockSync(lp, () => {
    try {
      const held = JSON.parse(fs.readFileSync(lp, 'utf-8')) as { pid?: number; at?: number };
      const fresh = typeof held.at === 'number' && now - held.at < RUNNER_LOCK_TTL_MS;
      if (fresh && typeof held.pid === 'number' && pidAlive(held.pid)) return false;
    } catch { /* 없음/손상 — 새로 잡는다 */ }
    fs.writeFileSync(lp, JSON.stringify({ pid, at: now }));
    return true;
  }, { timeoutMs: 3000, staleMs: 10_000 });
}

export function releaseRunnerLock(sessionId: string, pid = process.pid): void {
  const lp = runnerLockPath(sessionId);
  try {
    const held = JSON.parse(fs.readFileSync(lp, 'utf-8')) as { pid?: number };
    if (held.pid === pid) fs.rmSync(lp, { force: true });
  } catch { /* 이미 없음 */ }
}

// ── 대기열 ──
export type Phase = 'solution' | 'behavior' | 'learning';

export interface QueueEntry {
  id: string;
  sessionId: string;
  cwd: string;
  /** 비밀 마스킹·<private> 제거를 마친 요약만 저장한다. */
  summary: string;
  phases: Phase[];
  createdAt: string;
  attempts: number;
  nextAt: number;
  claimedUntil?: number;
  lastError?: string;
}

interface QueueFile { entries: QueueEntry[] }

export function readQueue(): QueueEntry[] {
  return readJson<QueueFile>(QUEUE_PATH(), { entries: [] }).entries ?? [];
}

/** 같은 세션 항목이 있으면 합친다(요약은 새것으로, 단계는 합집합). 상한 초과분은 반환해 이벤트로 남기게 한다. */
export function enqueue(job: { sessionId: string; cwd: string; summary: string; phases: Phase[]; error: string }, now = Date.now()): { dropped: QueueEntry[] } {
  const p = QUEUE_PATH();
  return locked(p, () => {
    const q = readJson<QueueFile>(p, { entries: [] });
    const dropped: QueueEntry[] = [];
    const fresh = q.entries.filter((e) => {
      if (now - Date.parse(e.createdAt) > MAX_AGE_MS) { dropped.push(e); return false; }
      return true;
    });
    const same = fresh.find((e) => e.sessionId === job.sessionId);
    if (same) {
      same.summary = job.summary.slice(0, 40_000);
      same.phases = [...new Set([...same.phases, ...job.phases])];
      same.lastError = job.error.slice(0, 200);
    } else {
      fresh.push({
        id: randomBytes(6).toString('hex'), sessionId: job.sessionId, cwd: job.cwd,
        summary: job.summary.slice(0, 40_000), phases: job.phases, createdAt: new Date(now).toISOString(),
        attempts: 0, nextAt: now + BACKOFF_MS[0], lastError: job.error.slice(0, 200),
      });
    }
    while (fresh.length > MAX_QUEUE) dropped.push(fresh.shift() as QueueEntry);
    writeJson(p, { entries: fresh });
    return { dropped };
  });
}

/** 기한이 된 항목 1건을 점유한다(다른 러너가 같은 항목을 동시에 잡지 못하게). */
export function claimDue(now = Date.now()): QueueEntry | null {
  const p = QUEUE_PATH();
  if (!fs.existsSync(p)) return null;
  return locked(p, () => {
    const q = readJson<QueueFile>(p, { entries: [] });
    const e = q.entries.find((x) => x.nextAt <= now && (x.claimedUntil ?? 0) <= now);
    if (!e) return null;
    e.claimedUntil = now + CLAIM_MS;
    writeJson(p, q);
    return { ...e };
  });
}

export function completeEntry(id: string, remaining: Phase[] = [], error?: string, now = Date.now()): { dropped: boolean } {
  const p = QUEUE_PATH();
  return locked(p, () => {
    const q = readJson<QueueFile>(p, { entries: [] });
    const e = q.entries.find((x) => x.id === id);
    if (!e) return { dropped: false };
    if (remaining.length === 0) {
      q.entries = q.entries.filter((x) => x.id !== id);
      writeJson(p, q);
      return { dropped: false };
    }
    e.attempts += 1;
    e.phases = remaining;
    e.claimedUntil = undefined;
    e.lastError = error?.slice(0, 200);
    if (e.attempts >= MAX_ATTEMPTS) {
      q.entries = q.entries.filter((x) => x.id !== id);
      writeJson(p, q);
      return { dropped: true };
    }
    e.nextAt = now + BACKOFF_MS[Math.min(e.attempts, BACKOFF_MS.length - 1)];
    writeJson(p, q);
    return { dropped: false };
  });
}
