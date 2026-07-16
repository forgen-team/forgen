/**
 * Meta-guard dispatcher — TEST-1/2/3 + DANGEROUS 빌트인 가드의 단일 평가 지점.
 *
 * ADR-009 §2a: 기존 stop-guard.main() 안에 인라인돼 있던 checks[] + for-loop 를
 * 순수 함수로 추출한다. 목적은 동일 로직을 `Stop`(메인 응답) 과 `SubagentStop`
 * (워크플로우/Task subagent 응답) 두 hook 에서 공유하기 위함이다 (probe 실측:
 * 워크플로우 내부 에이전트도 forgen 훅을 발화 → subagent 산출물도 검증 대상).
 *
 * 순수성: IO/부수효과 없음. recordViolation·blockStop·override 분기는 호출자가
 * 담당한다 (hook 별로 다름). 평가 순서·sanitize 적용·dangerous 의 raw 입력 사용은
 * 추출 전 stop-guard 동작과 정확히 동일하게 보존한다 (회귀 테스트로 박제).
 */

import { checkConclusionVerificationRatio } from '../conclusion-verification-ratio.js';
import { checkSelfScoreInflation } from '../self-score-deflation.js';
import { checkFactVsAgreement } from '../fact-vs-agreement.js';
import { checkDangerousResponsePattern } from '../dangerous-response-pattern.js';
import { sanitizeForGuard } from './text-sanitizer.js';

export interface MetaGuardContext {
  /** 평가 대상 응답 원문 (dangerous-pattern 은 코드펜스 보존 위해 raw 사용). */
  lastMessage: string;
  /** 최근 tool 이름 윈도우 (TEST-1/2 의 "측정 도구 호출 수" 계산). */
  recentTools: string[];
  /** TEST-1 fact-vs-agreement 최소 측정 횟수 (기본 1). */
  minMeasurements?: number;
  /**
   * W4-3 (ADR-010): 완료 가드(TEST-1/2/3)의 동작 모드. 'advise' 면 block 을
   * correction(기록만)으로 강등한다 — 측정된 프론티어 모델(opus-4.8 blocks=0)
   * 에서 잔여 발화는 거짓양성 개연성이 높으므로. DANGEROUS-RESPONSE 는 모델
   * 무관 안전장치라 이 모드의 영향을 받지 않는다. 기본 'block' (현행 유지).
   */
  completionGuardMode?: 'block' | 'advise';
}

export interface MetaGuardResult {
  /** 짧은 식별자 (builtin:<shortId> 형태의 rule_id 와 reason prefix 에 사용). */
  shortId: string;
  /** 사람-읽기 rule slug (systemMessage 보조). */
  ruleSlug: string;
  /** block = 세션 재개 강제, correction = 기록만 (alert-level). */
  kind: 'block' | 'correction';
  reason: string;
}

/**
 * 트리거된 가드를 평가 순서대로 반환한다. **첫 block 까지** 평가 후 중단한다
 * (추출 전 for-loop 가 첫 block 에서 return 하던 laziness 보존 — block 이후 가드는
 * 어차피 기록되지 않으므로 평가하지 않는다).
 *
 * 평가 순서: DANGEROUS-RESPONSE(즉시 차단·안전 우선) → TEST-2(self-score, 강한 신호)
 *            → TEST-3(conclusion/verification 비율) → TEST-1(fact-vs-agreement, alert-only).
 */
export function runMetaGuards(ctx: MetaGuardContext): MetaGuardResult[] {
  const sanitized = sanitizeForGuard(ctx.lastMessage);
  const recentTools = ctx.recentTools;
  const minMeasurements = ctx.minMeasurements ?? 1;

  type Check = { shortId: string; ruleSlug: string; kind: 'block' | 'correction'; run: () => { triggered: boolean; reason: string } };
  const checks: Check[] = [
    {
      shortId: 'dangerous-response-pattern',
      ruleSlug: 'rule:DANGEROUS-RESPONSE — destructive command suggestion',
      kind: 'block',
      // 주의: sanitizer 가 백틱/코드블록을 제거하므로 raw lastMessage 를 전달.
      // 위험 명령은 코드 fence 안에 있어도 동등하게 위험함.
      run: () => {
        const r = checkDangerousResponsePattern({ text: ctx.lastMessage });
        return { triggered: r.block, reason: r.reason };
      },
    },
    {
      shortId: 'self-score-inflation',
      ruleSlug: 'rule:TEST-2 — self-score inflation',
      kind: 'block',
      run: () => {
        const r = checkSelfScoreInflation({ text: sanitized, recentTools });
        return { triggered: r.block, reason: r.reason };
      },
    },
    {
      shortId: 'conclusion-ratio',
      ruleSlug: 'rule:TEST-3 — conclusion/verification ratio',
      kind: 'block',
      run: () => {
        const r = checkConclusionVerificationRatio({ text: sanitized });
        return { triggered: r.block, reason: r.reason };
      },
    },
    {
      shortId: 'fact-vs-agreement',
      ruleSlug: 'rule:TEST-1 — fact vs agreement',
      kind: 'correction', // alert-level only per fact-vs-agreement.ts design
      run: () => {
        const r = checkFactVsAgreement({ text: sanitized, recentTools, minMeasurements });
        return { triggered: r.alert, reason: r.reason };
      },
    },
  ];

  const results: MetaGuardResult[] = [];
  const adviseMode = ctx.completionGuardMode === 'advise';
  for (const c of checks) {
    const out = c.run();
    if (!out.triggered) continue;
    // W4-3: advise 모드에선 완료 가드(TEST-*)의 block 을 correction 으로 강등.
    // DANGEROUS 는 모델 무관 결정적 안전장치 — 강등 대상 아님.
    const effectiveKind: 'block' | 'correction' =
      adviseMode && c.kind === 'block' && c.shortId !== 'dangerous-response-pattern'
        ? 'correction'
        : c.kind;
    results.push({ shortId: c.shortId, ruleSlug: c.ruleSlug, kind: effectiveKind, reason: out.reason });
    // 원래 kind 기준으로 중단 (강등돼도 동일) — 리뷰 SEV-1: 강등 결과가 루프를
    // 계속 돌면 턴당 violation 기록이 2-3배로 불어나 lifecycle T2 트리거
    // (violations_30d>=3)를 조기 발화시키고 meta 승격을 영구 차단한다.
    // 기록 카디널리티는 block 모드와 정확히 동일하게 보존한다.
    if (c.kind === 'block') break;
  }
  return results;
}
