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
  /** 마지막 windowCount 증가 시점 — 24h 미만 재평가는 증가 없음 (리뷰 SEV-2:
   *  평가는 auto-compound 세션마다 도는데, 같은 날 2세션으로 격리되면
   *  "2회 연속 윈도" 설계 의도 위반. 90d 통계는 당일 내 사실상 불변이라
   *  같은 날 재평가는 새 정보가 없다.) */
  lastEvaluatedAt: string;
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
    // tmp+rename 원자 교체 — 동시 세션(auto-compound 병행 종료)에서 부분 쓰기로
    // 파일이 깨지는 것을 방지. rename 은 동일 fs 내 원자적.
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(demotions, null, 2)}\n`);
    fs.renameSync(tmp, p);
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
      // windowCount 증가는 최소 24h 간격 — 같은 날 다중 세션의 재평가는
      // 동일 스냅샷 재확인일 뿐이므로 증가 없이 엔트리를 유지한다.
      const nowIso = now();
      const elapsed = existing
        ? new Date(nowIso).getTime() - new Date(existing.lastEvaluatedAt).getTime()
        : Number.POSITIVE_INFINITY;
      const advanceWindow = elapsed >= 24 * 60 * 60 * 1000;

      next[row.solutionId] = existing && !advanceWindow
        ? existing // 24h 미만 — 그대로 유지 (카운트/스냅샷 불변)
        : {
            solutionId: row.solutionId,
            reason: 'low-roi',
            demotedAt: existing?.demotedAt ?? nowIso,
            windowCount: (existing?.windowCount ?? 0) + 1,
            lastEvaluatedAt: nowIso,
            surfaced,
            actedOn: acted,
          };
    }
    // 해제 2: rate 회복 → next 에 없음 = 제거
  }

  // rows 에 없는 기존 엔트리(이벤트가 180d 밖으로 age-out)는 함께 소멸 —
  // 오래 안 쓰인 솔루션은 T4 time-decay 가 별도로 처리한다.
  //
  // 의도된 장주기 순환 (리뷰에서 명시화): 격리된 솔루션은 surfaced 이벤트가
  // 더 이상 쌓이지 않아 ~6개월 뒤 rows 에서 사라지고 → 엔트리 소멸 → 주입
  // 풀로 복귀한다. 영구 추방이 아니라 "재시도 기회"다 — 프로젝트 맥락이
  // 바뀌면 같은 솔루션이 유효해질 수 있고, 여전히 안 쓰이면 다시 강등된다.
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
 *
 * 실효 (리뷰에서 명시화): injector 의 MIN_INJECT_RELEVANCE 가 0.3 이므로
 * relevance < 0.6 인 강등 솔루션은 사실상 주입 차단된다 — 강등은
 * "중간 신뢰도엔 soft-block, 고신뢰도(≥0.6)엔 우선순위 하락"으로 동작하고,
 * 격리는 relevance 무관 hard-block. 이 기울기는 의도된 것: δ 가 injection
 * 품질에서 나오므로 저 ROI 주입엔 보수적으로 군다.
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
