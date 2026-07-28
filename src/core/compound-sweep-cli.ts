/**
 * forgen compound-sweep — 시간-기반 compound backstop (ADR-011).
 *
 * 이벤트 훅(Stop/PreCompact)이 fast path 라면, 이 sweep 는 **보장**이다:
 * 최근 수정된 Claude transcript 중 세션별로 오래(stale) compound 안 된 것을 쓸어담아
 * auto-compound-runner 를 돌린다. 세션 경계(재시작)에 의존하는 기존 backstop 의 갭
 * (재시작 않는 긴 세션 유실)을 시간-트리거로 메운다. cron(시간당 권장)에서 호출.
 *
 * 순수 선택 로직(selectSweepCandidates)과 IO(runCompoundSweep) 분리 — 전자는 테스트 가능.
 * 멱등·fail-open: 실패해도 세션은 다음 sweep 에서 재시도.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { STATE_DIR } from './paths.js';
import { runAutoCompound } from './spawn.js';
import { createLogger } from './logger.js';

const log = createLogger('compound-sweep');

/** sweep 대상 후보의 최소 메타. */
export interface TranscriptMeta {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  mtimeMs: number;
  promptCount: number;
}

export interface SweepOpts {
  nowMs: number;
  /** 이 시간 내 수정된 transcript 만 대상 (기본 24h). */
  windowMs: number;
  /** 세션이 이만큼 지나야 재-sweep (기본 2h). */
  staleMs: number;
  /** 최소 user 프롬프트 수 (기본 10). */
  minPrompts: number;
  /** 한 sweep 당 최대 세션 수 (비용 상한, 기본 5). */
  maxPerRun: number;
}

export const DEFAULT_SWEEP_OPTS: Omit<SweepOpts, 'nowMs'> = {
  windowMs: 24 * 60 * 60 * 1000,
  staleMs: 2 * 60 * 60 * 1000,
  minPrompts: 10,
  maxPerRun: 5,
};

type SweepState = Record<string, { sweptAt: number }>;

/**
 * 순수 선택: 최근·충분한 대화·stale(오래 안 쓸린) 세션을, oldest-swept 우선으로 maxPerRun 만큼.
 */
export function selectSweepCandidates(
  transcripts: TranscriptMeta[],
  sweepState: SweepState,
  opts: SweepOpts,
): TranscriptMeta[] {
  return transcripts
    .filter((t) => opts.nowMs - t.mtimeMs <= opts.windowMs)
    .filter((t) => t.promptCount >= opts.minPrompts)
    .filter((t) => {
      const s = sweepState[t.sessionId];
      return !s || opts.nowMs - s.sweptAt >= opts.staleMs;
    })
    .sort((a, b) => (sweepState[a.sessionId]?.sweptAt ?? 0) - (sweepState[b.sessionId]?.sweptAt ?? 0))
    .slice(0, Math.max(0, opts.maxPerRun));
}

function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR
    ? process.env.CLAUDE_CONFIG_DIR
    : path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/** user 턴 판정 — tool_result 캐리어(type:'user'지만 content 가 tool_result)는 제외.
 *  (리뷰 SEV-2: tool_result 가 promptCount 를 3~5배 부풀려 ≥10 게이트를 무력화). */
function isRealUserTurn(e: { type?: string; role?: string; message?: { role?: string; content?: unknown } }): boolean {
  if (e.type !== 'user' && e.role !== 'user' && e.message?.role !== 'user') return false;
  const content = e.message?.content;
  if (Array.isArray(content) && content.some((c) => (c as { type?: string })?.type === 'tool_result')) {
    return false; // 도구 결과 반환 — 실제 사용자 프롬프트 아님
  }
  return true;
}

/** transcript 에서 cwd + 실제 user 프롬프트 수 추출. cwd 는 라인의 cwd 필드 우선, 없으면 dir 명 역산. */
function readTranscriptMeta(transcriptPath: string, projectDirName: string): { cwd: string; promptCount: number } {
  let cwd = projectDirName.replace(/-/g, '/'); // fallback: sanitized dir → cwd (lossy, cwd 필드 없을 때만)
  let promptCount = 0;
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n');
    let cwdFound = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { type?: string; role?: string; cwd?: string; message?: { role?: string; content?: unknown } };
        if (!cwdFound && typeof e.cwd === 'string' && e.cwd) {
          cwd = e.cwd;
          cwdFound = true;
        }
        if (isRealUserTurn(e)) promptCount += 1;
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* unreadable — leave defaults */
  }
  return { cwd, promptCount };
}

/** Claude projects 하위의 최근 transcript 를 열거해 메타 구성. */
export function enumerateTranscripts(windowMs: number, nowMs: number): TranscriptMeta[] {
  const root = claudeProjectsDir();
  let projDirs: string[];
  try {
    projDirs = fs.readdirSync(root);
  } catch {
    return []; // root 없음/접근불가 — fail-open
  }
  const out: TranscriptMeta[] = [];
  for (const projDir of projDirs) {
    const abs = path.join(root, projDir);
    let files: string[];
    try {
      if (!fs.statSync(abs).isDirectory()) continue;
      files = fs.readdirSync(abs).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const fp = path.join(abs, f);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(fp).mtimeMs;
      } catch {
        continue;
      }
      if (nowMs - mtimeMs > windowMs) continue; // 창 밖은 파싱 비용도 아낌
      const { cwd, promptCount } = readTranscriptMeta(fp, projDir);
      out.push({ sessionId: f.replace(/\.jsonl$/, ''), transcriptPath: fp, cwd, mtimeMs, promptCount });
    }
  }
  return out;
}

function loadSweepState(): SweepState {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'compound-sweep-state.json'), 'utf-8')) as SweepState;
  } catch {
    return {};
  }
}

/** sweep-state 저장. 실패 시 true 반환(호출측이 무인 재과금 위험을 경고). */
function saveSweepState(state: SweepState): boolean {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'compound-sweep-state.json'), JSON.stringify(state, null, 2));
    return true;
  } catch (e) {
    log.debug('sweep-state 저장 실패', e);
    return false;
  }
}

/** window 밖으로 사라진 세션 엔트리 정리 (무한 증가 방지, 리뷰 SEV-3). */
function pruneSweepState(state: SweepState, liveSessionIds: Set<string>, nowMs: number, windowMs: number): void {
  for (const sid of Object.keys(state)) {
    if (!liveSessionIds.has(sid) && nowMs - state[sid].sweptAt > windowMs) delete state[sid];
  }
}

export interface SweepResult {
  scanned: number;
  eligible: number;
  swept: string[];
  stateSaveFailed?: boolean;
}

/**
 * cron/CLI 진입점. dryRun 이면 실행 없이 후보만 보고.
 * 무인 실행 안전장치: (1) 동시 실행 lock, (2) 실제 spawn('spawned') 만 sweptAt 기록,
 * (3) state 저장 실패 시 경고 플래그.
 */
export function runCompoundSweep(opts: { dryRun?: boolean } & Partial<Omit<SweepOpts, 'nowMs'>> = {}): SweepResult {
  const nowMs = Date.now();
  const full: SweepOpts = { nowMs, ...DEFAULT_SWEEP_OPTS, ...opts };

  // 동시 cron fire 겹침 방지 (리뷰 SEV-3): stale(>1h) lock 은 무시.
  const lockPath = path.join(STATE_DIR, 'compound-sweep.lock');
  if (!opts.dryRun) {
    try {
      const raw = fs.readFileSync(lockPath, 'utf-8');
      const { at } = JSON.parse(raw) as { at?: number };
      if (Number.isFinite(at) && nowMs - (at as number) < 60 * 60 * 1000) {
        return { scanned: 0, eligible: 0, swept: [] }; // 다른 sweep 진행 중
      }
    } catch {
      /* lock 없음/손상 — 진행 */
    }
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ at: nowMs, pid: process.pid }));
    } catch {
      /* lock 기록 실패 — 진행(단일 실행 가정) */
    }
  }

  try {
    const transcripts = enumerateTranscripts(full.windowMs, nowMs);
    const state = loadSweepState();
    const candidates = selectSweepCandidates(transcripts, state, full);

    const swept: string[] = [];
    for (const c of candidates) {
      if (opts.dryRun) {
        swept.push(c.sessionId);
        continue;
      }
      // 실제 spawn 된 경우만 sweptAt 기록 (리뷰 SEV-2: dedup-skip/실패를 완료로 오기록 금지).
      const status = runAutoCompound(c.cwd, c.transcriptPath, c.sessionId);
      if (status === 'spawned') {
        state[c.sessionId] = { sweptAt: nowMs };
        swept.push(c.sessionId);
      }
    }
    let stateSaveFailed = false;
    if (!opts.dryRun) {
      pruneSweepState(state, new Set(transcripts.map((t) => t.sessionId)), nowMs, full.windowMs);
      stateSaveFailed = !saveSweepState(state);
    }
    return { scanned: transcripts.length, eligible: candidates.length, swept, stateSaveFailed };
  } catch (e) {
    log.debug('compound-sweep 실행 실패 (fail-open)', e);
    return { scanned: 0, eligible: 0, swept: [] };
  } finally {
    if (!opts.dryRun) fs.rmSync(lockPath, { force: true });
  }
}

/** CLI: forgen compound sweep [--dry-run] [--window-hours N] [--stale-hours M] */
export function compoundSweepCli(args: string[]): void {
  const dryRun = args.includes('--dry-run');
  const num = (flag: string): number | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? Number(args[i + 1]) : undefined;
  };
  const wh = num('--window-hours');
  const sh = num('--stale-hours');
  const r = runCompoundSweep({
    dryRun,
    ...(wh ? { windowMs: wh * 3600_000 } : {}),
    ...(sh ? { staleMs: sh * 3600_000 } : {}),
  });
  console.log(
    `[forgen compound sweep] scanned=${r.scanned} eligible=${r.eligible} ` +
    `${dryRun ? 'dry-run' : 'swept'}=${r.swept.length}${r.swept.length ? ` (${r.swept.map((s) => s.slice(0, 8)).join(', ')})` : ''}`,
  );
  if (r.stateSaveFailed) {
    console.error(
      '  ⚠ sweep-state 저장 실패 — 다음 cron 이 동일 세션을 재-compound 할 수 있음(Haiku 재과금). ' +
      '~/.forgen/state 쓰기 권한을 확인하세요.',
    );
  }
}
