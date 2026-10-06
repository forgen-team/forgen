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
import type { HostId } from '../core/trust-layer-intent.js';
import {
  qualityCentroid,
  autonomyCentroid,
  judgmentCentroid,
  communicationCentroid,
} from '../preset/facet-catalog.js';
import { recomputeProfileScores, type RecomputeResult } from './profile-score.js';

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
 * ADR-017 §6-8: facet 또는 confidence 가 바뀐 뒤에는 반드시 이 경로로 저장한다.
 * 4축 score 를 재계산(profile-score.ts)하고 last_reclassification_at 을 기록한 뒤 저장.
 * facet/confidence 를 건드리는 코드 쓰기(bumpAxisConfidence, auto-compound profile_delta)는
 * saveProfile 직접 호출 대신 이 함수를 쓴다 — raw write 로 우회하면 score 가 다시 고정된다
 * (v0.1.0~0.5.9 결함의 원인). 주의: calibrate 스킬(skills/calibrate)은 Claude 세션이 파일을
 * 직접 편집하는 설계라 이 경로를 타지 않는다 — 그 경우 다음 bump/auto-compound 또는
 * SessionStart 까지 score 가 stale 일 수 있다.
 */
export function saveProfileRecomputed(profile: Profile): RecomputeResult {
  const r = recomputeProfileScores(profile);
  saveProfile(profile);
  return r;
}

/**
 * 1회성 마이그레이션: score 산출 로직이 없던 버전에서 만들어진 프로필은
 * last_reclassification_at 이 null 이다. 그 경우에만 재계산·저장하고 결과를 반환.
 * (SessionStart bootstrap 이 호출. 이미 계산된 프로필은 건드리지 않는다.)
 */
export function recomputeIfNeverReclassified(): RecomputeResult | null {
  const profile = loadProfile();
  if (!profile) return null;
  // 키 누락(구버전 파일)도 null 로 취급 — `!== null` 만 보면 영구 스킵된다 (critic).
  if (profile.metadata.last_reclassification_at) return null;
  const r = recomputeProfileScores(profile);
  // "1회" 불변식: 계산 결과가 저장값과 같아 changed=false 여도 실행 사실을 스탬프한다.
  // 안 그러면 매 SessionStart 마다 재계산·재저장을 반복한다 (critic SEV-2).
  if (!profile.metadata.last_reclassification_at) profile.metadata.last_reclassification_at = new Date().toISOString();
  saveProfile(profile);
  return r;
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

/**
 * profile.json 이 존재하지만 parse 실패 / v1 shape 위반인 경우, 사용자가
 * 다음 onboarding 으로 매끄럽게 복구되도록 corrupt 파일을 timestamp 백업
 * 으로 옆에 치워둔다. 백업 경로를 반환.
 *
 * v0.4.8 — bootstrapV1Session 의 loadProfile()=null early-return 보강.
 * 이전엔 needsOnboarding=true 만 반환했고 corrupt 파일이 그대로 남아
 * 다음 실행 때도 동일 분기로 빠지면서 사용자가 정체 원인을 모른 채
 * onboarding 안내만 반복 받는 패턴이었음.
 */
export function backupCorruptProfile(): string | null {
  if (!fs.existsSync(FORGE_PROFILE)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${FORGE_PROFILE}.corrupt-${ts}`;
  try {
    fs.renameSync(FORGE_PROFILE, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

export function isV1Profile(data: unknown): data is Profile {
  if (!data || typeof data !== 'object') return false;
  const p = data as Record<string, unknown>;
  return typeof p.model_version === 'string' && p.model_version.startsWith('2.');
}

/**
 * D2 fix (2026-04-27): explicit_correction 누적 시 해당 축의 confidence 를 점진
 * 상승시킨다. facet 값은 건드리지 않음 (회귀 위험 최소화) — confidence 가 score
 * 집계 공식 (confidence × facet_pos + (1-confidence) × neutral_anchor) 의 가중치
 * 라서, 사용자가 명시 교정을 누적한 축은 score 가 facet 위치를 더 강하게 반영.
 *
 * 자기증거: autonomy explicit_correction 6건이 score 를 못 움직였음. 원인은 두 겹 —
 * (1) facet 갱신 경로 부재, (2) **score 집계 공식 자체가 미구현**(2026-10-06 ADR-017 §1.5b
 * 확인: v0.1.0 부터 score 는 0.5 리터럴 고정). (2)는 profile-score.ts 가 해결.
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
  // ADR-017: confidence 는 score 공식의 가중치이므로 바뀌면 score 를 재계산한다.
  saveProfileRecomputed(profile);
  return true;
}

/**
 * feat/codex-support — default_host 영속화 헬퍼.
 *
 * fgx / forgen 무인자 실행 시 어느 host 를 spawn 할지 결정. 'ask' 면 매번 묻기.
 * 미설정(undefined) 은 legacy 사용자 호환 — 'claude' 로 resolve.
 */
export type DefaultHost = HostId | 'ask';

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
export function resolveDefaultHost(override?: HostId): DefaultHost {
  if (override) return override;
  const stored = getDefaultHost();
  if (stored === undefined) return 'claude';
  return stored;
}
