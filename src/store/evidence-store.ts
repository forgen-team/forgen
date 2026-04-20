/**
 * Forgen v1 — Evidence Store
 *
 * explicit_correction, behavior_observation, session_summary CRUD.
 * Authoritative schema: docs/plans/2026-04-03-forgen-data-model-storage-spec.md §4
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ME_BEHAVIOR } from '../core/paths.js';
import { atomicWriteJSON, safeReadJSON } from '../hooks/shared/atomic-write.js';
import type { Evidence, EvidenceType, RuleCategory } from './types.js';
import { createRule, saveRule, loadActiveRules } from './rule-store.js';

function evidencePath(evidenceId: string): string {
  return path.join(ME_BEHAVIOR, `${evidenceId}.json`);
}

export function createEvidence(params: {
  type: EvidenceType;
  session_id: string;
  source_component: string;
  summary: string;
  axis_refs?: string[];
  candidate_rule_refs?: string[];
  confidence: number;
  raw_payload?: Record<string, unknown>;
}): Evidence {
  return {
    evidence_id: crypto.randomUUID(),
    type: params.type,
    session_id: params.session_id,
    timestamp: new Date().toISOString(),
    source_component: params.source_component,
    summary: params.summary,
    axis_refs: params.axis_refs ?? [],
    candidate_rule_refs: params.candidate_rule_refs ?? [],
    confidence: params.confidence,
    raw_payload: params.raw_payload ?? {},
  };
}

export function saveEvidence(evidence: Evidence): void {
  atomicWriteJSON(evidencePath(evidence.evidence_id), evidence, { pretty: true });
}

export function loadEvidence(evidenceId: string): Evidence | null {
  return safeReadJSON<Evidence | null>(evidencePath(evidenceId), null);
}

export function loadAllEvidence(): Evidence[] {
  if (!fs.existsSync(ME_BEHAVIOR)) return [];
  const items: Evidence[] = [];
  for (const file of fs.readdirSync(ME_BEHAVIOR)) {
    if (!file.endsWith('.json')) continue;
    const ev = safeReadJSON<Evidence | null>(path.join(ME_BEHAVIOR, file), null);
    if (ev) items.push(ev);
  }
  return items;
}

export function loadEvidenceBySession(sessionId: string): Evidence[] {
  return loadAllEvidence().filter(e => e.session_id === sessionId);
}

export function loadEvidenceByType(type: EvidenceType): Evidence[] {
  return loadAllEvidence().filter(e => e.type === type);
}

export function loadRecentEvidence(limit: number = 20): Evidence[] {
  return loadAllEvidence()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
}

/** prefer-from-now / avoid-this 교정 evidence를 모두 반환 (규칙 승격 후보) */
export function loadPromotionCandidates(): Evidence[] {
  return loadAllEvidence().filter(e => {
    if (e.type !== 'explicit_correction') return false;
    const kind = (e.raw_payload as Record<string, unknown>)?.kind as string | undefined;
    return kind === 'prefer-from-now' || kind === 'avoid-this';
  });
}

/**
 * 특정 세션의 promotion 후보를 scope:'me' 영구 규칙으로 승격.
 * 동일 render_key를 가진 scope:'me' 규칙이 이미 있으면 건너뜀.
 * @returns 승격된 규칙 수
 */
export function promoteSessionCandidates(sessionId: string): number {
  const candidates = loadPromotionCandidates().filter(e => e.session_id === sessionId);
  if (candidates.length === 0) return 0;

  const activeRules = loadActiveRules();
  const existingRenderKeys = new Set(
    activeRules.filter(r => r.scope === 'me').map(r => r.render_key),
  );

  let promoted = 0;
  for (const candidate of candidates) {
    const payload = candidate.raw_payload as Record<string, unknown>;
    const axisHint = payload?.axis_hint as string | null | undefined;
    const target = payload?.target as string | undefined;
    const kind = payload?.kind as string | undefined;

    if (!target) continue;

    const renderKey = `${axisHint ?? 'workflow'}.${target.toLowerCase().replace(/\s+/g, '-').slice(0, 30)}`;
    if (existingRenderKeys.has(renderKey)) continue;

    const category: RuleCategory =
      axisHint === 'quality_safety' ? 'quality'
      : axisHint === 'autonomy' ? 'autonomy'
      : 'workflow';

    const rule = createRule({
      category,
      scope: 'me',
      trigger: target,
      policy: candidate.summary,
      strength: kind === 'avoid-this' ? 'strong' : 'default',
      source: 'explicit_correction',
      evidence_refs: [candidate.evidence_id],
      render_key: renderKey,
    });
    saveRule(rule);
    existingRenderKeys.add(renderKey);
    promoted++;
  }

  return promoted;
}
