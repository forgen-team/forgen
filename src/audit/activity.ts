/**
 * 대표 숫자(0.9.1 #2): 거의 안 쓰는 하위 폴더가 중앙값을 부풀리지 않게, 최근 30일 세션이 3개 이상인 폴더만 세션 수로 가중한 평균을 쓴다.
 * 세션 수 근거 = 최근 30일 대화 기록의 메시지 cwd(recentSessionsByFolder). 읽기만 한다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const ACTIVE_DAYS = 30;
export const ACTIVE_MIN_SESSIONS = 3;
const DAY = 86_400_000;

/**
 * 폴더마다 최근 30일 세션 수. 세션 하나 = 대화 기록 파일 하나(최상위 세션, 최근 30일 수정). 그 세션의 메시지 cwd 가 그 폴더(또는 그 아래)였으면
 * 그 폴더에서 일한 세션이다 — 가장 깊은 감사 폴더 하나에만 센다. 홈에서 시작해 프로젝트로 들어가 일한 세션도 그 프로젝트로 센다
 * (forgen 은 작업이 프로젝트로 들어가면 그 프로젝트 룰을 넣는다). 읽기만 하고, 아주 큰 기록(200MB 넘음)은 건너뛴다.
 */
export function recentSessionsByFolder(claudeDir: string, folders: string[], now = new Date()): Map<string, number> {
  const out = new Map(folders.map((f) => [f, 0]));
  const sorted = [...folders].sort((a, b) => b.length - a.length);
  const since = now.getTime() - ACTIVE_DAYS * DAY;
  const root = path.join(claudeDir, 'projects');
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const n of names) {
      const p = path.join(root, d, n);
      let st: fs.Stats;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs < since || st.size > 200 * 1024 * 1024) continue;
      let text = '';
      try { text = fs.readFileSync(p, 'utf-8'); } catch { continue; }
      const hit = new Set<string>();
      for (const m of text.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
        const cwd = m[1].replace(/\\(.)/g, '$1');
        const f = sorted.find((x) => cwd === x || cwd.startsWith(`${x}${path.sep}`));
        if (f) hit.add(f);
      }
      for (const f of hit) out.set(f, (out.get(f) ?? 0) + 1);
    }
  }
  return out;
}

export interface Representative { value: number; folders: number; weighted: boolean; min: number; max: number }

/**
 * 세션 수 가중 평균. 자주 쓰는 폴더(세션 ≥ 3)가 없으면 모든 폴더의 단순 평균(weighted:false).
 * 값은 언제나 쓰인 폴더 값의 범위 안에 있다.
 */
export function representative(rows: Array<{ value: number; sessions: number }>): Representative | null {
  if (!rows.length) return null;
  const active = rows.filter((r) => r.sessions >= ACTIVE_MIN_SESSIONS);
  const use = active.length ? active : rows;
  const w = active.length ? use.reduce((n, r) => n + r.sessions, 0) : use.length;
  const sum = use.reduce((n, r) => n + r.value * (active.length ? r.sessions : 1), 0);
  const vals = use.map((r) => r.value);
  return { value: Math.round((sum / w) * 10) / 10, folders: use.length, weighted: active.length > 0, min: Math.min(...vals), max: Math.max(...vals) };
}

/** 결과가 똑같은 폴더를 한 줄로 묶는다(키가 같으면 같은 줄). 순서는 처음 나온 순서. */
export function groupSame<T>(rows: T[], keyOf: (r: T) => string): Array<{ rows: T[]; first: T }> {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(keyOf(r), [...(out.get(keyOf(r)) ?? []), r]);
  return [...out.values()].map((rs) => ({ rows: rs, first: rs[0] }));
}
