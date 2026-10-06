/**
 * Rate-limit forecast — "지금 추세면 언제 다 쓰나" (ADR-017 D5)
 *
 * Claude Code statusline stdin 의 `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}` 를
 * 호출마다 샘플로 쌓고, 최근 창의 기울기(EMA 평활)로 100% 도달 시각을 추정한다.
 *
 * 정직성 원칙 (ADR-017 §2-5): 근거가 부족하면 예측을 **숨긴다**. 틀린 예측 하나가 맞는 예측
 * 열 개를 무효화한다. 숨김 조건 — 창 내 샘플 < MIN_SAMPLES, 창 내 시간 폭 < 창별 MIN_SPAN,
 * 창 내 총 증가 < MIN_RISE_PCT, 기울기 ≤ 0, used_percentage null/비수치, resets_at 경과.
 *
 * 추정기 (critic SEV-1 반영): 사용률은 API 응답 시점에 **계단**으로 뛰고 호출 간격은 수 초~수십 분으로
 * 불균일하다. 연속 쌍 기울기의 등가중 EMA 는 "정체 n개 + 짧은 dt 의 점프 1개" 에서 수십 배 과대했다
 * (실측 27배). 창 안 **양끝점 기울기** (used_last − used_first)/(t_last − t_first) 로 교체 — dt 가중이
 * 본질이고 점프 순서에 무관하다.
 *
 * 표시 게이트: 현재 페이로드에 그 창이 **수치로 존재할 때만** 출력한다. 파일 샘플은 기울기 전용.
 * (리셋 순간 CC 는 창을 drop 하고 스크립트를 재실행하므로, 파일만 보면 리셋 전 최고치를 보여주게 된다.)
 *
 * 창 리셋 조건 (공식 문서 2026-10-06 확인: 창은 resets_at 을 가지며 지나면 객체가 사라졌다
 * 재등장하고 초기엔 used_percentage 가 null 일 수 있다): resets_at 변화 · 사용률 하락 ·
 * null 샘플 → 이전 샘플 폐기(해당 창만).
 *
 * 순수 함수 + 얇은 IO. 샘플 파일은 한 줄 단일 append, 읽기는 파싱 실패 라인 무시
 * (Claude Code 가 statusline 스크립트를 중간에 취소하면 잘린 줄이 생길 수 있다).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from './paths.js';

export type WindowKey = 'five_hour' | 'seven_day';

export interface RateWindow {
  used_percentage?: number | null;
  resets_at?: number | null; // unix epoch seconds
}

export interface RateLimitsPayload {
  five_hour?: RateWindow | null;
  seven_day?: RateWindow | null;
}

export interface Sample {
  /** epoch ms */
  t: number;
  used: number;
  /** epoch seconds; 창 식별자 */
  resets_at: number | null;
}

export const SAMPLES_PATH = path.join(STATE_DIR, 'rate-limit-samples.jsonl');
export const SAMPLE_TTL_MS = 7 * 24 * 3600 * 1000;
export const MIN_SAMPLES = 3;
/** 창 안 샘플 시간 폭 최소치 — 짧은 폭의 점프 하나가 추세로 둔갑하지 않게. */
export const MIN_SPAN_MS: Record<WindowKey, number> = {
  five_hour: 15 * 60 * 1000,
  seven_day: 2 * 3600 * 1000,
};
/** 창 안 총 증가가 이보다 작으면(0.1% 양자화 잡음 수준) 예측 숨김. */
export const MIN_RISE_PCT = 1;
/** 기울기 추정에 쓰는 창 폭. */
export const LOOKBACK_MS: Record<WindowKey, number> = {
  five_hour: 30 * 60 * 1000,
  seven_day: 24 * 3600 * 1000,
};
/** compactSamples 가드: 이 크기 미만이거나 최근에 쓰인 파일은 재작성하지 않는다(동시 append 유실 방지). */
export const COMPACT_MIN_BYTES = 256 * 1024;
export const COMPACT_QUIET_MS = 60 * 1000;

export interface Forecast {
  window: WindowKey;
  used: number;
  resetsAt: number | null; // epoch ms
  /** 100% 도달 예상 시각(epoch ms). 근거 부족·기울기 ≤0 이면 null. */
  exhaustAt: number | null;
  /** exhaustAt 이 resets_at 보다 앞이면 true. */
  exhaustsBeforeReset: boolean;
  /** 리셋 시점 예상 사용률(기울기 외삽, 100 상한). 예측 불가면 null. */
  projectedAtReset: number | null;
  /** %/시간. */
  ratePerHour: number | null;
  sampleCount: number;
}

interface SampleLine extends Sample { w: WindowKey }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** payload → 이번 호출 샘플(창별). null/비수치 사용률은 샘플로 만들지 않는다. */
export function samplesFromPayload(rl: RateLimitsPayload | undefined | null, nowMs: number): SampleLine[] {
  const out: SampleLine[] = [];
  if (!rl) return out;
  for (const w of ['five_hour', 'seven_day'] as const) {
    const win = rl[w];
    if (!win || !isNum(win.used_percentage)) continue;
    out.push({ w, t: nowMs, used: win.used_percentage, resets_at: isNum(win.resets_at) ? win.resets_at : null });
  }
  return out;
}

export function appendSamples(lines: SampleLine[], p: string = SAMPLES_PATH): void {
  if (lines.length === 0) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // 한 줄 단일 write — 취소로 잘려도 다음 줄에 영향 없음.
    fs.appendFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  } catch { /* fail-open */ }
}

export function readSamples(p: string = SAMPLES_PATH, nowMs: number = Date.now()): SampleLine[] {
  try {
    if (!fs.existsSync(p)) return [];
    const cutoff = nowMs - SAMPLE_TTL_MS;
    const out: SampleLine[] = [];
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as Partial<SampleLine>;
        if ((o.w !== 'five_hour' && o.w !== 'seven_day') || !isNum(o.t) || !isNum(o.used)) continue;
        if (o.t < cutoff) continue;
        out.push({ w: o.w, t: o.t, used: o.used, resets_at: isNum(o.resets_at) ? o.resets_at : null });
      } catch { /* 잘린 줄 무시 */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * TTL 넘은 줄 제거. read→truncate 재작성은 다른 세션의 동시 append 를 유실시키므로(critic 실측 33%)
 * **크기 ≥ COMPACT_MIN_BYTES 이고 마지막 수정이 COMPACT_QUIET_MS 이전**일 때만 수행한다.
 * 반환: 실제로 압축했는지.
 */
export function compactSamples(p: string = SAMPLES_PATH, nowMs: number = Date.now(), force = false): boolean {
  try {
    if (!fs.existsSync(p)) return false;
    if (!force) {
      const st = fs.statSync(p);
      if (st.size < COMPACT_MIN_BYTES || nowMs - st.mtimeMs < COMPACT_QUIET_MS) return false;
    }
    const keep = readSamples(p, nowMs);
    fs.writeFileSync(p, keep.map((l) => JSON.stringify(l)).join('\n') + (keep.length ? '\n' : ''));
    return true;
  } catch {
    return false;
  }
}

/**
 * 같은 창의 샘플 시계열에서 "현재 창"에 속하는 꼬리만 남긴다.
 * 창 경계: resets_at 변화, 사용률 하락. (둘 다 "이전 창의 샘플" 이므로 버린다.)
 */
export function currentWindowTail(samples: Sample[]): Sample[] {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  let start = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const resetChanged = prev.resets_at !== null && cur.resets_at !== null && prev.resets_at !== cur.resets_at;
    const dropped = cur.used < prev.used - 1e-9;
    if (resetChanged || dropped) start = i;
  }
  return sorted.slice(start);
}

/**
 * 양끝점 기울기(%/ms) — lookback 창 안 첫/마지막 샘플. 시간 가중이 본질이라 점프 순서·간격에 무관.
 * 숨김: 샘플 < MIN_SAMPLES, 시간 폭 < MIN_SPAN_MS[w], 총 증가 < MIN_RISE_PCT.
 */
export function estimateRate(tail: Sample[], nowMs: number, lookbackMs: number, w: WindowKey = 'five_hour'): { rate: number; n: number } | null {
  const inWin = tail.filter((s) => s.t >= nowMs - lookbackMs).sort((a, b) => a.t - b.t);
  if (inWin.length < MIN_SAMPLES) return null;
  const first = inWin[0];
  const last = inWin[inWin.length - 1];
  const span = last.t - first.t;
  if (span < MIN_SPAN_MS[w]) return null;
  const rise = last.used - first.used;
  if (rise < MIN_RISE_PCT) return null;
  return { rate: rise / span, n: inWin.length };
}

/**
 * @param current 현재 페이로드의 이 창 샘플. **없으면 null 을 돌려 세그먼트를 생략한다** — 파일의
 *                옛 샘플을 현재값처럼 보여주지 않는다(critic SEV-1). resets_at 이 이미 지났어도 숨긴다.
 */
export function forecastWindow(w: WindowKey, samples: Sample[], nowMs: number, current?: Sample | null): Forecast | null {
  if (current === undefined) {
    // 하위 호환(테스트·오프라인 분석): 명시 안 하면 tail 마지막을 현재로 간주.
    const t = currentWindowTail(samples);
    if (t.length === 0) return null;
    current = t[t.length - 1];
  }
  if (!current) return null;
  if (current.resets_at !== null && current.resets_at * 1000 < nowMs) return null;
  const tail = currentWindowTail([...samples.filter((s) => s.t !== current.t), current]);
  const last = current;
  const resetsAt = last.resets_at !== null ? last.resets_at * 1000 : null;
  const base: Forecast = {
    window: w, used: last.used, resetsAt, exhaustAt: null, exhaustsBeforeReset: false,
    projectedAtReset: null, ratePerHour: null, sampleCount: tail.length,
  };
  const est = estimateRate(tail, nowMs, LOOKBACK_MS[w], w);
  if (!est || est.rate <= 0) return base; // 숨김: 근거 부족 또는 소진 방향 아님
  const ratePerMs = est.rate;
  const remaining = Math.max(0, 100 - last.used);
  const exhaustAt = last.t + remaining / ratePerMs;
  const projectedAtReset = resetsAt !== null && resetsAt > last.t
    ? Math.min(100, last.used + ratePerMs * (resetsAt - last.t))
    : null;
  return {
    ...base,
    exhaustAt,
    exhaustsBeforeReset: resetsAt !== null ? exhaustAt < resetsAt : false,
    projectedAtReset,
    ratePerHour: ratePerMs * 3600 * 1000,
  };
}

/**
 * 모든 창 예측. `current` 가 주어지면 **그 안에 수치로 존재하는 창만** 출력한다(표시 게이트).
 * 주어지지 않으면(오프라인 분석) 파일 샘플의 마지막을 현재로 간주.
 */
export function forecastAll(all: SampleLine[], nowMs: number, current?: SampleLine[]): Partial<Record<WindowKey, Forecast>> {
  const out: Partial<Record<WindowKey, Forecast>> = {};
  for (const w of ['five_hour', 'seven_day'] as const) {
    const cur = current ? (current.find((s) => s.w === w) ?? null) : undefined;
    const f = forecastWindow(w, all.filter((s) => s.w === w), nowMs, cur);
    if (f) out[w] = f;
  }
  return out;
}

/** HH:MM (로컬). 하루 넘어가면 "D+1 HH:MM". */
export function fmtClock(epochMs: number, nowMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const dayDiff = Math.floor((startOfDay(epochMs) - startOfDay(nowMs)) / (24 * 3600 * 1000));
  return dayDiff > 0 ? `D+${dayDiff} ${hh}:${mm}` : `${hh}:${mm}`;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 한 창의 표시 문자열(색 없음 — 호출자가 입힘).
 *   "5h 63% → 15:40 소진 (리셋 16:20)"   리셋 전 소진 예상
 *   "5h 63% → 리셋 16:20 여유 (예상 81%)"  리셋까지 안 닿음
 *   "5h 63% (리셋 16:20)"                 예측 근거 부족 — 사용률만
 */
export function fmtForecast(f: Forecast, nowMs: number): string {
  const label = f.window === 'five_hour' ? '5h' : '7d';
  const used = `${label} ${Math.round(f.used)}%`;
  const reset = f.resetsAt !== null ? `리셋 ${fmtClock(f.resetsAt, nowMs)}` : '';
  if (f.exhaustAt === null) return reset ? `${used} (${reset})` : used;
  if (f.exhaustsBeforeReset) return `${used} → ${fmtClock(f.exhaustAt, nowMs)} 소진${reset ? ` (${reset})` : ''}`;
  const proj = f.projectedAtReset !== null ? ` (예상 ${Math.round(f.projectedAtReset)}%)` : '';
  return reset ? `${used} → ${reset} 여유${proj}` : `${used} → ${fmtClock(f.exhaustAt, nowMs)} 소진`;
}
