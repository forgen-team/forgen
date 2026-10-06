/**
 * Forgen v1 — Profile axis score (ADR-017 §6-8)
 *
 * 4축 `score` 는 v0.1.0 부터 스키마·표시만 있고 산출 로직이 없었다 (0.5 리터럴 고정).
 * 새 스펙 없이 기존 facet 카탈로그(src/preset/facet-catalog.ts)에서 도출한다:
 *
 *   - 각 축의 양 끝 팩 centroid 를 0 과 1 로 둔다 (onboarding.ts 의 score→pack 방향과 동일):
 *       quality_safety      보수형(0)     → 속도형(1)
 *       autonomy            확인 우선형(0) → 자율 실행형(1)
 *       judgment_philosophy 최소변경형(0)  → 구조적접근형(1)
 *       communication_style 간결형(0)     → 상세형(1)
 *   - 현재 facet 벡터를 그 선분에 투영한 t (0~1 clamp) 가 "facet 위치".
 *   - score = confidence × t + (1 − confidence) × NEUTRAL_ANCHOR
 *     (profile-store.ts bumpAxisConfidence 주석의 공식 그대로, neutral_anchor = 0.5).
 *
 * confidence 가 낮으면 0.5 근처에 머물고, 교정이 쌓여 confidence 가 오르면 facet 위치를
 * 더 강하게 반영한다. 순수 함수 — IO 없음. 저장은 profile-store 가 담당.
 */

import type { Profile } from './types.js';
import {
  QUALITY_CENTROIDS,
  AUTONOMY_CENTROIDS,
  JUDGMENT_CENTROIDS,
  COMMUNICATION_CENTROIDS,
} from '../preset/facet-catalog.js';

export type AxisKey = keyof Profile['axes'];

export const AXIS_KEYS: readonly AxisKey[] = [
  'quality_safety',
  'autonomy',
  'judgment_philosophy',
  'communication_style',
] as const;

export const NEUTRAL_ANCHOR = 0.5;

/** facet 인터페이스는 index signature 가 없어 Record 로 넓힌다 (값은 전부 number). */
const rec = (f: object): Record<string, number> => f as unknown as Record<string, number>;

/** 축별 양 끝 팩 (low → 0, high → 1). lowPack/highPack 은 팩 키 — 표시 라벨은 렌더러가 locale 로 변환. */
export const AXIS_POLES: Record<AxisKey, { low: Record<string, number>; high: Record<string, number>; lowPack: string; highPack: string }> = {
  quality_safety: { low: rec(QUALITY_CENTROIDS.보수형), high: rec(QUALITY_CENTROIDS.속도형), lowPack: '보수형', highPack: '속도형' },
  autonomy: { low: rec(AUTONOMY_CENTROIDS['확인 우선형']), high: rec(AUTONOMY_CENTROIDS['자율 실행형']), lowPack: '확인 우선형', highPack: '자율 실행형' },
  judgment_philosophy: { low: rec(JUDGMENT_CENTROIDS.최소변경형), high: rec(JUDGMENT_CENTROIDS.구조적접근형), lowPack: '최소변경형', highPack: '구조적접근형' },
  communication_style: { low: rec(COMMUNICATION_CENTROIDS.간결형), high: rec(COMMUNICATION_CENTROIDS.상세형), lowPack: '간결형', highPack: '상세형' },
};

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * facet 벡터를 low→high 선분에 투영한 위치 t ∈ [0,1].
 * 카탈로그에 없는 facet 키는 무시하고, 숫자가 아닌 값은 low 값으로 간주(중립).
 */
export function projectFacets(
  facets: Record<string, unknown>,
  low: Record<string, number>,
  high: Record<string, number>,
): number {
  let dot = 0;
  let len2 = 0;
  for (const k of Object.keys(low)) {
    const d = high[k] - low[k];
    if (!Number.isFinite(d)) continue;
    const raw = facets[k];
    const f = typeof raw === 'number' && Number.isFinite(raw) ? raw : low[k];
    dot += (f - low[k]) * d;
    len2 += d * d;
  }
  if (len2 === 0) return NEUTRAL_ANCHOR;
  return clamp01(dot / len2);
}

export function computeAxisScore(axis: AxisKey, facets: Record<string, unknown>, confidence: number): number {
  const { low, high } = AXIS_POLES[axis];
  const t = projectFacets(facets, low, high);
  const c = Number.isFinite(confidence) ? clamp01(confidence) : 0;
  return clamp01(c * t + (1 - c) * NEUTRAL_ANCHOR);
}

export interface RecomputeResult {
  changed: boolean;
  /** 축별 (이전 → 이후). 변동 없는 축도 포함. */
  deltas: Record<AxisKey, { before: number; after: number }>;
}

/**
 * profile.axes.*.score 를 재계산해 **mutate** 하고, 하나라도 바뀌면
 * metadata.last_reclassification_at 을 now 로 기록한다. 저장은 호출자 몫.
 */
export function recomputeProfileScores(profile: Profile, now: Date = new Date()): RecomputeResult {
  const deltas = {} as RecomputeResult['deltas'];
  let changed = false;
  for (const axis of AXIS_KEYS) {
    const a = profile.axes[axis];
    const before = typeof a?.score === 'number' ? a.score : NEUTRAL_ANCHOR;
    if (!a?.facets) { deltas[axis] = { before, after: before }; continue; }
    const after = Number((computeAxisScore(axis, a.facets as unknown as Record<string, unknown>, a.confidence)).toFixed(4));
    deltas[axis] = { before, after };
    if (Math.abs(after - before) > 1e-9) { a.score = after; changed = true; }
  }
  if (changed) profile.metadata.last_reclassification_at = now.toISOString();
  return { changed, deltas };
}

/**
 * 방향 판정: 0.5 ± 0.1 은 'mid', 그 밖은 가까운 극('low'|'high'). 라벨 문자열은 렌더러가
 * locale 에 맞춰 만든다 (critic: 하드코딩 한국어 라벨은 en 사용자에게 혼합 출력).
 * 주의 — 'mid' 는 "미학습" 이 아니다. facet 이 서로 반대 방향이면(예: verification_depth 1.0
 * 이지만 stop_threshold 0.25) 투영이 중간으로 수렴한다.
 */
export function axisDirection(score: number): 'low' | 'mid' | 'high' {
  if (score < 0.4) return 'low';
  if (score > 0.6) return 'high';
  return 'mid';
}
