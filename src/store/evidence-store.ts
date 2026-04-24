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
import { classify, applyProposal } from '../engine/enforce-classifier.js';
import { detect as detectT1 } from '../engine/lifecycle/trigger-t1-correction.js';
import { foldEvents } from '../engine/lifecycle/orchestrator.js';
import { appendLifecycleEvents } from '../engine/lifecycle/meta-reclassifier.js';

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

/** TEST-4 / RC4: behavior_observation 의 summary 가 의미있는 내용을 담아야 분석 가능. */
const MIN_BEHAVIOR_OBSERVATION_LEN = 20;

export function saveEvidence(evidence: Evidence): void {
  // TEST-4 / RC4: 빈/짧은 behavior_observation 은 저장 거부.
  // 결함: ~/.forgen/me/behavior/*.json 다수에 summary="" 가 누적되어 학습 데이터가
  // 분석 불가능한 형태로 쌓임. saveEvidence 가 마지막 게이트라 여기서 거른다.
  // 다른 evidence type (explicit_correction, session_summary) 은 backward compat.
  if (evidence.type === 'behavior_observation') {
    const len = (evidence.summary ?? '').trim().length;
    if (len < MIN_BEHAVIOR_OBSERVATION_LEN) return;
  }
  atomicWriteJSON(evidencePath(evidence.evidence_id), evidence, { pretty: true });
}

/**
 * ADR-002 T1 — explicit_correction evidence 저장 + orchestrator 호출.
 *
 * saveEvidence 와의 차이:
 *   - type='explicit_correction' 인 경우 T1 detect 실행 → 매칭된 rule 상태 전이 적용.
 *   - orchestrator 호출은 best-effort (실패해도 evidence 저장은 유지).
 *   - correction_kind 는 raw_payload.kind 에서 추론 (CorrectionRequest 와 호환).
 *
 * 기존 saveEvidence 를 호출하는 코드는 그대로 둬도 됨 (하위 호환). T1 emission 이 필요한
 * 호출지(correction-record MCP, evidence-processor)만 이 함수로 전환.
 */
export function appendEvidence(evidence: Evidence): { saved: true; t1_events: number } {
  saveEvidence(evidence);
  if (evidence.type !== 'explicit_correction') return { saved: true, t1_events: 0 };

  try {
    const rawKind = (evidence.raw_payload as Record<string, unknown> | undefined)?.kind;
    const correctionKind = rawKind === 'avoid-this' || rawKind === 'fix-now' || rawKind === 'prefer-from-now'
      ? rawKind
      : undefined;
    const rules = loadActiveRules();
    const events = detectT1({ evidence, correction_kind: correctionKind, rules });
    if (events.length === 0) return { saved: true, t1_events: 0 };

    const folded = foldEvents(rules, events);
    for (const [ruleId, updated] of folded.entries()) {
      const original = rules.find((r) => r.rule_id === ruleId);
      if (!original || updated === original) continue;
      saveRule(updated);
    }
    appendLifecycleEvents(events);
    return { saved: true, t1_events: events.length };
  } catch {
    // best-effort: orchestrator 실패는 evidence 저장 자체를 막지 않는다.
    return { saved: true, t1_events: 0 };
  }
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

    let rule = createRule({
      category,
      scope: 'me',
      trigger: target,
      policy: candidate.summary,
      strength: kind === 'avoid-this' ? 'strong' : 'default',
      source: 'explicit_correction',
      evidence_refs: [candidate.evidence_id],
      render_key: renderKey,
    });
    // ADR-001 auto-classify — 승격되는 rule 에도 enforce_via 자동 주입.
    try {
      const proposal = classify(rule);
      rule = applyProposal(rule, proposal);
    } catch { /* fail-open */ }
    saveRule(rule);
    existingRenderKeys.add(renderKey);
    promoted++;
  }

  return promoted;
}
