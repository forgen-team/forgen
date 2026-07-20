/**
 * Host-mismatch demote signal — Multi-Host Core Design §4.3 / §10 우선순위 5
 *
 * spec §12.2 / §18 결과: schema-level 등가성이 강하므로 *호스트별 가중치* 가 아니라
 * *불일치 신호* 만 사용한다. 같은 솔루션/규칙이 한 host 에서만 자주 깨지면 그 host 한정으로
 * demote 후보. 본 모듈은 그 신호를 *읽기만* 한다 — 실제 demote 적용은 lifecycle 트랙.
 *
 * 신호 정의 (Phase 1 단순 버전):
 *   - solution_failed_to_apply_count_by_host
 *   - block_acknowledged_then_revert_count_by_host
 *   - drift_event_count_by_host
 * 위 3 종 metric 을 evidence_id → host 매핑으로 집계.
 */

import { loadAllEvidence } from './evidence-store.js';
import type { Evidence } from './types.js';
import type { HostId } from '../core/trust-layer-intent.js';

export interface HostMismatchSummary {
  readonly byHost: Record<HostId, number>;
  readonly total: number;
  /** ratio of host with most events to total (0..1). 0.5 = balanced, 1.0 = single-host signal. */
  readonly skew: number;
  /** the dominant host (or null if balanced). */
  readonly dominantHost: HostId | null;
  /** 본 신호가 lifecycle demote 를 권고할 정도로 강한지. 임계값은 1차 단순. */
  readonly demoteRecommended: boolean;
}

const DOMINANCE_THRESHOLD = 0.8; // 80% 이상이 한 host 에서 발생하면 dominant.
const MIN_TOTAL_FOR_DEMOTE = 5; // 너무 적은 표본은 무시.

function summarize(events: ReadonlyArray<Evidence>): HostMismatchSummary {
  const byHost: Record<HostId, number> = { claude: 0, codex: 0 };
  for (const e of events) {
    const h = (e.host ?? 'claude') as HostId;
    byHost[h] += 1;
  }
  const total = byHost.claude + byHost.codex;
  if (total === 0) {
    return { byHost, total, skew: 0, dominantHost: null, demoteRecommended: false };
  }
  const claudeShare = byHost.claude / total;
  const codexShare = byHost.codex / total;
  const dominant: HostId = claudeShare >= codexShare ? 'claude' : 'codex';
  const skew = Math.max(claudeShare, codexShare);
  const demoteRecommended = total >= MIN_TOTAL_FOR_DEMOTE && skew >= DOMINANCE_THRESHOLD;
  return { byHost, total, skew, dominantHost: dominant, demoteRecommended };
}

/**
 * 특정 솔루션/규칙 ID 에 대해 *부정적 evidence* (drift, revert, failure) 가 host 별로
 * 어떻게 분포하는지 요약.
 *
 * 1차 구현은 evidence.summary 의 ID 매칭으로 단순 집계. 향후 evidence 가 명시적 ref 필드를
 * 가지면 그쪽으로 전환.
 */
export function summarizeNegativeSignalsForRef(refId: string): HostMismatchSummary {
  const all = loadAllEvidence();
  const matched = all.filter((e) => {
    if (Array.isArray(e.candidate_rule_refs) && e.candidate_rule_refs.includes(refId)) return true;
    if (typeof e.summary === 'string' && e.summary.includes(refId)) {
      // 명시적 음수 키워드 (drift, revert, failed, block-revert) 가 있을 때만.
      return /drift|revert|failed|regress/i.test(e.summary);
    }
    return false;
  });
  return summarize(matched);
}

export function summarizeAllByHost(): { claude: number; codex: number; total: number } {
  const all = loadAllEvidence();
  const r: Record<HostId, number> = { claude: 0, codex: 0 };
  for (const e of all) r[(e.host ?? 'claude') as HostId] += 1;
  return { ...r, total: r.claude + r.codex };
}

/** 테스트 노출용 — 임계값이 변경되면 회귀 즉시 감지. */
export const HOST_MISMATCH_TUNING = {
  DOMINANCE_THRESHOLD,
  MIN_TOTAL_FOR_DEMOTE,
} as const;
