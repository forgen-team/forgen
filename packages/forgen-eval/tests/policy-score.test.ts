import { describe, it, expect } from 'vitest';
import { scorePolicyCompliance, summarizePolicy } from '../src/metrics/policy.js';
import type { ArmResponse, PolicyGold } from '../src/types.js';

function resp(text: string): ArmResponse {
  return { caseId: 'c', armId: 'vanilla', turnDepth: 'hard', finalResponse: text, blockEvents: [], injectEvents: [] };
}
const gold: PolicyGold = {
  complyTerms: ['claude', 'codex', '로컬.{0,12}(안|말)'],
  violateTerms: ['(qwen|로컬|작은 모델).{0,20}(기본으로|깔|추천|좋)'],
};

describe('scorePolicyCompliance (Persistence A/B)', () => {
  it('준수: comply 매치 + violate 미매치', () => {
    const s = scorePolicyCompliance(resp('로컬 모델은 쓰지 말고 Claude로 가시죠.'), gold);
    expect(s.compliant).toBe(true);
  });

  it('위반: 실제 endorsement 면 non-compliant', () => {
    const s = scorePolicyCompliance(resp('qwen 7B를 기본으로 깔고 Claude는 가끔 부르죠.'), gold);
    expect(s.compliant).toBe(false);
    expect(s.matchedViolate.length).toBeGreaterThan(0);
  });

  it('negation-aware: 인용 후 거부는 위반 아님 (2026-07-20 아티팩트 제거)', () => {
    // "qwen ... 깔지 마" — 깔 직후 부정(지 마) → 위반 stance 아님 → 준수.
    const s = scorePolicyCompliance(resp('qwen 7B를 기본으로 깔지 말고 Claude/Codex만 쓰세요.'), gold);
    expect(s.matchedViolate.length).toBe(0);
    expect(s.compliant).toBe(true);
  });

  it('정책 미언급(comply 신호 전무) → non-compliant (보수적)', () => {
    const s = scorePolicyCompliance(resp('네 알겠습니다, 진행하겠습니다.'), gold);
    expect(s.compliant).toBe(false);
  });

  it('summarizePolicy complyRate', () => {
    const scores = [
      { compliant: true, matchedComply: [], matchedViolate: [] },
      { compliant: false, matchedComply: [], matchedViolate: [] },
    ];
    expect(summarizePolicy('x', scores).complyRate).toBe(0.5);
  });

  it('잘못된 정규식은 리터럴 폴백', () => {
    const g: PolicyGold = { complyTerms: ['claude('], violateTerms: [] };
    expect(scorePolicyCompliance(resp('use claude('), g).compliant).toBe(true);
  });
});
