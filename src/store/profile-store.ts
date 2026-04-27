/**
 * Forgen v1 — Profile Store
 *
 * Profile CRUD. 4축 + facet + trust preferences.
 * Authoritative schema: docs/plans/2026-04-03-forgen-data-model-storage-spec.md §2
 */

import * as fs from 'node:fs';
import { FORGE_PROFILE } from '../core/paths.js';
import { atomicWriteJSON, safeReadJSON } from '../hooks/shared/atomic-write.js';
import type { Profile, QualityPack, AutonomyPack, JudgmentPack, CommunicationPack, TrustPolicy } from './types.js';
import {
  qualityCentroid,
  autonomyCentroid,
  judgmentCentroid,
  communicationCentroid,
} from '../preset/facet-catalog.js';

const MODEL_VERSION = '2.0';

export function createProfile(
  userId: string,
  qualityPack: QualityPack,
  autonomyPack: AutonomyPack,
  trustPolicy: TrustPolicy,
  trustSource: Profile['trust_preferences']['source'],
  judgmentPack: JudgmentPack = '균형형',
  communicationPack: CommunicationPack = '균형형',
): Profile {
  const now = new Date().toISOString();
  return {
    user_id: userId,
    model_version: MODEL_VERSION,
    axes: {
      quality_safety: { score: 0.5, facets: qualityCentroid(qualityPack), confidence: 0.45 },
      autonomy: { score: 0.5, facets: autonomyCentroid(autonomyPack), confidence: 0.45 },
      judgment_philosophy: { score: 0.5, facets: judgmentCentroid(judgmentPack), confidence: 0.45 },
      communication_style: { score: 0.5, facets: communicationCentroid(communicationPack), confidence: 0.45 },
    },
    base_packs: {
      quality_pack: qualityPack,
      autonomy_pack: autonomyPack,
      judgment_pack: judgmentPack,
      communication_pack: communicationPack,
    },
    trust_preferences: { desired_policy: trustPolicy, source: trustSource },
    metadata: {
      created_at: now,
      updated_at: now,
      last_onboarding_at: now,
      last_reclassification_at: null,
    },
  };
}

export function loadProfile(): Profile | null {
  const raw = safeReadJSON<unknown>(FORGE_PROFILE, null);
  if (raw === null) return null;
  // Audit fix #6 (2026-04-21): 이전에는 disk 내용을 그대로 Profile로
  // 타입 단언해 반환 → legacy-shaped JSON (model_version 없음 / 1.x / 잘못된 모양)
  // 이 downstream으로 흘러들어가 facets/trust_preferences 접근 시 undefined
  // 참조가 되었다. isV1Profile 가드를 통과한 경우에만 반환, 아니면 null로
  // 취급하여 v1-bootstrap이 cutover 흐름을 재실행하게 한다.
  if (!isV1Profile(raw)) return null;
  return raw;
}

export function loadProfileRaw(): unknown {
  return safeReadJSON<unknown>(FORGE_PROFILE, null);
}

export function saveProfile(profile: Profile): void {
  profile.metadata.updated_at = new Date().toISOString();
  atomicWriteJSON(FORGE_PROFILE, profile, { pretty: true });
}

/**
 * File existence probe. NOTE: this returns `true` even if the on-disk
 * file is legacy/invalid — callers that need "valid v1 profile present"
 * should combine this with `loadProfile() !== null`. The raw existence
 * check is kept for bootstrap logic that explicitly differentiates
 * "file exists but legacy" from "no file at all" (e.g. to decide
 * whether to run `runLegacyCutover`).
 */
export function profileExists(): boolean {
  return fs.existsSync(FORGE_PROFILE);
}

export function isV1Profile(data: unknown): data is Profile {
  if (!data || typeof data !== 'object') return false;
  const p = data as Record<string, unknown>;
  return typeof p.model_version === 'string' && p.model_version.startsWith('2.');
}

/**
 * D2 fix (2026-04-27): explicit_correction 누적 시 해당 축의 confidence 를 점진
 * 상승시킨다. facet 값은 건드리지 않음 (회귀 위험 최소화) — confidence 가 score
 * 집계 공식 (confidence × facet_avg + (1-confidence) × neutral_anchor) 의 가중치
 * 라서, 사용자가 명시 교정을 누적한 축은 score 가 facet 평균을 더 강하게 반영.
 *
 * 자기증거: autonomy explicit_correction 6건이 score 를 못 움직였음 (facet 값
 * 갱신 경로가 mismatch-detector 의 strong rule 승급에만 의존). 본 함수가 직접
 * 경로를 추가.
 *
 * delta 기본 0.02 — 6건 누적 시 +0.12 → 0.45 → 0.57 (의미 있는 변동 가시화).
 * clamp 0~1.
 */
export function bumpAxisConfidence(
  axis: 'quality_safety' | 'autonomy' | 'judgment_philosophy' | 'communication_style',
  delta: number = 0.02,
): boolean {
  const profile = loadProfile();
  if (!profile) return false;
  const target = profile.axes[axis];
  if (!target || typeof target.confidence !== 'number') return false;
  const next = Math.max(0, Math.min(1, target.confidence + delta));
  if (next === target.confidence) return false;
  target.confidence = next;
  saveProfile(profile);
  return true;
}

/**
 * feat/codex-support — default_host 영속화 헬퍼.
 *
 * fgx / forgen 무인자 실행 시 어느 host 를 spawn 할지 결정. 'ask' 면 매번 묻기.
 * 미설정(undefined) 은 legacy 사용자 호환 — 'claude' 로 resolve.
 */
export type DefaultHost = 'claude' | 'codex' | 'ask';

export function getDefaultHost(): DefaultHost | undefined {
  const profile = loadProfile();
  return profile?.default_host;
}

export function setDefaultHost(host: DefaultHost): boolean {
  const profile = loadProfile();
  if (!profile) return false;
  profile.default_host = host;
  profile.metadata.updated_at = new Date().toISOString();
  saveProfile(profile);
  return true;
}

/**
 * Resolve effective host for runtime use.
 * 우선순위: explicit override > profile.default_host > 'claude' fallback.
 * 'ask' 는 caller 가 별도 처리 (interactive prompt).
 */
export function resolveDefaultHost(override?: 'claude' | 'codex'): 'claude' | 'codex' | 'ask' {
  if (override) return override;
  const stored = getDefaultHost();
  if (stored === undefined) return 'claude';
  return stored;
}
