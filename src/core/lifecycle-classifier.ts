/**
 * Forgen — Lifecycle Classifier (P3)
 *
 * 솔루션 catalog (~/.forgen/me/solutions/*.md) 를 읽어 각 솔루션의
 * lifecycle 을 hot/warm/cold/dead/new 로 분류한다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ME_SOLUTIONS } from './paths.js';
import { parseFrontmatterOnly } from '../engine/solution-format.js';
import { queryHitRate } from './observability-store.js';
import type { HitRateRow } from './observability-store.js';

export type Lifecycle = 'hot' | 'warm' | 'cold' | 'dead' | 'new';

export interface LifecycleClass {
  solutionId: string;
  lifecycle: Lifecycle;
  /** acted_90d / max(surfaced_90d, 1). surfaced_90d == 0 이면 null */
  hitRate: number | null;
  matched_90d: number;
  surfaced_90d: number;
  acted_90d: number;
  matched_180d: number;
  ageDays: number;
  /** 전체 acted_on 신호가 너무 적어 acted 로 hot/warm/cold 를 가를 수 없는 기간이었는가 */
  signalWeak?: boolean;
}

/** 90일 동안 전체 솔루션의 acted_on 합이 이보다 적으면 "신호가 약한 기간"으로 본다. */
export const WEAK_SIGNAL_TOTAL_ACTED = 3;

/** 분류 로직 — §5.2 */
export function classifyOne(
  _solutionId: string,
  ageDays: number,
  rates: HitRateRow,
  signalWeak = false,
): Lifecycle {
  // new: age ≤ 30d
  if (ageDays <= 30) return 'new';

  // dead: matched_180d == 0 AND age > 30d
  if (rates.matched_180d === 0) return 'dead';

  // acted 신호가 약한 기간: acted 없음을 "안 쓰임"으로 읽으면 전부 cold 로 무너진다.
  // 실제로 주입(surfaced)된 솔루션은 판정 보류(warm), 매칭만 되고 주입 안 된 것만 cold.
  if (signalWeak) return rates.surfaced_90d >= 1 ? 'warm' : 'cold';

  // hot: acted_90d >= 3 AND (acted_90d / max(surfaced_90d, 1)) >= 0.4
  const hitRate = rates.acted_90d / Math.max(rates.surfaced_90d, 1);
  if (rates.acted_90d >= 3 && hitRate >= 0.4) return 'hot';

  // warm: surfaced_90d >= 3 AND acted_90d >= 1
  if (rates.surfaced_90d >= 3 && rates.acted_90d >= 1) return 'warm';

  // cold: matched_90d >= 1 AND surfaced_90d == 0
  if (rates.matched_90d >= 1 && rates.surfaced_90d === 0) return 'cold';

  // fallback
  return 'cold';
}

/** ~/.forgen/me/solutions/*.md 전체를 분류하여 반환 */
export function classifySolutions(): LifecycleClass[] {
  const results: LifecycleClass[] = [];

  let files: string[];
  try {
    if (!fs.existsSync(ME_SOLUTIONS)) return [];
    files = fs.readdirSync(ME_SOLUTIONS).filter(f => f.endsWith('.md'));
  } catch {
    return [];
  }

  // queryHitRate() 는 전체 결과를 한 번에 가져옴
  const rateMap = new Map<string, HitRateRow>();
  try {
    const rows = queryHitRate();
    for (const row of rows) {
      rateMap.set(row.solutionId, row);
    }
  } catch {
    // fail-open: DB 없으면 빈 map
  }

  const now = Date.now();
  let totalActed = 0;
  for (const r of rateMap.values()) totalActed += r.acted_90d;
  const signalWeak = totalActed < WEAK_SIGNAL_TOTAL_ACTED;

  for (const file of files) {
    const filePath = path.join(ME_SOLUTIONS, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const fm = parseFrontmatterOnly(content);
    if (!fm) continue;

    const solutionId = fm.name;

    // ageDays: frontmatter created date 에서 계산
    let ageDays = 999;
    try {
      const createdMs = new Date(fm.created).getTime();
      if (!isNaN(createdMs)) {
        ageDays = Math.floor((now - createdMs) / (24 * 60 * 60 * 1000));
      }
    } catch {
      // keep 999 (treat as old)
    }

    const rates: HitRateRow = rateMap.get(solutionId) ?? {
      solutionId,
      matched_30d: 0, surfaced_30d: 0, acted_30d: 0,
      matched_90d: 0, surfaced_90d: 0, acted_90d: 0,
      matched_180d: 0, surfaced_180d: 0, acted_180d: 0,
      last_event_ts: 0,
    };

    const lifecycle = classifyOne(solutionId, ageDays, rates, signalWeak);

    const hitRate = rates.surfaced_90d > 0
      ? rates.acted_90d / rates.surfaced_90d
      : null;

    results.push({
      solutionId,
      lifecycle,
      hitRate,
      matched_90d: rates.matched_90d,
      surfaced_90d: rates.surfaced_90d,
      acted_90d: rates.acted_90d,
      matched_180d: rates.matched_180d,
      ageDays,
      signalWeak,
    });
  }

  return results;
}
