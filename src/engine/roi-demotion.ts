/**
 * Forgen v0.5.0 — Injection ROI 루프 (ADR-010 W3-1, F2)
 *
 * 근거: v0.4.11 실측에서 forgen 의 δ 는 100% injection 에서 나왔다 (blocks=0).
 * 따라서 injection 품질 = 효과 그 자체다. "surfaced 는 많은데 acted_on 이
 * 없는" 솔루션은 컨텍스트 비용만 내는 저 ROI 주입이므로 자동 강등한다.
 * native 메모리(claude-mem 등)에는 없는 acted-on 피드백 루프 — moat 기능.
 *
 * 설계 (Rev 2 — 리뷰에서 기존 solution-quarantine 재사용 불가 확정):
 *  - 전용 저장소 `~/.forgen/state/roi-demotions.json`
 *    (기존 quarantine 은 frontmatter 파스 에러 기반 — 시맨틱 불일치)
 *  - `ranking-pipeline.ts` 는 순수 유지 — 강등은 matchSolutions 결과 후처리
 *  - 판정 갱신은 auto-compound 세션 종료 시 (updateRoiDemotions)
 *  - 임계 (config.json roiDemotion 으로 조정 가능):
 *      surfaced_90d >= 3 && acted/surfaced < 0.1  → 강등 (relevance ×0.5)
 *      2회 연속 강등 유지                          → 격리 (주입 제외)
 *      acted_on 신규 발생                          → 즉시 해제
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { queryHitRate, type HitRateRow } from '../core/observability-store.js';

// ── 저장소 ──

export interface RoiDemotionEntry {
  solutionId: string;
  reason: 'low-roi';
  demotedAt: string;
  /** 연속 강등 유지 윈도 수 — 2 이상이면 격리(주입 제외) */
  windowCount: number;
  surfaced: number;
  actedOn: number;
}

export type RoiDemotions = Record<string, RoiDemotionEntry>;

export interface RoiThresholds {
  /** 판정에 필요한 최소 노출 수 (90d). 소규모 사용자에서 dead-code 방지 위해 3. */
  surfacedMin: number;
  /** 이 미만이면 저 ROI (acted/surfaced) */
  rateMax: number;
}

export const DEFAULT_ROI_THRESHOLDS: RoiThresholds = { surfacedMin: 3, rateMax: 0.1 };

export function roiDemotionsPath(home: string = os.homedir()): string {
  return path.join(home, '.forgen', 'state', 'roi-demotions.json');
}

export function loadRoiDemotions(home: string = os.homedir()): RoiDemotions {
  try {
    const parsed = JSON.parse(fs.readFileSync(roiDemotionsPath(home), 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? parsed as RoiDemotions : {};
  } catch {
    return {};
  }
}

export function saveRoiDemotions(demotions: RoiDemotions, home: string = os.homedir()): void {
  try {
    const p = roiDemotionsPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify(demotions, null, 2)}\n`);
  } catch { /* fail-open — 강등 실패가 주입을 막지 않는다 */ }
}

// ── 판정 (순수 함수 — 테스트 결정성) ──

/**
 * 90d 윈도 기준 재판정. 반환값이 새 저장 상태다.
 *
 *  - 신규 강등: surfaced ≥ min && rate < max → windowCount=1
 *  - 유지: 이미 강등 && 여전히 저 ROI → windowCount+1 (2부터 격리)
 *  - 해제: acted_on 이 저장 시점보다 증가 (사용자가 실제로 씀) 또는
 *          rate 가 임계 이상으로 회복 → 엔트리 제거
 *  - 유예: surfaced < min 인 솔루션은 판정하지 않음 (신규/저노출 보호)
 */
export function evaluateRoiDemotions(
  rows: HitRateRow[],
  prev: RoiDemotions,
  thresholds: RoiThresholds = DEFAULT_ROI_THRESHOLDS,
  now: () => string = () => new Date().toISOString(),
): RoiDemotions {
  const next: RoiDemotions = {};

  for (const row of rows) {
    const surfaced = row.surfaced_90d;
    const acted = row.acted_90d;
    const existing = prev[row.solutionId];

    // 해제 1: 실제 사용 발생 (저장 시점 대비 acted 증가)
    if (existing && acted > existing.actedOn) continue;

    if (surfaced < thresholds.surfacedMin) {
      // 유예 — 단, 기존 강등 엔트리는 노출이 줄었어도 유지 (회복은 acted 로만)
      if (existing) next[row.solutionId] = existing;
      continue;
    }

    const rate = acted / surfaced;
    if (rate < thresholds.rateMax) {
      next[row.solutionId] = {
        solutionId: row.solutionId,
        reason: 'low-roi',
        demotedAt: existing?.demotedAt ?? now(),
        windowCount: (existing?.windowCount ?? 0) + 1,
        surfaced,
        actedOn: acted,
      };
    }
    // 해제 2: rate 회복 → next 에 없음 = 제거
  }

  // rows 에 없는 기존 엔트리(이벤트가 180d 밖으로 age-out)는 함께 소멸 —
  // 오래 안 쓰인 솔루션은 T4 time-decay 가 별도로 처리한다.
  return next;
}

/** 격리 여부 — 2회 연속 윈도 강등 유지 시 주입에서 제외 */
export function isRoiQuarantined(entry: RoiDemotionEntry): boolean {
  return entry.windowCount >= 2;
}

// ── 적용 (matchSolutions 후처리 — ranking-pipeline 순수성 유지) ──

export interface RoiAdjustable {
  name: string;
  relevance: number;
}

/**
 * 강등 ×0.5, 격리는 제외. relevance 변경 후 내림차순 재정렬.
 * fail-open: demotions 가 비면 원본 그대로.
 */
export function applyRoiDemotions<T extends RoiAdjustable>(
  matches: T[],
  demotions: RoiDemotions,
): T[] {
  if (Object.keys(demotions).length === 0) return matches;

  const adjusted: T[] = [];
  for (const m of matches) {
    const entry = demotions[m.name];
    if (!entry) { adjusted.push(m); continue; }
    if (isRoiQuarantined(entry)) continue; // 격리 — 주입 제외
    adjusted.push({ ...m, relevance: m.relevance * 0.5 });
  }
  adjusted.sort((a, b) => b.relevance - a.relevance);
  return adjusted;
}

// ── 갱신 진입점 (auto-compound 세션 종료 시) ──

/**
 * observability 이벤트 → 판정 → 저장. fail-open.
 * @returns 강등/격리 수 (로그용) 또는 null (판정 불가)
 */
export function updateRoiDemotions(home: string = os.homedir()): { demoted: number; quarantined: number } | null {
  try {
    // observability-store 는 sqlite 미지원/DB 부재 시 내부 fail-open ([] 반환)
    const rows = queryHitRate();
    if (rows.length === 0) return { demoted: 0, quarantined: 0 };

    const prev = loadRoiDemotions(home);
    const next = evaluateRoiDemotions(rows, prev);
    saveRoiDemotions(next, home);

    const entries = Object.values(next);
    return {
      demoted: entries.filter(e => !isRoiQuarantined(e)).length,
      quarantined: entries.filter(isRoiQuarantined).length,
    };
  } catch {
    return null;
  }
}
