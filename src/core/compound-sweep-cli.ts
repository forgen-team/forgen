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

/** transcript 에서 cwd + user 프롬프트 수 추출. cwd 는 라인의 cwd 필드 우선, 없으면 dir 명 역산. */
function readTranscriptMeta(transcriptPath: string, projectDirName: string): { cwd: string; promptCount: number } {
  let cwd = projectDirName.replace(/-/g, '/'); // fallback: sanitized dir → cwd (lossy)
  let promptCount = 0;
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n');
    let cwdFound = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { type?: string; role?: string; cwd?: string };
        if (!cwdFound && typeof e.cwd === 'string' && e.cwd) {
          cwd = e.cwd;
          cwdFound = true;
        }
        if (e.type === 'user' || e.role === 'user') promptCount += 1;
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
  if (!fs.existsSync(root)) return [];
  const out: TranscriptMeta[] = [];
  for (const projDir of fs.readdirSync(root)) {
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

function saveSweepState(state: SweepState): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'compound-sweep-state.json'), JSON.stringify(state, null, 2));
  } catch (e) {
    log.debug('sweep-state 저장 실패', e);
  }
}

export interface SweepResult {
  scanned: number;
  eligible: number;
  swept: string[];
}

/** cron/CLI 진입점. dryRun 이면 실행 없이 후보만 보고. */
export function runCompoundSweep(opts: { dryRun?: boolean } & Partial<Omit<SweepOpts, 'nowMs'>> = {}): SweepResult {
  const nowMs = Date.now();
  const full: SweepOpts = { nowMs, ...DEFAULT_SWEEP_OPTS, ...opts };
  const transcripts = enumerateTranscripts(full.windowMs, nowMs);
  const state = loadSweepState();
  const candidates = selectSweepCandidates(transcripts, state, full);

  const swept: string[] = [];
  for (const c of candidates) {
    if (opts.dryRun) {
      swept.push(c.sessionId);
      continue;
    }
    try {
      runAutoCompound(c.cwd, c.transcriptPath, c.sessionId);
      state[c.sessionId] = { sweptAt: nowMs };
      swept.push(c.sessionId);
    } catch (e) {
      log.debug(`sweep 실행 실패: ${c.sessionId}`, e);
    }
  }
  if (!opts.dryRun && swept.length) saveSweepState(state);
  return { scanned: transcripts.length, eligible: candidates.length, swept };
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
    `[forgen compound-sweep] scanned=${r.scanned} eligible=${r.eligible} ` +
    `${dryRun ? 'dry-run' : 'swept'}=${r.swept.length}${r.swept.length ? ` (${r.swept.map((s) => s.slice(0, 8)).join(', ')})` : ''}`,
  );
}
