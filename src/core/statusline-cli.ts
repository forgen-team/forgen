/**
 * forgen statusline — Claude Code statusLine 명령 (ADR-017 D4/D5 재설계, 2026-10-06)
 *
 * Claude Code 는 assistant 메시지마다(300ms 디바운스) statusLine.command 를 호출하고 stdin 에 JSON 을
 * 준다 (공식: code.claude.com/docs/en/statusline — context_window / rate_limits / cost / model / workspace).
 *
 * 2줄 고정:
 *   1줄 (사용자): 모델 · 경로(브랜치) · ctx 42%/1M · 5h 63% → 15:40 소진 (리셋 16:20) · 7d 21% → 리셋 … 여유 · $1.23
 *   2줄 (forgen): 관련 룰 3 · 이 세션 차단 1 · 7d 차단 33 · surfaced 0   (turn-rules 파일 없으면 '룰 N' = 활성 수)
 *
 * 원칙 (ADR-017 §2): 출처 없는 숫자는 표시하지 않는다. 데이터가 없으면 세그먼트를 생략한다(자리 채우기 금지).
 * 이전 3~4줄의 운영자 지표(recall/ROI/이모지 분포)는 `forgen status` 에 있고, CLAUDE.md·MCP·hook 카운트는
 * **삭제**했다(MCP 카운트는 settings.json 만 읽어 0 으로 틀렸고, 어느 뷰에도 없다 — critic 정정). 사용량
 * 세그먼트는 ADR-010 §2b 로 철수했으나 본 ADR 이 그 결정을 부분 supersede 한다(CC 가 stdin 으로 직접 제공).
 *
 * 캐시(critic SEV-2 반영): 1줄(사용자)은 매 호출 렌더(0.1s 이하). 2줄(forgen, computeStats 전체 스캔
 * ~150ms)은 **세션별 별도 캐시 15초 TTL** — ctx% 가 메시지마다 바뀌어도 2줄 비용은 15초에 1회.
 * 샘플 기록(D5)과 모델 캐시는 캐시와 무관하게 매 호출 수행.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { loadActiveRules } from '../store/rule-store.js';
import { STATE_DIR } from './paths.js';
import { computeStats } from './stats-cli.js';
import { isRealBlock } from '../engine/lifecycle/signals.js';
import { sanitizeId } from '../hooks/shared/sanitize-id.js';
import { readTurnRules } from '../engine/rule-relevance.js';
import {
  samplesFromPayload, appendSamples, readSamples, compactSamples, forecastAll, fmtForecast,
  type RateLimitsPayload, type Forecast,
} from './rate-limit-forecast.js';

const FORGEN_LINE_TTL_MS = 15_000;

// ANSI codes
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const SEP = `${DIM} · ${RESET}`;

/** 공식 statusline stdin 스키마의 부분집합 (2026-10 확인). 전부 optional — 구버전/다른 플랜은 비어 있을 수 있다. */
export interface StdinPayload {
  session_id?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  context_window?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
    used_percentage?: number | null;
    remaining_percentage?: number | null;
  };
  rate_limits?: RateLimitsPayload | null;
  cost?: { total_cost_usd?: number; total_duration_ms?: number };
  exceeds_200k_tokens?: boolean;
  [key: string]: unknown;
}

export function readStdinJson(): StdinPayload {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync('/dev/stdin', 'utf-8').trim();
    if (!raw) return {};
    return JSON.parse(raw) as StdinPayload;
  } catch {
    return {};
  }
}

function getGitBranch(cwd: string): string {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    const isDirty = (() => {
      try {
        return execSync('git status --porcelain', { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim().length > 0;
      } catch { return false; }
    })();
    return `${branch}${isDirty ? '*' : ''}`;
  } catch {
    return '';
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 한도/컨텍스트 공통 색: ≥95 빨강, ≥80 노랑, 그 외 기본. */
function pctColor(pct: number): string {
  if (pct >= 95) return RED;
  if (pct >= 80) return YELLOW;
  return '';
}
function colored(text: string, color: string): string {
  return color ? `${color}${text}${RESET}` : text;
}

function fmtWindowSize(size: number | undefined): string {
  if (!isNum(size) || size <= 0) return '';
  if (size >= 1_000_000) return `/${Math.round(size / 1_000_000)}M`;
  return `/${Math.round(size / 1000)}k`;
}

/** 1줄: 사용자 정보. 데이터 없는 세그먼트는 생략. */
export function buildUserLine(payload: StdinPayload, cwd: string, forecasts: Partial<Record<'five_hour' | 'seven_day', Forecast>>, nowMs: number): string {
  const parts: string[] = [];
  parts.push(`${BOLD}${CYAN}${payload.model?.display_name ?? 'Claude'}${RESET}`);

  const branch = getGitBranch(cwd);
  const cwdDisplay = cwd.replace(os.homedir(), '~');
  parts.push(`${DIM}${cwdDisplay}${RESET}${branch ? `${GREEN}(${branch})${RESET}` : ''}`);

  const cw = payload.context_window;
  const warn200k = payload.exceeds_200k_tokens ? `${YELLOW}⚠200k${RESET}` : '';
  if (cw && isNum(cw.used_percentage)) {
    const pct = Math.round(cw.used_percentage);
    parts.push(`${colored(`ctx ${pct}%${fmtWindowSize(cw.context_window_size)}`, pctColor(pct))}${warn200k ? ` ${warn200k}` : ''}`);
  } else if (warn200k) {
    parts.push(warn200k); // used_percentage 가 null(세션 초반)이어도 경고는 유지
  }

  for (const w of ['five_hour', 'seven_day'] as const) {
    const f = forecasts[w];
    if (!f) continue;
    const text = fmtForecast(f, nowMs);
    // 리셋 전 소진 예상이면 사용률과 무관하게 최소 노랑.
    const color = f.exhaustsBeforeReset ? (pctColor(f.used) || YELLOW) : pctColor(f.used);
    parts.push(colored(text, color));
  }

  if (payload.cost && isNum(payload.cost.total_cost_usd)) {
    parts.push(`${DIM}$${payload.cost.total_cost_usd.toFixed(2)}${RESET}`);
  }
  return parts.join(SEP);
}

/** 2줄: forgen 정보. 전부 실측 카운터(computeStats = status 와 같은 기준). 실패 시 생략. */
export function buildForgenLine(sessionId: string | undefined): string | null {
  try {
    const rules = (() => { try { return loadActiveRules().length; } catch { return null; } })();
    // ADR-017 D2: 이 세션의 최신 턴 관련 룰 수(solution-injector 가 기록). 파일 부재·손상이면 활성 룰 수로 폴백.
    const turnRelevant = (() => { try { return sessionId ? readTurnRules(sessionId)?.rules.length ?? null : null; } catch { return null; } })();
    const s = computeStats();
    const sessionBlocks = sessionId ? countSessionBlocks(sessionId) : null;
    const parts: string[] = [];
    if (turnRelevant !== null) parts.push(`${DIM}관련 룰${RESET} ${turnRelevant}`);
    else if (rules !== null) parts.push(`${DIM}룰${RESET} ${rules}`);
    if (sessionBlocks !== null) parts.push(`${DIM}이 세션 차단${RESET} ${sessionBlocks > 0 ? colored(String(sessionBlocks), YELLOW) : '0'}`);
    parts.push(`${DIM}7d 차단${RESET} ${s.blocks7d}`);
    parts.push(`${DIM}surfaced${RESET} ${s.assistToday.surfaced}`);
    return parts.join(SEP);
  } catch {
    return null;
  }
}

function countSessionBlocks(sessionId: string): number {
  try {
    const p = path.join(STATE_DIR, 'enforcement', 'violations.jsonl');
    if (!fs.existsSync(p)) return 0;
    let n = 0;
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
      if (!line.includes(sessionId)) continue; // 빠른 선별
      try {
        const e = JSON.parse(line) as { session_id?: string; kind?: string };
        if (e.session_id === sessionId && isRealBlock(e)) n++;
      } catch { /* skip */ }
    }
    return n;
  } catch {
    return 0;
  }
}

// ── 세션별 2줄(forgen) 캐시 ──

export function cachePathFor(sessionId: string | undefined): string {
  return path.join(STATE_DIR, `statusline-cache-${sessionId ? sanitizeId(sessionId) : 'nosession'}.txt`);
}

function readForgenLineCached(sessionId: string | undefined, nowMs: number): string | null {
  const p = cachePathFor(sessionId);
  try {
    const st = fs.statSync(p);
    if (nowMs - st.mtimeMs >= FORGEN_LINE_TTL_MS) return null;
    const body = fs.readFileSync(p, 'utf-8').replace(/\n$/, '');
    return body || null;
  } catch {
    return null;
  }
}

function writeForgenLineCache(sessionId: string | undefined, line: string): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(cachePathFor(sessionId), `${line}\n`);
  } catch { /* fail-open */ }
}

/**
 * 렌더 — 1줄은 매번, 2줄은 세션별 15초 캐시. 파일 샘플은 기울기 전용이고 **표시는 현재 페이로드에 있는
 * 창만** (critic SEV-1: 옛 샘플을 현재값처럼 보여주지 않는다).
 * @param opts.currentAlreadyAppended handleStatuslineWith 가 이번 샘플을 파일에 이미 append 했으면 true
 *        (중복 카운트 방지).
 */
export function renderStatusline(payload: StdinPayload, nowMs: number = Date.now(), opts: { useForgenCache?: boolean; currentAlreadyAppended?: boolean } = {}): string[] {
  const cwd = payload.workspace?.current_dir ?? process.cwd();
  const current = samplesFromPayload(payload.rate_limits, nowMs);
  const history = readSamples(undefined, nowMs);
  const all = opts.currentAlreadyAppended ? history : [...history, ...current];
  const forecasts = forecastAll(all, nowMs, current);
  const lines = [buildUserLine(payload, cwd, forecasts, nowMs)];
  let forgenLine = opts.useForgenCache ? readForgenLineCached(payload.session_id, nowMs) : null;
  if (forgenLine === null) {
    forgenLine = buildForgenLine(payload.session_id);
    if (forgenLine && opts.useForgenCache) writeForgenLineCache(payload.session_id, forgenLine);
  }
  if (forgenLine) lines.push(forgenLine);
  return lines;
}

export async function handleStatusline(): Promise<void> {
  await handleStatuslineWith(readStdinJson());
}

/** stdin 읽기를 분리한 본체 — 테스트는 페이로드를 직접 넣는다. */
export async function handleStatuslineWith(payload: StdinPayload, nowMs: number = Date.now()): Promise<void> {

  // (1) 세션별 모델 캐시 — Stop/SubagentStop 가드의 per-model 프로필 조회용. 캐시 판정 앞.
  if (payload.session_id && payload.model?.id) {
    const { cacheSessionModel } = await import('../checks/_shared/model-profile.js');
    const { sanitizeId } = await import('../hooks/shared/sanitize-id.js');
    cacheSessionModel(sanitizeId(payload.session_id), payload.model.id);
  }

  // (2) D5 샘플 기록 — 매 호출. 압축은 **append 앞**에서(critic r2: append 직후면 mtime 이 항상 신선해
  // 정적 가드가 영원히 막혔다). 크기 ≥256KB·60초 정적일 때만 재작성, 2% 확률.
  const samples = samplesFromPayload(payload.rate_limits, nowMs);
  if (samples.length > 0) {
    if (Math.random() < 0.02) compactSamples(undefined, nowMs);
    appendSamples(samples);
  }

  // (3) 렌더 — 1줄 매번, 2줄 15초 캐시
  const lines = renderStatusline(payload, nowMs, { useForgenCache: true, currentAlreadyAppended: samples.length > 0 });
  for (const line of lines) console.log(line);
}
