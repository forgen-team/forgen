/**
 * 세션별 렌더 기록 (0.9.0, docs/plans/2026-11-25-v1.0-plan.md §2.2·§4.2).
 *
 * 세션 시작 훅이 실제로 넣은 forgen 룰 ID(세션 시작 블록)와 위치 전환 주입으로 더 넣은 룰 ID 를 한 줄씩 남긴다.
 * `forgen audit recurrence` 가 "그 교정 때 그 룰이 실려 있었나"를 이 기록으로 판정한다(없으면 재생 렌더로 추정).
 *
 * work-context-<세션>.json 의 rules 필드도 같은 ID 를 갖지만 state-gc 가 세션 파일로 지우므로, 감사용으로는
 * 지워지지 않는 추가 전용 파일이 따로 필요하다: `state/metrics/session-renders.jsonl` (커지면 이름을 바꿔 보관).
 *   { at, session, event: 'start' | 'switch' | 'tier2', cwd, project, ruleIds, tier2?, via? }
 * 'start' 는 세션 시작·압축 뒤 재시작 — 그 앞의 주입은 컨텍스트에서 사라진 것으로 본다.
 * 0.9.0 두 층: 'start' 의 tier2 = 그 세션의 2층 후보(색인 줄로만 보이고 아직 안 실림), 'tier2' 사건 = 상황이 맞아 훅이 넣은 2층 룰
 *   (via: prompt | tool). 옛 버전은 'tier2' 줄을 건너뛰고 tier2 필드를 무시한다(선택 필드).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from './paths.js';
import { rotateIfBig } from '../engine/lifecycle/signals.js';

export interface SessionRenderRecord {
  at: string;
  session: string;
  event: 'start' | 'switch' | 'tier2';
  cwd: string;
  project: string | null;
  ruleIds: string[];
  /** 'start' 만: 이 세션의 2층 후보 ID */
  tier2?: string[];
  /** 'tier2' 만: 어느 신호로 넣었나 */
  via?: 'prompt' | 'tool';
}

export function sessionRendersPath(stateDir = STATE_DIR): string {
  return path.join(stateDir, 'metrics', 'session-renders.jsonl');
}

export function appendSessionRender(rec: Omit<SessionRenderRecord, 'at'> & { at?: string }): void {
  try {
    const p = sessionRendersPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    rotateIfBig(p);
    const line = {
      at: rec.at ?? new Date().toISOString(), session: rec.session, event: rec.event, cwd: rec.cwd, project: rec.project, ruleIds: [...new Set(rec.ruleIds)].sort(),
      ...(rec.tier2?.length ? { tier2: [...new Set(rec.tier2)].sort() } : {}), ...(rec.via ? { via: rec.via } : {}),
    };
    fs.appendFileSync(p, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch { /* 기록 실패는 감사 정확도만 낮춘다(재생 렌더로 추정) */ }
}

/** 보관본(session-renders.jsonl.<시각>)까지 읽어 세션별로 시간순 정렬해 돌려준다. 읽기만 한다. */
export function readSessionRenders(stateDir = STATE_DIR): Map<string, SessionRenderRecord[]> {
  const p = sessionRendersPath(stateDir);
  const dir = path.dirname(p);
  const base = path.basename(p);
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n === base || n.startsWith(`${base}.`)).sort(); } catch { return new Map(); }
  const out = new Map<string, SessionRenderRecord[]>();
  for (const n of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, n), 'utf-8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as SessionRenderRecord;
        if (!r.session || !Array.isArray(r.ruleIds) || (r.event !== 'start' && r.event !== 'switch' && r.event !== 'tier2')) continue;
        const list = out.get(r.session) ?? [];
        list.push(r);
        out.set(r.session, list);
      } catch { /* 깨진 줄 무시 */ }
    }
  }
  for (const list of out.values()) list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out;
}

/** 시각 t 에 그 세션 컨텍스트에 있던 룰 ID: t 이전 마지막 'start' + 그 뒤 t 까지의 'switch'·'tier2'. 기록이 없으면 null. */
export function rulesLoadedAt(records: SessionRenderRecord[] | undefined, t: string): Set<string> | null {
  if (!records?.length) return null;
  let cur: Set<string> | null = null;
  for (const r of records) {
    if (r.at > t) break;
    if (r.event === 'start') cur = new Set(r.ruleIds);
    else if (cur) for (const id of r.ruleIds) cur.add(id);
    else cur = new Set(r.ruleIds);
  }
  return cur;
}

/** 시각 t 에 그 세션의 2층 후보였던 룰 ID(t 이전 마지막 'start' 의 tier2). 기록이 없거나 두 층 이전 기록이면 빈 집합. */
export function tier2PendingAt(records: SessionRenderRecord[] | undefined, t: string): Set<string> {
  let cur = new Set<string>();
  for (const r of records ?? []) {
    if (r.at > t) break;
    if (r.event === 'start') cur = new Set(r.tier2 ?? []);
  }
  return cur;
}
