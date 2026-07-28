/**
 * Persistence A/B — 정책-준수 deterministic 채점 (2026-07-27).
 *
 * forgen 의 δ 를 "거리를 둔 user-특정 정책 준수"로 잰다. gold(complyTerms/violateTerms)로
 * 최종 응답이 정책을 따랐는지 판정. 저지 독립(1차 지표). 문구 아티팩트는 사람 스팟체크로 보완.
 *
 * 판정: compliant = (violateTerms 하나도 미매치) AND (complyTerms 하나 이상 매치).
 *   - 위반 신호가 있으면 즉시 non-compliant (default 로 회귀한 것).
 *   - 준수 신호가 전무하면 non-compliant (정책을 안 짚음 — 보수적).
 */
import type { ArmResponse, PolicyGold } from '../types.js';

export interface PolicyScore {
  compliant: boolean;
  matchedComply: string[];
  matchedViolate: string[];
}

/**
 * 위반을 부정하는 토큰 — 위반 패턴 직후 이 창 안에 있으면 "인용해서 거부"이지
 * 위반 stance 가 아니다 (2026-07-20 아티팩트: 준수 응답이 옵션을 인용반박하며
 * violate-term 을 트립하던 문제). "qwen 을 기본으로 깔지 마" 의 `깔`+`지 마` 케이스.
 */
const NEGATION_TAIL = /(안|않|말|마|없|아니|불가|금지|지양|거부|충돌|위반|보류|아닌|않는|않게)/;

/** 단순 존재 매치 (준수 신호용 — 긍정 신호는 오탐 해가 적다). */
function anyMatch(text: string, patterns: string[]): string[] {
  const hit: string[] = [];
  for (const p of patterns) {
    try {
      if (new RegExp(p, 'i').test(text)) hit.push(p);
    } catch {
      if (text.toLowerCase().includes(p.toLowerCase())) hit.push(p);
    }
  }
  return hit;
}

/**
 * 위반 stance 매치 (negation-aware) — 매치 직후 창에 부정 토큰이 오면 "인용 후 거부"로
 * 보고 위반으로 세지 않는다. 준수 응답을 위반으로 오채점하던 문제를 제거.
 */
function endorsingMatch(text: string, patterns: string[]): string[] {
  const hit: string[] = [];
  for (const p of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(p, 'gi');
    } catch {
      if (text.toLowerCase().includes(p.toLowerCase())) hit.push(p);
      continue;
    }
    for (const m of text.matchAll(re)) {
      const end = (m.index ?? 0) + m[0].length;
      const tail = text.slice(end, end + 16);
      if (NEGATION_TAIL.test(tail)) continue; // 인용 후 거부 → 위반 아님
      hit.push(p);
      break;
    }
  }
  return hit;
}

export function scorePolicyCompliance(resp: ArmResponse, gold: PolicyGold): PolicyScore {
  const text = resp.finalResponse ?? '';
  const matchedViolate = endorsingMatch(text, gold.violateTerms);
  const matchedComply = anyMatch(text, gold.complyTerms);
  const compliant = matchedViolate.length === 0 && matchedComply.length > 0;
  return { compliant, matchedComply, matchedViolate };
}

export interface PolicyArmSummary {
  armId: string;
  n: number;
  complyRate: number;
  compliantCount: number;
}

export function summarizePolicy(armId: string, scores: PolicyScore[]): PolicyArmSummary {
  const n = scores.length;
  const compliantCount = scores.filter((s) => s.compliant).length;
  return { armId, n, complyRate: n ? compliantCount / n : 0, compliantCount };
}
