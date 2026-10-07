/**
 * Forgen — Enforce Classifier (ADR-001 §Migration)
 *
 * 기존 Rule 에 `enforce_via: EnforceSpec[]` 이 없을 때, trigger/policy 자연어
 * 패턴과 strength 조합으로 mech(A/B/C) 와 hook 을 자동 제안한다.
 *
 * 휴리스틱 (ADR-001 §Migration heuristics):
 *   - trigger/policy 에 `rm|force|DROP|credentials|\.env` → Mech-A PreToolUse + tool_arg_regex
 *   - trigger/policy 에 `완료|complete|done|e2e|mock|verify` + 명시적 증거 경로(*.json)
 *     → Mech-A Stop + artifact_check. 경로 미명시 → Mech-B self_check_prompt
 *     (무경로 디폴트 .forgen/state/e2e-result.json 은 e2e 게이트 폐지(ADR-010 W0) 후
 *     죽은 경로가 되어 완료 선언을 영구 차단하는 룰을 재생산했다 — 리뷰 발견)
 *   - strength ∈ {strong, hard} + 문체/응답 맥락 → Mech-B UserPromptSubmit + self_check_prompt
 *   - 그 외 soft/default → Mech-C (drift 측정)
 *
 * 설계 원칙:
 *   - pure: classify(rule) 는 부수효과 없음. CLI 에서만 save 가 발생.
 *   - 미리 존재하는 enforce_via 는 덮어쓰지 않음 (`force=false` 기본).
 *   - 신규 제안은 reason 주석(문자열) 과 함께 반환해 사용자 리뷰 가능.
 */

import type { Rule, EnforceSpec, VerifierSpec } from '../store/types.js';

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
/** rule 텍스트에 명시된 증거 파일 경로 (예: ~/.forgen/state/e2e-result.json). */
const ARTIFACT_PATH_PATTERN = /(?:~\/)?[\w.-]+(?:\/[\w.-]+)*\.json/;
/**
 * 폐지/완화 성격의 룰 감지 — "X를 더 이상 요구하지 않는다" 류 교정은 기존 게이트를
 * *해제*하는 룰인데, 텍스트에 완료 키워드+경로가 남아 있어 완료 게이트로 오분류됐다
 * (실사례: e2e 게이트 폐지 교정 룰이 폐지 대상 게이트를 스스로 강제).
 * 금지문("~하지 마라")이 함께 있으면 폐지가 아니라 강제 룰이다 — 금지문이 우선한다
 * (리뷰 #9: "완화 없이 검증 완료를 선언하지 마라"가 repeal 로 오탐되던 케이스).
 */
const REPEAL_PATTERN = /(더\s*이상.{0,60}(않는다|않음|안\s*한다)|폐지|완화|선택\s*사항|필요\s*없|optional|no\s+longer\s+require)/i;
const PROHIBITION_PATTERN = /(하지\s*마라|하지\s*말|말\s*것|금지)/;
/**
 * 증거 맥락 감지 — artifact_check 는 경로가 증거 아티팩트로 보일 때만 부착한다.
 * 부수적 .json 언급(package.json 버전 확인 등)에 게이트를 걸면 ~/.forgen 상대해석
 * 으로 파일이 영원히 부재 → 완료 영구 차단 (리뷰 #9 구성 실증).
 */
const EVIDENCE_CONTEXT_PATTERN = /(증거|evidence|검증\s*결과|e2e-result|smoke-report)/i;

// R6-F2: shared single source of truth — stop-guard 와 동일 regex 재사용.
import {
  DEFAULT_STOP_EXCLUDE_RE as STOP_COMPLETION_EXCLUDE,
  MOCK_EXCLUDE_RE as STOP_MOCK_EXCLUDE,
  CRITIC_STOP_EXCLUDE_RE,
  COMPLETION_TRIGGER_V2_RE,
  CRITIC_TRIGGER_V2_RE,
  CHUNK_EVIDENCE_RE,
  MOCK_CLAIM_TRIGGER_RE,
  LIVE_RUN_TRIGGER_RE,
  IMPL_REPORT_TRIGGER_RE,
  topicDropTrigger,
} from '../hooks/shared/stop-triggers.js';

const ISOLATION_PATTERN = /(격리|isolat|FORGEN_HOME|CLAUDE_CONFIG_DIR|docker).{0,80}(프로덕션|실\s?데이터|live|라이브|실제)|((프로덕션|실\s?데이터|live|라이브).{0,80}(격리|docker|FORGEN_HOME))/is;
const IMPL_FIRST_PATTERN = /(구현\s?먼저|구현을?\s?먼저|합의.{0,30}(문서|구현)|결정\s?문서|문서로\s?남긴\s?다음|문서화한\s?(후|뒤|다음))/;

/** 룰이 괄호 안에 ①·② 나 · 로 나열한 기능 이름 — 주제 룰 판별용 (예: "(①원·투모션·④슈터 유형·⑤대표 선수)"). */
export function extractTopicTerms(policy: string): string[] {
  // 번호(①~⑨)가 붙은 기능 나열만 주제로 본다 — '·' 만 있는 괄호(예: 오차 규약 통일·거리 스케일)는 절차 설명이라 제외.
  const m = policy.match(/\(([^()]*[①②③④⑤⑥⑦⑧⑨][^()]*)\)/);
  if (!m) return [];
  // 번호가 항목 경계 — "①원·투모션·④슈터 유형" 은 [원·투모션, 슈터 유형]. 항목 끝의 구분자만 벗긴다.
  return m[1].split(/[①-⑨]/).map((t) => t.replace(/^[\s·,]+|[\s·,]+$/g, '').trim()).filter((t) => t.length >= 2);
}

/** 트리거 정규식 상한(compileSafeRegex MAX_PATTERN_LEN=500)보다 여유 있게 — 넘으면 룰이 소리 없이 죽는다. */
const TOPIC_TRIGGER_MAX = 480;

/**
 * 2026-10-07: 활성 룰 중 Stop 설정이 있는 것만 현재 분류기로 다시 굽는다(다른 훅·강도·본문 불변).
 * 순수 계산 — 저장은 호출자가. 반환: 바뀐 룰과 새 Stop 설정.
 */
export function retuneStopSpecs(rules: Rule[]): Array<{ rule: Rule; newStop: NonNullable<Rule['enforce_via']> }> {
  const out: Array<{ rule: Rule; newStop: NonNullable<Rule['enforce_via']> }> = [];
  for (const rule of rules) {
    if (rule.status !== 'active' || !(rule.enforce_via ?? []).some((s) => s.hook === 'Stop')) continue;
    const newStop = classify(rule).proposed.filter((s) => s.hook === 'Stop') as NonNullable<Rule['enforce_via']>;
    if (newStop.length === 0) continue;
    const oldStop = (rule.enforce_via ?? []).filter((s) => s.hook === 'Stop');
    if (JSON.stringify(oldStop) !== JSON.stringify(newStop)) out.push({ rule, newStop });
  }
  return out;
}

/** 사용자 룰(~/.forgen/me/rules)에 retune 을 적용·저장. postinstall 1회 마이그레이션용. 반환: 바뀐 수. */
export async function applyStopRetuneToUserRules(): Promise<number> {
  const { loadAllRules, saveRule } = await import('../store/rule-store.js');
  const changes = retuneStopSpecs(loadAllRules());
  for (const { rule, newStop } of changes) {
    saveRule({ ...rule, enforce_via: [...(rule.enforce_via ?? []).filter((s) => s.hook !== 'Stop'), ...newStop] });
  }
  return changes.length;
}

/**
 * 발동 조건 종류에 맞는 판정 방식 — 분류기의 모든 Stop 분기가 이 하나를 쓴다(critic SEV-1: 분기마다 따로 고르다
 * language 트리거에 self_check 가 붙어 40자 이상 모든 답변을 차단하는 조합이 생겼다).
 */
export function stopVerifierFor(kind: StopTriggerChoice['kind'], policy: string): VerifierSpec {
  if (kind === 'critic') {
    return { kind: 'tool_evidence', params: { tools: 'Agent,Task,Workflow,mcp__forgen-compound__invoke-agent', window: 60, only_if: CHUNK_EVIDENCE_RE, question: `이 작업 청크에 대해 fresh-context 비판 리뷰(critic 에이전트)를 실제로 돌리지 않았다. 규칙: "${policy.slice(0, 100)}". critic 을 실행하고 발견 사항을 반영한 뒤 다시 보고하라.` } };
  }
  if (kind === 'language') {
    return { kind: 'language_ratio', params: { script: 'hangul', min_ratio: 0.5, question: `직전 응답이 한국어가 아니다(한글 비율 미달). 규칙: "${policy.slice(0, 80)}". 한국어로 다시 답하라.` } };
  }
  return { kind: 'self_check_prompt', params: { question: `직전 응답이 다음 규칙을 위반했는지 자가점검하라: "${policy.slice(0, 120)}". 위반 시 구체적 근거와 함께 수정해 재응답하라.` } };
}

export interface StopTriggerChoice { trigger: string; exclude: string; kind: 'mock' | 'critic' | 'live' | 'impl' | 'topic' | 'completion' | 'language'; }

const KOREAN_ONLY_PATTERN = /(한국어로|한글로).{0,30}(답|응답|작성|말)|영어로\s?답하지/;

/**
 * 2026-10-07 룰별 발동 조건 — 각 룰이 지키려는 **행동의 주장**에만 반응한다(30일 실측: 공통 완료 어휘는 1.4% 만 발동,
 * 걸리면 4개 룰이 동시에, mock 룰은 단어만으로 무한 반복). 우선순위: mock > critic > 주제 > 격리 > 구현먼저 > 완료.
 */
export function chooseStopTrigger(policy: string): StopTriggerChoice {
  if (/mock|stub|fake/i.test(policy)) return { trigger: MOCK_CLAIM_TRIGGER_RE, exclude: STOP_MOCK_EXCLUDE, kind: 'mock' };
  // 언어 룰: 모든 답변(40자 이상)을 한글 비율로 기계 판정 — 준수하면 조용히 통과하므로 넓게 걸어도 노이즈 없음.
  if (KOREAN_ONLY_PATTERN.test(policy)) return { trigger: '[\\s\\S]{40,}', exclude: '(?!)', kind: 'language' };
  if (CRITIC_REVIEW_PATTERN.test(policy)) return { trigger: CRITIC_TRIGGER_V2_RE, exclude: CRITIC_STOP_EXCLUDE_RE, kind: 'critic' };
  const topics = extractTopicTerms(policy);
  if (topics.length > 0) {
    // 상한을 넘으면 앞쪽 기능부터 남긴다(룰이 통째로 죽는 것보다 낫다).
    let n = topics.length;
    while (n > 1 && topicDropTrigger(topics.slice(0, n)).length > TOPIC_TRIGGER_MAX) n--;
    return { trigger: topicDropTrigger(topics.slice(0, n)), exclude: STOP_COMPLETION_EXCLUDE, kind: 'topic' };
  }
  if (ISOLATION_PATTERN.test(policy)) return { trigger: LIVE_RUN_TRIGGER_RE, exclude: STOP_COMPLETION_EXCLUDE, kind: 'live' };
  if (IMPL_FIRST_PATTERN.test(policy)) return { trigger: IMPL_REPORT_TRIGGER_RE, exclude: STOP_COMPLETION_EXCLUDE, kind: 'impl' };
  return { trigger: COMPLETION_TRIGGER_V2_RE, exclude: STOP_COMPLETION_EXCLUDE, kind: 'completion' };
}

/**
 * critic-review 룰 감지 (2026-07-22, 리뷰 SEV-2 #3): "비판 리뷰/critic 을 돌리고 다음으로
 * 넘어감" 정책만 skip-review 트리거를 받는다. e2e·mock 등 다른 완료룰은 DEFAULT(완료 전용)
 * 유지 → semantic 오염 방지.
 */
// 검토 동사목록을 리뷰와 대칭화(진행|수행|돌리 추가) — 리뷰 SEV-3 (b): "검토를 진행하라" 미탐 수정.
const CRITIC_REVIEW_PATTERN = /(비판\s*리뷰|fresh-context|critic|리뷰를?\s*(돌리|수행|진행|후)|검토를?\s*(하고|후|없이|생략|진행|수행|돌리))/i;

export function classify(rule: Rule): EnforceProposal {
  const reasoning: string[] = [];
  const proposed: EnforceSpec[] = [];

  // ADR-013 (critic 재검증 #2): 채굴 교정(behavior_inference)은 **data-level invariant** 로
  // advisory-only. classify 자체가 여기서 빈 proposal 을 반환하므로, promote 든
  // `forgen classify-enforce --apply` 든 어떤 경로로도 채굴 룰이 Mech-A 차단을 얻지 못한다.
  // (enforce_via=[] 를 "미분류"로 보고 재분류하던 CLI 우회 경로 근절.)
  if (rule.source === 'behavior_inference') {
    reasoning.push('behavior_inference (auto-mined) → advisory-only, no enforcement (ADR-013)');
    return {
      rule_id: rule.rule_id,
      trigger_preview: rule.trigger.slice(0, 60),
      current_enforce_via: rule.enforce_via ?? null,
      proposed: [],
      reasoning,
    };
  }

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

  // Mech-A Stop — 완료 선언 + 증거 요구 (destructive 와 독립적으로 평가: 하나의 rule 이 둘 다 해당 가능).
  // artifact_check 는 rule 텍스트가 증거 경로를 명시했을 때만 제안한다. 과거의 무경로
  // 디폴트(.forgen/state/e2e-result.json)는 e2e 게이트 폐지 후 죽은 경로가 되어,
  // "완료" 키워드가 있는 모든 신규 룰이 영구 차단 게이트를 물려받는 버그를 낳았다.
  let completionSelfCheck = false;
  const isRepeal = REPEAL_PATTERN.test(text) && !PROHIBITION_PATTERN.test(text);
  if (isRepeal && isCompletion) {
    reasoning.push('repeal/relaxation phrasing → 완료 게이트 제안 생략 (게이트 해제 룰이 게이트를 강제하는 오분류 방지)');
  }
  if (isCompletion && !isRepeal) {
    const mockAsProof = /mock|stub|fake/i.test(text);
    const choice = chooseStopTrigger(rule.policy);
    const stopTrigger = choice.trigger;
    const stopExclude = choice.exclude;
    const pathMatch = text.match(ARTIFACT_PATH_PATTERN)?.[0];
    // 증거로 보이는 경로만 게이트화: .forgen/ 하위이거나 텍스트에 증거 맥락어가 있을 때.
    const explicitArtifact = pathMatch && (pathMatch.includes('.forgen/') || EVIDENCE_CONTEXT_PATTERN.test(text))
      ? pathMatch : undefined;
    if (explicitArtifact) {
      proposed.push({
        mech: 'A',
        hook: 'Stop',
        verifier: {
          kind: 'artifact_check',
          // stop-guard 는 home 기준 상대경로로 평가 — `~/` 접두는 벗겨서 저장
          params: { path: explicitArtifact.replace(/^~\//, ''), max_age_s: 3600 },
        },
        block_message: `${rule.rule_id.slice(0, 8)}: ${rule.policy.slice(0, 120)}`,
        trigger_keywords_regex: stopTrigger,
        trigger_exclude_regex: stopExclude,
        system_tag: `rule:${rule.rule_id.slice(0, 8)} — ${mockAsProof ? 'no-mock-as-proof' : 'evidence-before-done'}`,
      });
      reasoning.push(`completion + explicit artifact "${explicitArtifact}" → Mech-A Stop+artifact_check`);
    } else {
      completionSelfCheck = true;
      proposed.push({
        mech: 'B',
        hook: 'Stop',
        // critic → 실행 증거, language → 한글 비율, 그 외 자가점검 (stopVerifierFor 단일 소스).
        verifier: stopVerifierFor(choice.kind, rule.policy),
        trigger_keywords_regex: stopTrigger,
        trigger_exclude_regex: stopExclude,
        system_tag: `rule:${rule.rule_id.slice(0, 8)} — completion-self-check`,
      });
      reasoning.push('completion keyword, no explicit artifact path → Mech-B Stop+self_check_prompt (dead e2e default removed)');
    }
  }

  // Mech-B — 문체/응답 관련 또는 strong/hard 정책이지만 기계 판정 어려운 경우.
  // completion self-check 를 이미 제안했다면 동일 훅에 중복 self-check 를 얹지 않는다.
  if (((isStyle && !completionSelfCheck) || (isStrong && !isDestructive && !isCompletion))) {
    proposed.push({
      mech: 'B',
      hook: 'Stop',
      // 2026-10-07: 문체 룰도 룰별 발동 조건(주제·격리·구현먼저·언어 등)과 그에 맞는 판정 방식을 쓴다. 해당 없으면 완료 선언.
      verifier: stopVerifierFor(chooseStopTrigger(rule.policy).kind, rule.policy),
      trigger_keywords_regex: chooseStopTrigger(rule.policy).trigger,
      trigger_exclude_regex: chooseStopTrigger(rule.policy).exclude,
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

/**
 * critic-review 룰인데 baked Stop 트리거가 skip-review 시그널을 안 가지는지 (리뷰 SEV-3 (c)).
 * true 면 `forgen rule classify --apply --force` 재-bake 로 갱신해야 갭이 닫힌다.
 * doctor nudge 용 — "고쳤는데 기존 유저에겐 안 닿는" 상태를 발견 가능하게 한다.
 */
export function needsCriticTriggerMigration(rule: Rule): boolean {
  const text = `${rule.trigger}\n${rule.policy}`;
  if (!CRITIC_REVIEW_PATTERN.test(text)) return false;
  const stopSpec = rule.enforce_via?.find((s) => s.hook === 'Stop');
  if (!stopSpec) return false;
  return !/생략|넘어가|스킵|패스/.test(stopSpec.trigger_keywords_regex ?? '');
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
