/**
 * 동결 기능 (0.8.3, 계획 2026-11-25 §3.4 · 오너 결정 Q4: 0.8.0 동결 → 0.9 제거).
 *
 * 지우기 전에 "정말 안 쓰이는가"를 숫자로 확인하려고, 동결 대상이 실제로 쓰일 때마다 한 줄을 남긴다.
 * 파일: `state/metrics/frozen-usage.jsonl` — { at, feature } 만(인자·내용 없음). 기록 실패는 무시(fail-open).
 * CLI 명령이면 stderr 에 한 줄 안내를 띄운다. 훅·백그라운드 경로는 조용히 기록만 한다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from './paths.js';

export const FROZEN_FEATURES = {
  'meta-learning': '승급 임계·매처 가중치 자동 조정 (src/engine/meta-learning)',
  'compound-save': 'git diff 추출기 (forgen compound --save)',
  'inspect': 'forgen inspect (forgen status 로 통일)',
  'status-overview': 'status --overview (dashboard 별칭 포함)',
  'rule-recovery': '일회성 룰 복구 명령 (restore-demoted·revive·recover·unflag·unmerge)',
} as const;
export type FrozenFeature = keyof typeof FROZEN_FEATURES;

export const FROZEN_USAGE_PATH = path.join(STATE_DIR, 'metrics', 'frozen-usage.jsonl');

export function recordFrozenUse(feature: FrozenFeature, opts: { notice?: boolean } = {}): void {
  try {
    fs.mkdirSync(path.dirname(FROZEN_USAGE_PATH), { recursive: true });
    fs.appendFileSync(FROZEN_USAGE_PATH, JSON.stringify({ at: new Date().toISOString(), feature }) + '\n', { mode: 0o600 });
  } catch { /* 계측 실패가 기능을 막지 않는다 */ }
  if (opts.notice) {
    process.stderr.write(`[forgen] 동결된 기능입니다 — 0.9 에서 제거 예정: ${FROZEN_FEATURES[feature]}. 계속 쓰신다면 이슈로 알려 주세요.\n`);
  }
}

/** 기간 안 동결 기능별 사용 횟수(많은 순). */
export function frozenUsageSince(sinceMs: number): Array<{ feature: string; count: number }> {
  let text = '';
  try { text = fs.readFileSync(FROZEN_USAGE_PATH, 'utf-8'); } catch { return []; }
  const counts = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as { at?: string; feature?: string };
      if (!r.feature || !r.at || Date.parse(r.at) < sinceMs) continue;
      counts.set(r.feature, (counts.get(r.feature) ?? 0) + 1);
    } catch { /* 깨진 줄은 건너뛴다 */ }
  }
  return [...counts].map(([feature, count]) => ({ feature, count })).sort((a, b) => b.count - a.count);
}
