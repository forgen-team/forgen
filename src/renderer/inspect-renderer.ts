/**
 * Forgen v1 — Inspect Renderer
 *
 * forgen inspect profile/rules/evidence/session 출력 생성.
 * Authoritative spec: docs/plans/2026-04-03-forgen-rule-renderer-spec.md §6
 */

import type { Profile, Rule, Evidence, SessionEffectiveState } from '../store/types.js';
import { axisDirection, AXIS_POLES, type AxisKey } from '../store/profile-score.js';
import type { QualityPack, AutonomyPack, JudgmentPack, CommunicationPack } from '../store/types.js';
import { initLocaleFromConfig, getLocale, qualityName, autonomyName, judgmentName, communicationName, trustName } from '../i18n/index.js';

/** 축 방향 라벨 — 팩 이름을 locale 로 변환. mid 는 "중간/mid" (미학습 아님). */
function dirLabel(axis: AxisKey, score: number, l: ReturnType<typeof getLocale>): string {
  const d = axisDirection(score);
  if (d === 'mid') return l === 'ko' ? '중간' : 'mid';
  const pack = d === 'low' ? AXIS_POLES[axis].lowPack : AXIS_POLES[axis].highPack;
  const name = axis === 'quality_safety' ? qualityName(pack as QualityPack, l)
    : axis === 'autonomy' ? autonomyName(pack as AutonomyPack, l)
    : axis === 'judgment_philosophy' ? judgmentName(pack as JudgmentPack, l)
    : communicationName(pack as CommunicationPack, l);
  return l === 'ko' ? `${name} 쪽` : `→ ${name}`;
}

export function renderProfile(profile: Profile): string {
  initLocaleFromConfig();
  const l = getLocale();
  const lines: string[] = [
    `Profile v${profile.model_version} | updated: ${profile.metadata.updated_at}`,
    '',
    `Quality pack: ${qualityName(profile.base_packs.quality_pack, l)}`,
    `Autonomy pack: ${autonomyName(profile.base_packs.autonomy_pack, l)}`,
    `Judgment pack: ${judgmentName(profile.base_packs.judgment_pack, l)}`,
    `Communication pack: ${communicationName(profile.base_packs.communication_pack, l)}`,
    `Trust policy: ${trustName(profile.trust_preferences.desired_policy, l)} (source: ${profile.trust_preferences.source})`,
    '',
    `── 4축 상위 score ── (score = confidence × facet 위치 + (1 − confidence) × 0.5; 0=${l === 'ko' ? '왼쪽 팩' : 'left pack'}, 1=${l === 'ko' ? '오른쪽 팩' : 'right pack'})`,
    `  품질/안전: ${profile.axes.quality_safety.score.toFixed(2)} ${dirLabel('quality_safety', profile.axes.quality_safety.score, l)} (confidence: ${profile.axes.quality_safety.confidence.toFixed(2)})`,
    `  자율성:   ${profile.axes.autonomy.score.toFixed(2)} ${dirLabel('autonomy', profile.axes.autonomy.score, l)} (confidence: ${profile.axes.autonomy.confidence.toFixed(2)})`,
    `  판단철학: ${profile.axes.judgment_philosophy.score.toFixed(2)} ${dirLabel('judgment_philosophy', profile.axes.judgment_philosophy.score, l)} (confidence: ${profile.axes.judgment_philosophy.confidence.toFixed(2)})`,
    `  커뮤니케이션: ${profile.axes.communication_style.score.toFixed(2)} ${dirLabel('communication_style', profile.axes.communication_style.score, l)} (confidence: ${profile.axes.communication_style.confidence.toFixed(2)})`,
    `  Last reclass: ${profile.metadata.last_reclassification_at ?? 'never'}`,
    '',
    '── Quality facets ──',
    `  verification_depth: ${profile.axes.quality_safety.facets.verification_depth.toFixed(2)}`,
    `  stop_threshold: ${profile.axes.quality_safety.facets.stop_threshold.toFixed(2)}`,
    `  change_conservatism: ${profile.axes.quality_safety.facets.change_conservatism.toFixed(2)}`,
    '',
    '── Autonomy facets ──',
    `  confirmation_independence: ${profile.axes.autonomy.facets.confirmation_independence.toFixed(2)}`,
    `  assumption_tolerance: ${profile.axes.autonomy.facets.assumption_tolerance.toFixed(2)}`,
    `  scope_expansion_tolerance: ${profile.axes.autonomy.facets.scope_expansion_tolerance.toFixed(2)}`,
    `  approval_threshold: ${profile.axes.autonomy.facets.approval_threshold.toFixed(2)}`,
    '',
    '── Judgment facets ──',
    `  minimal_change_bias: ${profile.axes.judgment_philosophy.facets.minimal_change_bias.toFixed(2)}`,
    `  abstraction_bias: ${profile.axes.judgment_philosophy.facets.abstraction_bias.toFixed(2)}`,
    `  evidence_first_bias: ${profile.axes.judgment_philosophy.facets.evidence_first_bias.toFixed(2)}`,
    '',
    '── Communication facets ──',
    `  verbosity: ${profile.axes.communication_style.facets.verbosity.toFixed(2)}`,
    `  structure: ${profile.axes.communication_style.facets.structure.toFixed(2)}`,
    `  teaching_bias: ${profile.axes.communication_style.facets.teaching_bias.toFixed(2)}`,
  ];
  return lines.join('\n');
}

export function renderRules(rules: Rule[]): string {
  const active = rules.filter(r => r.status === 'active');
  const suppressed = rules.filter(r => r.status === 'suppressed');

  const lines: string[] = [];

  if (active.length > 0) {
    lines.push(`── Active rules (${active.length}) ──`);
    for (const r of active) {
      lines.push(`  [${r.category}/${r.strength}] ${r.render_key} — ${r.policy}`);
      lines.push(`    source: ${r.source} | evidence: ${r.evidence_refs.length}`);
    }
  }

  if (suppressed.length > 0) {
    lines.push('');
    lines.push(`── Suppressed rules (${suppressed.length}) ──`);
    for (const r of suppressed) {
      lines.push(`  [${r.category}/${r.strength}] ${r.render_key} — ${r.policy}`);
    }
  }

  if (lines.length === 0) lines.push('No rules.');
  return lines.join('\n');
}

export function renderEvidence(evidence: Evidence[]): string {
  const corrections = evidence.filter(e => e.type === 'explicit_correction');
  const observations = evidence.filter(e => e.type === 'behavior_observation');
  const summaries = evidence.filter(e => e.type === 'session_summary');

  const lines: string[] = [];

  if (corrections.length > 0) {
    lines.push(`── Explicit corrections (${corrections.length}) ──`);
    for (const e of corrections.slice(0, 10)) {
      lines.push(`  ${e.timestamp.slice(0, 10)} [${e.confidence.toFixed(2)}] ${e.summary}`);
      if (e.candidate_rule_refs.length > 0) lines.push(`    → rules: ${e.candidate_rule_refs.join(', ')}`);
    }
  }

  if (observations.length > 0) {
    lines.push('');
    lines.push(`── Behavior observations (${observations.length}) ──`);
    for (const e of observations.slice(0, 10)) {
      lines.push(`  ${e.timestamp.slice(0, 10)} [${e.confidence.toFixed(2)}] ${e.summary}`);
    }
  }

  if (summaries.length > 0) {
    lines.push('');
    lines.push(`── Session summaries (${summaries.length}) ──`);
    for (const e of summaries.slice(0, 5)) {
      lines.push(`  ${e.timestamp.slice(0, 10)} [${e.confidence.toFixed(2)}] ${e.summary}`);
    }
  }

  if (lines.length === 0) lines.push('No evidence.');
  return lines.join('\n');
}

export function renderSession(state: SessionEffectiveState): string {
  initLocaleFromConfig();
  const l = getLocale();
  const lines: string[] = [
    `Session: ${state.session_id}`,
    `Quality: ${qualityName(state.quality_pack, l)} | Autonomy: ${autonomyName(state.autonomy_pack, l)} | Judgment: ${judgmentName(state.judgment_pack, l)} | Communication: ${communicationName(state.communication_pack, l)}`,
    `Runtime: ${state.runtime_capability_state.permission_mode} (detected from: ${state.runtime_capability_state.detected_from})`,
    `Effective trust: ${trustName(state.effective_trust_policy, l)}`,
  ];

  if (state.warnings.length > 0) {
    lines.push(`Warnings: ${state.warnings.join('; ')}`);
  }

  if (state.temporary_overlays.length > 0) {
    lines.push(`Temporary overlays: ${state.temporary_overlays.length}`);
    for (const o of state.temporary_overlays) {
      lines.push(`  - ${o.render_key}: ${o.policy}`);
    }
  }

  lines.push(`Active rules: ${state.active_rule_ids.length}`);
  lines.push(`Started: ${state.started_at}${state.ended_at ? ` | Ended: ${state.ended_at}` : ' (active)'}`);

  return lines.join('\n');
}
