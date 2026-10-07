/**
 * rotateIfBig 회전본(`<file>.<timestamp>`) 나열 — fs/path 만 쓰는 경량 모듈 (state-gc 등이 signals 의 무거운 import 없이 사용).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 회전본 접미사: rotateIfBig 가 붙이는 `Date.now()` 밀리초 타임스탬프. */
const ROTATED_SUFFIX_RE = /^\d{10,}$/;
/** 회전본 보존 상한 — state-gc 가 적용. 개수 3개 + 60일 중 먼저 닿는 쪽. */
export const ROTATED_KEEP_MAX = 3;
export const ROTATED_KEEP_DAYS = 60;

export interface RotatedFile { path: string; mtimeMs: number; size: number }

/** `<p>.<timestamp>` 회전본을 mtime 오름차순(오래된 것 먼저)으로 나열. */
export function listRotated(p: string): RotatedFile[] {
  const dir = path.dirname(p);
  const base = `${path.basename(p)}.`;
  const out: RotatedFile[] = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(base) || !ROTATED_SUFFIX_RE.test(name.slice(base.length))) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* raced away */ }
    }
  } catch { /* dir missing */ }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}


/**
 * 최근 `days` 일 창을 덮는 로그 파일 경로들(오래된 순, 현재 파일이 마지막).
 * 회전본은 mtime(=마지막 append≈회전 시각)이 창 안일 때만 포함 — 창 밖 회전본은 창 안 기록이 없다.
 */
export function logFilesWithin(p: string, days: number, now: number = Date.now()): string[] {
  const cutoff = now - days * 24 * 3600 * 1000;
  const files = listRotated(p).filter((r) => r.mtimeMs >= cutoff).map((r) => r.path);
  files.push(p);
  return files;
}

/** 현재 파일 + 창 안 회전본을 이어 읽는다. 창 기반 리더(stats/explain/lifecycle/statusline)의 공용 진입점. */
export function readJsonlWindow<T>(p: string, days: number, now: number = Date.now()): T[] {
  return logFilesWithin(p, days, now).flatMap((f) => readJsonlSafe<T>(f));
}

export function readJsonlSafe<T>(p: string): T[] {
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) as T; } catch { return null; }
      })
      .filter((e): e is T => e !== null);
  } catch {
    return [];
  }
}
