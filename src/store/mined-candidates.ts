/**
 * 채굴(추론) 룰 후보 단계 (2026-11 재설계 D5, 0.7.0).
 *
 * 채굴 룰은 status 'candidate' 로 태어나고, 근거 증거의 서로 다른 session_id 가 2개 이상이 되면 active 가 된다.
 * 수명·상한의 기준 시각은 생성 시각이 아니라 마지막 근거(증거 timestamp 최댓값)다.
 * evidence-store 가 이 모듈을 쓰므로 여기서는 evidence-store 를 import 하지 않는다(순환 방지).
 */
import * as path from 'node:path';
import { ME_BEHAVIOR } from '../core/paths.js';
import { safeReadJSON } from '../hooks/shared/atomic-write.js';
import type { Evidence, Rule, RuleStatus } from './types.js';

export const AUTO_MINED_PREFIX = 'auto:';
export const MIN_CANDIDATE_SESSIONS = 2;
export const MINED_TTL_MS = 21 * 24 * 60 * 60 * 1000; // 21일 — 마지막 근거 기준
export const MINED_MAX_ACTIVE = 30;
export const MINED_MAX_CANDIDATES = 100;

export function isMinedRule(r: Pick<Rule, 'source' | 'render_key'>): boolean {
  return r.source === 'behavior_inference' && (r.render_key ?? '').startsWith(AUTO_MINED_PREFIX);
}

function readEvidence(id: string): Evidence | null {
  if (!id || id !== path.basename(id)) return null;
  return safeReadJSON<Evidence | null>(path.join(ME_BEHAVIOR, `${id}.json`), null);
}

/** 증거들의 서로 다른 session_id. 읽지 못한 증거는 세지 않는다. */
export function evidenceSessions(refs: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const id of refs) {
    const sid = readEvidence(id)?.session_id;
    if (sid) out.add(sid);
  }
  return out;
}

/** 마지막 근거 시각(ms). 증거를 하나도 못 읽으면 created_at. */
export function lastEvidenceAt(rule: Pick<Rule, 'evidence_refs' | 'created_at'>): number {
  let best = -Infinity;
  for (const id of rule.evidence_refs ?? []) {
    const t = Date.parse(readEvidence(id)?.timestamp ?? '');
    if (Number.isFinite(t) && t > best) best = t;
  }
  return Number.isFinite(best) ? best : Date.parse(rule.created_at);
}

/** 근거 세션 수로 정한 채굴 룰 상태. */
export function minedStatusFor(refs: readonly string[]): Extract<RuleStatus, 'active' | 'candidate'> {
  return evidenceSessions(refs).size >= MIN_CANDIDATE_SESSIONS ? 'active' : 'candidate';
}

/**
 * 같은 개념 재관측 시 채굴 룰 범위 병합 (D5-5·D6-2).
 *   들어온 것이 general(scope_hint) → 전역
 *   들어온 것이 프로젝트 → 기존이 전역이면 전역 유지, 아니면 합집합
 *   정보 없음(홈 디렉터리 세션 등) → 기존 유지
 * 기존 룰이 아직 범위를 정한 적 없는 비활성 룰이어도 같은 규칙을 쓴다(채굴 룰은 범위를 Haiku 판단으로만 받는다).
 */
export function mergeMinedProjects(existing: Pick<Rule, 'projects'>, payload: Record<string, unknown> | undefined): string[] | undefined {
  if (payload?.scope_hint === 'general') return undefined;
  const incoming = Array.isArray(payload?.projects) ? (payload!.projects as unknown[]).filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
  if (!existing.projects?.length) return undefined;
  if (incoming.length === 0) return existing.projects;
  return [...new Set([...existing.projects, ...incoming])].sort();
}

/** 새 채굴 룰의 범위: general → 전역, 프로젝트 키가 있으면 그 프로젝트, 아니면 전역. */
export function minedProjectsForNew(payload: Record<string, unknown> | undefined): string[] | undefined {
  if (payload?.scope_hint === 'general') return undefined;
  const p = Array.isArray(payload?.projects) ? (payload!.projects as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  return p.length ? [...new Set(p)].sort() : undefined;
}
