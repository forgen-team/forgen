/**
 * 룰 탐지 가능성 (D12-C) — "이 룰이 위반을 실제로 알아낼 수 있는가".
 *
 * 문제(R5): 활성 룰 18개 중 8개는 `drift_key` 만 있어 아무것도 하지 않았고, "구현 먼저 금지" 같은 평문 지시는
 * 코드가 위반을 판정할 수 없는데도 "위반 0" 을 근거로 B→A 승급됐다. `adherence_rate: 1` 은 준수의 증거가 아니라
 * 탐지 불능의 결과였다. 위반 0 이 준수를 뜻하려면 (1) 탐지기가 있고 (2) 실제로 평가돼 통과한 기록이 있어야 한다.
 *
 *  - detectable : 결정적 탐지기가 있다 — tool_arg_regex(패턴), artifact_check, tool_evidence, language_ratio,
 *                 evidence_path 가 있는 self_check_prompt(증거 파일로 판정).
 *  - advisory   : 그 외(자문). self_check_prompt 는 트리거되면 모델에게 되묻기만 할 뿐 위반 여부를 판정하지 못한다.
 *                 drift_key 만 있는 spec, enforce_via 없음도 여기.
 */
import type { Rule, EnforceSpec } from '../store/types.js';

export type Enforceability = 'detectable' | 'advisory';

function specDetectable(spec: EnforceSpec): boolean {
  const v = spec.verifier;
  if (!v) return false; // drift_key 만 있는 spec
  switch (v.kind) {
    case 'tool_arg_regex': return String(v.params?.pattern ?? '').length > 0;
    case 'artifact_check': return String(v.params?.path ?? '').length > 0;
    case 'tool_evidence':
    case 'language_ratio': return true;
    case 'self_check_prompt': return typeof v.params?.evidence_path === 'string' && v.params.evidence_path.length > 0;
    default: return false;
  }
}

/**
 * 옛 분류기는 본문에 없는 증거 파일(e2e-result.json 등)을 게이트로 붙였다. 그런 게이트는 어떤 사용자에게든
 * 모든 완료 보고를 막으므로 평가하지 않는다. 룰 파일을 고치는 마이그레이션 없이 모든 설치에 적용된다.
 */
export function artifactGateIsStale(rule: Pick<Rule, 'policy' | 'trigger'>, spec: EnforceSpec): boolean {
  if (spec.verifier?.kind !== 'artifact_check') return false;
  const file = String(spec.verifier.params?.path ?? '').split(/[\\/]/).pop() ?? '';
  // 디렉터리·패턴처럼 구체적 파일명이 아니면 판정할 근거가 없다. 차단을 풀지 않는다.
  if (!file || /[*?[\]{}]/.test(file)) return false;
  return !`${rule.trigger ?? ''}\n${rule.policy}`.includes(file);
}

export function enforceability(rule: Pick<Rule, 'enforce_via'>): Enforceability {
  return (rule.enforce_via ?? []).some(specDetectable) ? 'detectable' : 'advisory';
}

/**
 * 의미 룰 차단 정책 (2026-11-05 오너 결정): 키워드로 발동하는 self_check 는 실데이터 정밀도가 약 0.10 이라
 * 기본은 주입과 기록만 한다. 차단은 (1) 사용자가 `forgen rule enforce` 로 켠 룰(enforce_mode 'block'),
 * (2) 결정적 탐지기가 있는 spec, (3) hard 룰(ADR-002: advise 로 내릴 수 없음)에만 적용한다.
 * 명시 enforce_mode 가 항상 우선한다.
 */
export function effectiveEnforceMode(rule: Pick<Rule, 'enforce_mode' | 'strength'>, spec: EnforceSpec): 'block' | 'advise' {
  if (rule.enforce_mode) return rule.enforce_mode;
  if (rule.strength === 'hard' || specDetectable(spec)) return 'block';
  return 'advise';
}

/** 이 룰의 Stop spec 이 위반 시 실제로 차단하는가. Stop spec 이 없으면 false. */
export function stopBlocks(rule: Pick<Rule, 'enforce_mode' | 'strength' | 'enforce_via' | 'policy' | 'trigger'>): boolean {
  return (rule.enforce_via ?? []).some((s) => s.hook === 'Stop' && !!s.verifier && !artifactGateIsStale(rule, s) && effectiveEnforceMode(rule, s) === 'block');
}

/** 표시용: 위반 시 실제로 막는 룰인가. Stop 은 차단 정책을, 나머지 hook 은 결정적 탐지기와 advise 여부를 본다. */
export function ruleEnforced(rule: Pick<Rule, 'enforce_mode' | 'strength' | 'enforce_via' | 'policy' | 'trigger'>): boolean {
  return (rule.enforce_via ?? []).some((s) => {
    if (!s.verifier || artifactGateIsStale(rule, s)) return false;
    return s.hook === 'Stop' ? effectiveEnforceMode(rule, s) === 'block' : specDetectable(s) && rule.enforce_mode !== 'advise';
  });
}

/** 표시용 한 단어. */
export function enforceabilityLabel(rule: Pick<Rule, 'enforce_via'>): '탐지' | '자문' {
  return enforceability(rule) === 'detectable' ? '탐지' : '자문';
}

/**
 * 주제 게이트는 "의미를 코드가 못 읽는" self_check 에만 적용한다 — 결정적 탐지기(언어 비율·도구 증거 등)는 그대로.
 * communication 룰(답변 언어·형식·길이)은 모든 응답에 적용되는 문체 규칙이라 주제로 거르면 안 된다:
 * "영어로 답하지 말 것" 은 영어 응답(= 위반)에서 룰 용어가 하나도 안 나온다.
 */
export function topicGateApplies(kind: string, category?: string): boolean {
  return kind === 'self_check_prompt' && category !== 'communication';
}
