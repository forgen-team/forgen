/**
 * Forgen v1 — Rule Renderer
 *
 * Rule[] + SessionEffectiveState → Claude Code용 자연어 규칙 세트 변환.
 * Authoritative spec: docs/plans/2026-04-03-forgen-rule-renderer-spec.md
 *
 * 파이프라인: filter → dedupe(render_key) → group(category) → order → template → budget
 */

import type { Rule, RuleStrength, RuleScope, RuleSource, SessionEffectiveState, Profile, TrustPolicy, JudgmentPack, CommunicationPack } from '../store/types.js';
import { originTag } from '../store/rule-origin.js';
import { initLocaleFromConfig, getLocale, RULE_RENDERER } from '../i18n/index.js';

// ── Render Context ──

export type RenderSurface = 'session_start' | 'recompose' | 'inspect';

export interface RenderContext {
  surface: RenderSurface;
  max_rules: number;
  max_chars: number;
  include_pack_summary: boolean;
}

export const DEFAULT_CONTEXT: RenderContext = {
  surface: 'session_start',
  max_rules: 60,
  max_chars: 7000, // 룰 블록 상한 안쪽. 넘치면 우선순위로 고르고 빠진 룰을 표시한다.
  include_pack_summary: false,
};

// ── Output Sections ──

const SECTION_ORDER = ['Must Not', 'Working Defaults', 'When To Ask', 'How To Validate', 'How To Report'] as const;
type SectionName = typeof SECTION_ORDER[number];

const CATEGORY_TO_SECTION: Record<string, SectionName> = {
  safety: 'Must Not',
  quality: 'How To Validate',
  autonomy: 'When To Ask',
  judgment: 'Working Defaults',
  communication: 'How To Report',
  workflow: 'Working Defaults',
};

// ── Dedupe: render_key 충돌 해소 ──

const SCOPE_RANK: Record<RuleScope, number> = { session: 0, me: 1 };
export const STRENGTH_RANK: Record<RuleStrength, number> = { hard: 0, strong: 1, default: 2, soft: 3 };
const SOURCE_RANK: Record<RuleSource, number> = { explicit_correction: 0, onboarding: 1, behavior_inference: 2, pack_overlay: 3, imported: 2 };

/** 순위 비교(작을수록 먼저). 렌더러의 예산 우선순위·render_key 중복 제거와 forgen way 내보내기가 같은 기준을 쓴다. */
export interface RankKey { strength: RuleStrength; source: RuleSource; updated_at: string; id: string }
export function compareRank(a: RankKey, b: RankKey): number {
  return (STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength])
    || (SOURCE_RANK[a.source] - SOURCE_RANK[b.source])
    || b.updated_at.localeCompare(a.updated_at)
    || a.id.localeCompare(b.id);
}
export const rankKeyOf = (r: Rule): RankKey => ({ strength: r.strength, source: r.source, updated_at: r.updated_at, id: r.rule_id });

function dedupeByRenderKey(rules: Rule[]): Rule[] {
  const groups = new Map<string, Rule[]>();
  for (const r of rules) {
    const existing = groups.get(r.render_key) ?? [];
    existing.push(r);
    groups.set(r.render_key, existing);
  }

  const result: Rule[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    group.sort((a, b) => {
      const scopeDiff = SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope];
      if (scopeDiff !== 0) return scopeDiff;
      return compareRank(rankKeyOf(a), rankKeyOf(b));
    });
    result.push(group[0]);
  }
  return result;
}

// ── Template ──

function ruleToText(rule: Rule): string {
  // AI-optimized: [category|strength] 태그로 축약하여 토큰 절감
  // hard 강도는 태그 생략 (Must Not 섹션이 이미 의미를 전달)
  // ADR-017 D0: explicit 교정 룰엔 출처 날짜 꼬리표 — 사용자가 "내가 언제 말한 것" 을 식별.
  if (rule.strength === 'hard') return `${rule.policy}${originTag(rule)}`;
  const project = rule.projects?.length ? `|${rule.projects.join(',')}` : '';
  return `[${rule.category}|${rule.strength}${project}] ${rule.policy}${originTag(rule)}`;
}

function trustPolicySummary(policy: TrustPolicy): string {
  const s = RULE_RENDERER[getLocale()];
  switch (policy) {
    case '가드레일 우선': return s.trustGuardrails;
    case '승인 완화': return s.trustRelaxed;
    case '완전 신뢰 실행': return s.trustFullTrust;
  }
}

function judgmentPackRules(pack: JudgmentPack): string[] {
  const s = RULE_RENDERER[getLocale()];
  switch (pack) {
    case '최소변경형': return s.judgmentMinimalChange;
    case '구조적접근형': return s.judgmentStructural;
    case '균형형': return s.judgmentBalanced;
  }
}

function communicationPackRules(pack: CommunicationPack): string[] {
  const s = RULE_RENDERER[getLocale()];
  switch (pack) {
    case '간결형': return s.commConcise;
    case '상세형': return s.commDetailed;
    case '균형형': return s.commBalanced;
  }
}

// ── Facet-driven rules ──
// 4축 facet 값의 양 극단(≤0.15, ≥0.85)에서만 추가 규칙을 emit. 중간 값은
// pack 기본 규칙으로 충분하다고 본다 — 12-bucket pack lookup 위에 *연속 값
// 차별화*를 얇게 얹는 설계.
//
// Threshold 정당화: 0.5 가 default 이고 자동 갱신은 ±0.1 단위 (auto-compound-runner).
// 0.15/0.85 = 3 단계 강한 신호 누적 후에야 발화 → 노이즈에 둔감.

const FACET_HIGH = 0.85;
const FACET_LOW = 0.15;

export interface FacetRule {
  section: SectionName;
  rule: string;
}

export function facetDrivenRules(profile: Profile | null | undefined): FacetRule[] {
  const out: FacetRule[] = [];
  // 프로필이 없거나 축이 비어 있으면 생략(null 안전) — 렌더가 프로필 부재로 깨지면 안 된다.
  const q = profile?.axes?.quality_safety?.facets;
  const a = profile?.axes?.autonomy?.facets;
  const j = profile?.axes?.judgment_philosophy?.facets;
  const c = profile?.axes?.communication_style?.facets;
  if (!q || !a || !j || !c) return out;

  // Quality
  if (q.verification_depth >= FACET_HIGH) {
    out.push({ section: 'How To Validate', rule: '완료 선언 전 실행 로그 / 테스트 결과 / e2e 증거를 응답에 첨부' });
  }
  if (q.stop_threshold >= FACET_HIGH) {
    out.push({ section: 'Working Defaults', rule: '첫 실패 시 즉시 멈추고 진단 — 무진단 재시도 금지' });
  }
  if (q.change_conservatism >= FACET_HIGH) {
    out.push({ section: 'Working Defaults', rule: '의뢰 범위 외 리팩토링/일반화 금지 — 최소 diff 우선' });
  } else if (q.change_conservatism <= FACET_LOW) {
    out.push({ section: 'Working Defaults', rule: '명확성을 위한 리팩토링은 허용 — 디버그 중 발견된 인접 결함도 같은 PR 가능' });
  }

  // Autonomy
  if (a.confirmation_independence >= FACET_HIGH) {
    out.push({ section: 'When To Ask', rule: '목표 합의 후 단계별 재확인 생략 — 마무리 시점 한 번만 보고' });
  } else if (a.confirmation_independence <= FACET_LOW) {
    out.push({ section: 'When To Ask', rule: '비-사소한 단계마다 사용자 확인을 받고 진행' });
  }
  if (a.approval_threshold >= FACET_HIGH) {
    out.push({ section: 'When To Ask', rule: '비가역 작업(force push, 데이터 삭제, 외부 broadcast) 전 명시 승인 필수' });
  }

  // Judgment
  if (j.minimal_change_bias >= FACET_HIGH) {
    out.push({ section: 'Working Defaults', rule: '직면한 문제만 해결 — 인접 개선/추상화 제안은 별도 보고' });
  }
  if (j.abstraction_bias >= FACET_HIGH) {
    out.push({ section: 'Working Defaults', rule: '반복 패턴 발견 시 재사용 가능한 추상화로 통합 제안' });
  } else if (j.abstraction_bias <= FACET_LOW) {
    out.push({ section: 'Working Defaults', rule: '명확성을 해치는 추상화 금지 — 인라인 중복 허용' });
  }
  if (j.evidence_first_bias >= FACET_HIGH) {
    out.push({ section: 'How To Report', rule: '결론·가설 명시 전 근거(파일:라인, 로그, 측정값)를 먼저 표면화' });
  }

  // Communication
  if (c.verbosity <= FACET_LOW) {
    out.push({ section: 'How To Report', rule: '코드 표시가 필요하지 않으면 답변은 3문장 이내' });
  } else if (c.verbosity >= FACET_HIGH) {
    out.push({ section: 'How To Report', rule: '결정 배경·대안·tradeoff 를 답변에 포함' });
  }
  if (c.structure >= FACET_HIGH) {
    out.push({ section: 'How To Report', rule: '다중 포인트 답변은 헤더/표/리스트로 구조화' });
  }
  if (c.teaching_bias >= FACET_HIGH) {
    out.push({ section: 'How To Report', rule: 'why/how 를 함께 설명 — what 만 답하지 말 것' });
  }

  return out;
}

// ── Main Render ──

export interface RenderResult {
  text: string;
  /** 실제 본문에 들어간 룰. 주입 카운트는 이 목록만 올린다. */
  included: Rule[];
  /** 예산 초과로 빠진 룰. 조용히 사라지지 않게 본문과 상태 파일에 표시한다. */
  omitted: Rule[];
}

/** 예산이 모자랄 때 먼저 지키는 순서: hard → strong → 사용자 교정 → 최신. */
function byPriority(a: Rule, b: Rule): number {
  return compareRank(rankKeyOf(a), rankKeyOf(b));
}

export function renderRulesDetailed(
  rules: Rule[],
  state: SessionEffectiveState,
  profile: Profile | null | undefined,
  ctx: RenderContext = DEFAULT_CONTEXT,
): RenderResult {
  const deduped = dedupeByRenderKey(rules.filter((r) => r.status === 'active')).sort(byPriority);

  initLocaleFromConfig();
  const ecStrings = RULE_RENDERER[getLocale()];
  // 교정 기록 지시는 학습 루프의 입구다. 룰 예산과 무관하게 항상 앞쪽에 둔다.
  const evidenceBlock = [
    `## ${ecStrings.evidenceCollectionHeader}`,
    ...ecStrings.evidenceCollectionRules.map((r) => `- ${r}`),
  ].join('\n');
  const warningsBlock = state.warnings.length > 0
    ? `## Warnings\n${state.warnings.map((w) => `- ${w}`).join('\n')}`
    : '';

  const sections = new Map<SectionName, string[]>();
  for (const name of SECTION_ORDER) sections.set(name, []);

  // pack 요약은 룰보다 먼저 예산을 쓴다(켜져 있을 때만).
  if (ctx.include_pack_summary) {
    sections.get('Working Defaults')?.push(`Trust: ${trustPolicySummary(state.effective_trust_policy)}`);
    for (const rule of judgmentPackRules(state.judgment_pack)) sections.get('Working Defaults')?.push(rule);
    for (const rule of communicationPackRules(state.communication_pack)) sections.get('How To Report')?.push(rule);
  }

  const OMITTED_NOTE_RESERVE = 120;
  const headerChars = SECTION_ORDER.reduce((n, name) => n + name.length + 6, 0);
  let used = evidenceBlock.length + warningsBlock.length + headerChars + OMITTED_NOTE_RESERVE;
  for (const items of sections.values()) for (const item of items) used += item.length + 3;

  const included: Rule[] = [];
  const omitted: Rule[] = [];
  for (const rule of deduped) {
    const text = ruleToText(rule);
    if (used + text.length + 3 > ctx.max_chars || included.length >= ctx.max_rules) {
      omitted.push(rule);
      continue;
    }
    used += text.length + 3;
    included.push(rule);
    const section: SectionName = rule.strength === 'hard'
      ? 'Must Not'
      : (CATEGORY_TO_SECTION[rule.category] ?? 'Working Defaults');
    sections.get(section)?.push(text);
  }

  // R8: 4축 프로필을 렌더에 연결한다. 이전에는 `include_pack_summary`(항상 false) 뒤에 있어 facet 값을 바꿔도
  // 주입본이 같았다. 0.85/0.15 를 넘는 facet 의 규칙만 넣고, 룰이 예산을 다 쓴 뒤 남는 자리에만 들어간다(예산 최하위).
  // 임계값 근거: 기본 0.5, 자동 갱신 ±0.1 단위 → 극단값은 여러 세션의 강한 신호가 누적된 뒤에만 도달한다.
  let facetOmitted = 0;
  for (const fr of facetDrivenRules(profile)) {
    const text = `[profile] ${fr.rule}`;
    if (used + text.length + 3 > ctx.max_chars) { facetOmitted++; continue; }
    used += text.length + 3;
    sections.get(fr.section)?.push(text);
  }

  const parts: string[] = [];
  const mustNot = sections.get('Must Not') ?? [];
  if (mustNot.length > 0) parts.push(`## Must Not\n${mustNot.map((i) => `- ${i}`).join('\n')}`);
  parts.push(evidenceBlock);
  for (const name of SECTION_ORDER) {
    if (name === 'Must Not') continue;
    const items = sections.get(name) ?? [];
    if (items.length > 0) parts.push(`## ${name}\n${items.map((i) => `- ${i}`).join('\n')}`);
  }
  if (omitted.length > 0 || facetOmitted > 0) {
    parts.push(`## Omitted\n- ${omitted.length} lower-priority rules${facetOmitted ? ` and ${facetOmitted} profile rules` : ''} omitted (budget). List: forgen rule list`);
  }
  if (warningsBlock) parts.push(warningsBlock);

  return { text: parts.join('\n\n'), included, omitted };
}

export function renderRules(
  rules: Rule[],
  state: SessionEffectiveState,
  profile: Profile | null | undefined,
  ctx: RenderContext = DEFAULT_CONTEXT,
): string {
  return renderRulesDetailed(rules, state, profile, ctx).text;
}
