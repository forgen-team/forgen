/**
 * 실제 컨텍스트 사용량 — 창 대비 비율.
 *
 * 예전 context-guard 는 사용자가 친 프롬프트의 글자 수를 모아 "120K 문자 ≈ 컨텍스트 20%"라며 모델에게 지금 즉시 /compact 를
 * 하라고 지시했다. 프롬프트 글자 수는 컨텍스트 크기가 아니고(도구 결과·응답·캐시가 대부분이다), 모델은 /compact 를 실행할 수 없으며,
 * 1M 창에서 12% 수준에서도 작업을 끊으라고 했다. 여기서는 실제 값만 쓴다.
 *
 *  1) statusline 페이로드(context_window.used_percentage / context_window_size) — statusline 이 세션별 파일에 남긴다.
 *  2) transcript 마지막 assistant usage(input + cache_read + cache_creation) — 창 크기는 모른다.
 *     토큰이 200K 를 넘으면 창은 1M 이어야 하므로 그때만 비율을 낸다. 200K 이하는 200K 창인지 1M 창인지 알 수 없어 모른다고 한다.
 * 모르면 null — 호출자는 아무것도 하지 않는다. 알림은 사용자에게 보이는 안내(systemMessage)뿐이고 모델에는 아무것도 주지 않는다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from '../core/paths.js';
import { sanitizeId } from './shared/sanitize-id.js';

export interface ContextUsage {
  /** 0~100 */
  percent: number;
  windowSize: number;
  source: 'statusline' | 'transcript';
}

/** statusline 값이 이보다 오래됐으면 transcript 로 넘어간다. */
const STATUSLINE_FRESH_MS = 30 * 60 * 1000;
const NOTICE_PERCENT = 70;
const NOTICE_COOLDOWN_MS = 10 * 60 * 1000;
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const SMALL_WINDOW = 200_000;
const BIG_WINDOW = 1_000_000;

function pathFor(sessionId: string): string {
  return path.join(STATE_DIR, `context-window-${sanitizeId(sessionId)}.json`);
}

/** statusline 이 매 갱신마다 호출. 값이 없으면 아무것도 쓰지 않는다. */
export function writeContextWindow(sessionId: string, cw: { used_percentage?: number | null; context_window_size?: number } | undefined): void {
  if (!cw || typeof cw.used_percentage !== 'number' || typeof cw.context_window_size !== 'number' || cw.context_window_size <= 0) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(pathFor(sessionId), JSON.stringify({ at: Date.now(), used_percentage: cw.used_percentage, context_window_size: cw.context_window_size }));
  } catch { /* fail-open */ }
}

function fromStatusline(sessionId: string, now: number): ContextUsage | null {
  try {
    const j = JSON.parse(fs.readFileSync(pathFor(sessionId), 'utf-8')) as { at?: number; used_percentage?: number; context_window_size?: number };
    if (typeof j.at !== 'number' || now - j.at > STATUSLINE_FRESH_MS) return null;
    if (typeof j.used_percentage !== 'number' || typeof j.context_window_size !== 'number') return null;
    return { percent: j.used_percentage, windowSize: j.context_window_size, source: 'statusline' };
  } catch { return null; }
}

function fromTranscript(transcriptPath: string | undefined): ContextUsage | null {
  if (!transcriptPath) return null;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    let text: string;
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf-8');
    } finally { fs.closeSync(fd); }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"usage"')) continue;
      let u: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
      try { u = (JSON.parse(lines[i]) as { message?: { usage?: typeof u } }).message?.usage; } catch { continue; }
      if (!u) continue;
      const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (tokens <= SMALL_WINDOW) return null; // 200K 창인지 1M 창인지 알 수 없다
      return { percent: Math.min(100, Math.round((tokens / BIG_WINDOW) * 100)), windowSize: BIG_WINDOW, source: 'transcript' };
    }
  } catch { /* 읽기 실패 = 모름 */ }
  return null;
}

/** 실제 값으로 판단 가능하면 사용량, 아니면 null (= 모름 → 아무것도 하지 않는다). */
export function readContextUsage(sessionId: string, transcriptPath?: string, now: number = Date.now()): ContextUsage | null {
  return fromStatusline(sessionId, now) ?? fromTranscript(transcriptPath);
}

/** 알림 여부 (순수 함수). 모르면 false. */
export function shouldNoticeContext(usage: ContextUsage | null, lastNoticeAt: number, opts: { percent?: number; cooldownMs?: number; now?: number } = {}): boolean {
  if (!usage) return false;
  const now = opts.now ?? Date.now();
  return usage.percent >= (opts.percent ?? NOTICE_PERCENT) && now - lastNoticeAt > (opts.cooldownMs ?? NOTICE_COOLDOWN_MS);
}

/** 사용자에게만 보이는 안내. 모델에게 주는 지시가 아니다. */
export function buildContextNotice(usage: ContextUsage): string {
  const size = usage.windowSize >= 1_000_000 ? `${Math.round(usage.windowSize / 1_000_000)}M` : `${Math.round(usage.windowSize / 1000)}K`;
  return `[Forgen] 컨텍스트 ${Math.round(usage.percent)}% 사용 중 (창 ${size}). 여유가 줄고 있습니다. 편한 시점에 직접 /compact 를 실행하거나 새 세션을 여세요.`;
}
