/**
 * Forgen — Enforce Classifier (ADR-001 §Migration)
 *
 * 기존 Rule 에 `enforce_via: EnforceSpec[]` 이 없을 때, trigger/policy 자연어
 * 패턴과 strength 조합으로 mech(A/B/C) 와 hook 을 자동 제안한다.
 *
 * 휴리스틱 (ADR-001 §Migration heuristics):
 *   - trigger/policy 에 `rm|force|DROP|credentials|\.env` → Mech-A PreToolUse + tool_arg_regex
 *   - trigger/policy 에 `완료|complete|done|e2e|mock|verify` → Mech-A Stop + artifact_check
 *   - strength ∈ {strong, hard} + 문체/응답 맥락 → Mech-B UserPromptSubmit + self_check_prompt
 *   - 그 외 soft/default → Mech-C (drift 측정)
 *
 * 설계 원칙:
 *   - pure: classify(rule) 는 부수효과 없음. CLI 에서만 save 가 발생.
 *   - 미리 존재하는 enforce_via 는 덮어쓰지 않음 (`force=false` 기본).
 *   - 신규 제안은 reason 주석(문자열) 과 함께 반환해 사용자 리뷰 가능.
 */

import type { Rule, EnforceSpec } from '../store/types.js';

export interface EnforceProposal {
  rule_id: string;
  trigger_preview: string;
  current_enforce_via: EnforceSpec[] | null;
  proposed: EnforceSpec[];
  reasoning: string[];
}

const DESTRUCTIVE_PATTERN = /\b(rm\s+-rf|rm\s+-fr|force|DROP\s+TABLE|credentials|\.env|sudo|mkfs|dd\s+if=)/i;
const COMPLETION_PATTERN = /(완료|complete|done|ready|shipped|finished|e2e|mock|verify|검증|배포)/i;
const STYLE_PATTERN = /(문체|응답|설명|톤|어투|장황|간결|verbose|tone|style)/i;

// R6-F2: shared single source of truth — stop-guard 와 동일 regex 재사용.
import {
  DEFAULT_STOP_TRIGGER_RE as STOP_COMPLETION_TRIGGER,
  DEFAULT_STOP_EXCLUDE_RE as STOP_COMPLETION_EXCLUDE,
  MOCK_TRIGGER_RE as STOP_MOCK_TRIGGER,
  MOCK_EXCLUDE_RE as STOP_MOCK_EXCLUDE,
} from '../hooks/shared/stop-triggers.js';

export function classify(rule: Rule): EnforceProposal {
  const reasoning: string[] = [];
  const proposed: EnforceSpec[] = [];
  const text = `${rule.trigger}\n${rule.policy}`;

  const isDestructive = DESTRUCTIVE_PATTERN.test(text);
  const isCompletion = COMPLETION_PATTERN.test(text);
  const isStyle = STYLE_PATTERN.test(text);
  const isStrong = rule.strength === 'strong' || rule.strength === 'hard';

  // Mech-A PreToolUse — 파괴적 명령 패턴.
  // 이전에는 DESTRUCTIVE_PATTERN.source 를 다시 .match() 하여 alternation 의 첫 리터럴
  // ("credentials") 만 반환하는 버그가 있었음. 이제 rule 텍스트에서 실제 매칭된 구문을
  // 뽑아 그 구문에 맞는 runtime regex 로 변환.
  if (isDestructive) {
    const matched = text.match(DESTRUCTIVE_PATTERN);
    const matchedLiteral = matched?.[0] ?? '';
    // 안전을 위해 매칭된 literal 을 공백 보존 + escape 해서 runtime regex 로 재구성.
    // 예: "rm -rf" → "rm\s+-rf" (공백 유연); "DROP TABLE" → "DROP\s+TABLE"; ".env" → "\.env"
    const pattern = matchedLiteral
      ? matchedLiteral
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape regex metachar
          .replace(/\s+/g, '\\s+') // 공백 하나 이상
      : 'rm\\s+-rf'; // fallback
    proposed.push({
      mech: 'A',
      hook: 'PreToolUse',
      verifier: {
        kind: 'tool_arg_regex',
        params: { pattern, requires_flag: 'user_confirmed' },
      },
      block_message: `${rule.rule_id.slice(0, 8)}: ${rule.policy.slice(0, 80)}`,
    });
    reasoning.push(`destructive literal "${matchedLiteral}" → Mech-A PreToolUse+tool_arg_regex ${pattern}`);
  }

  // Mech-A Stop — 완료 선언 + 증거 요구 (destructive 와 독립적으로 평가: 하나의 rule 이 둘 다 해당 가능)
  if (isCompletion) {
    const mockAsProof = /mock|stub|fake/i.test(text);
    // 증거 파일 경로는 v0.4.0 최종 구현에서 rule.policy 에서 추출; 지금은 default 사용
    proposed.push({
      mech: 'A',
      hook: 'Stop',
      verifier: {
        kind: 'artifact_check',
        params: { path: '.forgen/state/e2e-result.json', max_age_s: 3600 },
      },
      block_message: `${rule.rule_id.slice(0, 8)}: ${rule.policy.slice(0, 120)}`,
      trigger_keywords_regex: mockAsProof ? STOP_MOCK_TRIGGER : STOP_COMPLETION_TRIGGER,
      trigger_exclude_regex: mockAsProof ? STOP_MOCK_EXCLUDE : STOP_COMPLETION_EXCLUDE,
      system_tag: `rule:${rule.rule_id.slice(0, 8)} — ${mockAsProof ? 'no-mock-as-proof' : 'e2e-before-done'}`,
    });
    reasoning.push(mockAsProof
      ? 'completion + mock keyword → Mech-A Stop+artifact_check (mock trigger)'
      : 'completion keyword → Mech-A Stop+artifact_check (completion trigger)');
  }

  // Mech-B — 문체/응답 관련 또는 strong/hard 정책이지만 기계 판정 어려운 경우
  if ((isStyle || (isStrong && !isDestructive && !isCompletion))) {
    proposed.push({
      mech: 'B',
      hook: 'Stop',
      verifier: {
        kind: 'self_check_prompt',
        params: {
          question: `직전 응답이 다음 규칙을 위반했는지 자가점검하라: "${rule.policy.slice(0, 120)}". 위반 시 구체적 근거와 함께 수정해 재응답하라.`,
        },
      },
      trigger_keywords_regex: STOP_COMPLETION_TRIGGER,
      trigger_exclude_regex: STOP_COMPLETION_EXCLUDE,
      system_tag: `rule:${rule.rule_id.slice(0, 8)} — style-check`,
    });
    reasoning.push(
      isStyle ? 'style/tone keyword → Mech-B Stop+self_check_prompt' : 'strong/hard strength + non-mechanical → Mech-B Stop+self_check_prompt'
    );
  }

  // 잔여 — drift measure only (Mech-C)
  if (proposed.length === 0) {
    proposed.push({
      mech: 'C',
      hook: 'PostToolUse',
      drift_key: `rule.${rule.rule_id.slice(0, 8)}`,
    });
    reasoning.push('no direct enforcement pattern → Mech-C drift measurement');
  }

  return {
    rule_id: rule.rule_id,
    trigger_preview: rule.trigger.slice(0, 60),
    current_enforce_via: rule.enforce_via ?? null,
    proposed,
    reasoning,
  };
}

export function classifyAll(rules: Rule[]): EnforceProposal[] {
  return rules.map(classify);
}

/** 제안을 적용해 새 Rule 을 반환 (pure). 이미 enforce_via 가 있으면 force=false 에서 건너뜀. */
export function applyProposal(rule: Rule, proposal: EnforceProposal, options: { force?: boolean } = {}): Rule {
  if (rule.enforce_via && rule.enforce_via.length > 0 && !options.force) {
    return rule;
  }
  return {
    ...rule,
    enforce_via: proposal.proposed,
    updated_at: new Date().toISOString(),
  };
}
