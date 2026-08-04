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
import { HOST_IDS, type HostId } from '../core/trust-layer-intent.js';
import { createRule, saveRule, loadActiveRules, updateRuleStatus } from './rule-store.js';
import { classify, applyProposal } from '../engine/enforce-classifier.js';
import { detect as detectT1 } from '../engine/lifecycle/trigger-t1-correction.js';
import { foldEvents } from '../engine/lifecycle/orchestrator.js';
import { appendLifecycleEvents } from '../engine/lifecycle/meta-reclassifier.js';

function evidencePath(evidenceId: string): string {
  return path.join(ME_BEHAVIOR, `${evidenceId}.json`);
}

/**
 * 현재 세션이 어느 host 에서 실행되는지 추론 (Multi-Host §4.2).
 * 1) explicit `params.host`
 * 2) env var `FORGEN_HOST` (e2e 격리용 / MCP server 가 --host=codex 받으면 set)
 * 3) `FORGEN_RUNTIME` env (config-injector.ts:479 가 harness spawn 시 주입)
 * 4) Codex CLI 흔적 (`CODEX_HOME` 또는 `CODEX_SANDBOX_NETWORK_DISABLED`)
 * 5) default 'claude' (1원칙)
 *
 * v0.4.10 fix: 3번 fallback 이 주석에만 있고 코드에 없어서 Codex harness 세션의
 * auto-compound-runner 가 생성하는 behavior_observation evidence 가 전부 'claude'
 * 로 잘못 태깅 → doctor 가 98/2 격차 경고. FORGEN_RUNTIME 을 직접 읽도록 추가.
 */
function detectHost(explicit?: HostId): HostId {
  if (explicit) return explicit;
  // W3-3 리뷰 SEV-3 #5: 이진비교(=== 'claude' || === 'codex') 대신 HOST_IDS 정준목록으로
  // 유효 host 를 해소해 FORGEN_HOST/FORGEN_RUNTIME='opencode' 도 보존(self-evidence-record 일관).
  const fromEnv = process.env.FORGEN_HOST;
  if (fromEnv && (HOST_IDS as readonly string[]).includes(fromEnv)) return fromEnv as HostId;
  const fromRuntime = process.env.FORGEN_RUNTIME;
  if (fromRuntime && (HOST_IDS as readonly string[]).includes(fromRuntime)) return fromRuntime as HostId;
  if (process.env.CODEX_HOME || process.env.CODEX_SANDBOX_NETWORK_DISABLED) return 'codex';
  return 'claude';
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
  host?: HostId;
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
    host: detectHost(params.host),
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

/**
 * 기존 evidence 에 host 필드가 없거나 유효하지 않으면 'claude' 로 backfill
 * (Multi-Host §4.2 마이그레이션 정책). 새 multi-host 도입 이전 데이터는 모두 Claude 발생.
 *
 * W3-3 리뷰 SEV-3 #5: 이전엔 `!== 'claude' && !== 'codex'` 라 **유효한 'opencode' 태그도
 * claude 로 clobber** → self-evidence-record='supported'(host:"opencode") 선언과 정면 모순.
 * 이제 HOST_IDS 정준 목록으로 "유효 host" 를 판정해 opencode 등 모든 유효 태그를 보존한다.
 */
function backfillHost(ev: Evidence | null): Evidence | null {
  if (!ev) return ev;
  if (ev.host && (HOST_IDS as readonly string[]).includes(ev.host)) return ev;
  return { ...ev, host: 'claude' };
}

export function loadEvidence(evidenceId: string): Evidence | null {
  return backfillHost(safeReadJSON<Evidence | null>(evidencePath(evidenceId), null));
}

export function loadAllEvidence(): Evidence[] {
  if (!fs.existsSync(ME_BEHAVIOR)) return [];
  const items: Evidence[] = [];
  for (const file of fs.readdirSync(ME_BEHAVIOR)) {
    if (!file.endsWith('.json')) continue;
    const ev = safeReadJSON<Evidence | null>(path.join(ME_BEHAVIOR, file), null);
    const filled = backfillHost(ev);
    if (filled) items.push(filled);
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
/**
 * ADR-013 채굴 교정 안전 파라미터 (리뷰 SEV-1 대응):
 * - 채굴 룰은 "auto:" render_key 네임스페이스로 분리 → 실시간 명시 교정과 절대 충돌/억제 안 함.
 * - advisory-only: enforce_via=[] (차단 메커니즘 미부여). 환각 교정이 차단 룰이 되는 것 근절.
 * - 생성나이 은퇴: TTL 지난 미확인 채굴 룰 retire (me-scope 룰이 매 세션 주입돼 ROI/T4 로는
 *   은퇴 안 되던 문제의 실제 해소). + 라이브 채굴 룰 총량 상한.
 */
const AUTO_MINED_PREFIX = 'auto:';
const AUTO_MINED_TTL_MS = 21 * 24 * 60 * 60 * 1000; // 21일
const AUTO_MINED_MAX_LIVE = 30;

/** 채굴(behavior_inference) 룰 은퇴: TTL 초과 + 총량 상한 초과분(오래된 순). */
function retireStaleAutoMinedRules(now: number): void {
  const auto = loadActiveRules().filter(
    (r) => r.scope === 'me' && r.source === 'behavior_inference' && r.render_key?.startsWith(AUTO_MINED_PREFIX),
  );
  const byAge = auto
    .map((r) => ({ r, age: now - Date.parse(r.created_at) }))
    .sort((a, b) => b.age - a.age); // 오래된 순
  const keep: typeof byAge = [];
  for (const item of byAge) {
    if (item.age >= AUTO_MINED_TTL_MS) {
      updateRuleStatus(item.r.rule_id, 'removed'); // TTL 초과 → 은퇴
    } else {
      keep.push(item);
    }
  }
  // 총량 상한 초과분(가장 오래된 것부터) 은퇴.
  const excess = keep.length - AUTO_MINED_MAX_LIVE;
  for (let i = 0; i < excess; i++) updateRuleStatus(keep[i].r.rule_id, 'removed');
}

export function promoteSessionCandidates(sessionId: string): number {
  const candidates = loadPromotionCandidates().filter(e => e.session_id === sessionId);
  if (candidates.length === 0) return 0;

  retireStaleAutoMinedRules(Date.now()); // 승급 전 오래된 채굴 룰 정리 (SEV-1 #1)

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
    const autoMined = payload?.auto_mined === true;

    if (!target) continue;

    // 채굴 룰은 "auto:" 네임스페이스 — 실시간 교정 render_key 와 절대 충돌 안 함 (SEV-2 #4).
    const baseKey = `${axisHint ?? 'workflow'}.${target.toLowerCase().replace(/\s+/g, '-').slice(0, 30)}`;
    const renderKey = autoMined ? `${AUTO_MINED_PREFIX}${baseKey}` : baseKey;
    if (existingRenderKeys.has(renderKey)) continue;

    const category: RuleCategory =
      axisHint === 'quality_safety' ? 'quality'
      : axisHint === 'autonomy' ? 'autonomy'
      : 'workflow';

    // ADR-013: 채굴 교정(auto_mined)은 실시간 명시 교정과 엄격 차등 — provenance
    // =behavior_inference, strength 절대 strong 아님(default).
    let rule = createRule({
      category,
      scope: 'me',
      trigger: target,
      policy: candidate.summary,
      strength: autoMined ? 'default' : kind === 'avoid-this' ? 'strong' : 'default',
      source: autoMined ? 'behavior_inference' : 'explicit_correction',
      evidence_refs: [candidate.evidence_id],
      render_key: renderKey,
    });
    if (autoMined) {
      // advisory-only (SEV-1 #2): classify() 를 돌리지 않고 enforce_via 를 비워, 채굴 룰이
      // 절대 Mech-A 차단(PreToolUse/Stop block)을 얻지 못하게 한다. 컨텍스트 주입만 되고
      // 어떤 훅도 강제하지 않음 — 환각 교정이 영구 차단 룰이 되는 위험 근절.
      rule.enforce_via = [];
    } else {
      // ADR-001 auto-classify — 실시간 승격 rule 에만 enforce_via 자동 주입.
      try {
        const proposal = classify(rule);
        rule = applyProposal(rule, proposal);
      } catch { /* fail-open */ }
    }
    saveRule(rule);
    existingRenderKeys.add(renderKey);
    promoted++;
  }

  return promoted;
}
