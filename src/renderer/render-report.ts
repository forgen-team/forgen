/**
 * 마지막 렌더 결과. status·doctor 가 "빠진 룰"을 보여 주는 근거이고, 실물 검증이 주입본과 대조하는 기준이다.
 */
import * as path from 'node:path';
import { STATE_DIR } from '../core/paths.js';
import { atomicWriteJSON, safeReadJSON } from '../hooks/shared/atomic-write.js';
import type { RenderResult } from './rule-renderer.js';

const REPORT_PATH = path.join(STATE_DIR, 'render-report.json');

export interface RenderReport {
  at: string;
  included: string[];
  omitted: Array<{ rule_id: string; strength: string; policy: string }>;
  chars: number;
}

export function recordRenderReport(result: RenderResult, nowIso: string = new Date().toISOString()): void {
  const report: RenderReport = {
    at: nowIso,
    included: result.included.map((r) => r.rule_id),
    omitted: result.omitted.map((r) => ({ rule_id: r.rule_id, strength: r.strength, policy: r.policy.slice(0, 120) })),
    chars: result.text.length,
  };
  atomicWriteJSON(REPORT_PATH, report, { pretty: true });
}

export function loadRenderReport(): RenderReport | null {
  return safeReadJSON<RenderReport | null>(REPORT_PATH, null);
}

export interface RenderSummary {
  at: string;
  included: number;
  omitted: number;
  /** 누락된 룰의 강도별 개수 (strong 이 빠졌으면 가장 먼저 보여야 한다) */
  omittedByStrength: Record<string, number>;
}

/** status 가 "빠진 룰 수·강도"를 보여 주기 위한 요약. 기록이 없으면 null. */
export function summarizeRenderReport(): RenderSummary | null {
  const r = loadRenderReport();
  if (!r || !Array.isArray(r.included) || !Array.isArray(r.omitted)) return null;
  const omittedByStrength: Record<string, number> = {};
  for (const o of r.omitted) omittedByStrength[o.strength] = (omittedByStrength[o.strength] ?? 0) + 1;
  return { at: r.at, included: r.included.length, omitted: r.omitted.length, omittedByStrength };
}
