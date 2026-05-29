import { describe, it, expect } from 'vitest';
import { sanitizeForGuard } from '../src/checks/_shared/text-sanitizer.js';
import { evaluateStop } from '../src/hooks/stop-guard.js';
import { checkDangerousResponsePattern } from '../src/checks/dangerous-response-pattern.js';

/**
 * ADR-009 §7 후속: 가드 거짓양성 감소 (인용/코드/메타 맥락) — 단,
 * 진짜 탐지(TP)는 보존하고 안전 가드는 약화하지 않는다.
 */

describe('sanitizeForGuard — referential quote stripping', () => {
  it('strips short tokens in curly double quotes', () => {
    expect(sanitizeForGuard('the word “verified” appears').includes('verified')).toBe(false);
  });
  it('strips short tokens in curly single quotes', () => {
    expect(sanitizeForGuard('‘done’ was cited').includes('done')).toBe(false);
  });
  it('strips short tokens in Korean quotes', () => {
    expect(sanitizeForGuard('｢passed｣ 는 예시').includes('passed')).toBe(false);
  });
  it('preserves long quotes (likely user/fact citation)', () => {
    const long = '“this is a long verified factual citation that should remain”';
    expect(sanitizeForGuard(long).includes('verified')).toBe(true);
  });
  it('preserves natural-prose tokens (no quotes) — TP must survive', () => {
    expect(sanitizeForGuard('the build is verified and done').includes('verified')).toBe(true);
  });
  it('is idempotent', () => {
    const once = sanitizeForGuard('“x” `y` "z"');
    expect(sanitizeForGuard(once)).toBe(once);
  });
});

// 룰-스토어 트리거가 sanitize 경유로 매칭되는지 (referential 미발화 / 자연주장 발화)
const RULE = {
  id: 'TEST-FP-RULE',
  mech: 'B' as const,
  hook: 'Stop' as const,
  trigger: { response_keywords_regex: 'completiontoken', context_exclude_regex: undefined as unknown as string },
  verifier: { kind: 'self_check_prompt' as const, params: {} }, // no evidence → violated when triggered
  block_message: 'self-check',
};

describe('messageTriggersRule via evaluateStop — referential suppression', () => {
  it('does NOT trigger when keyword only appears inside backticks (referential)', () => {
    const r = evaluateStop('I mean the `completiontoken` keyword, as a referenced example.', [RULE]);
    expect(r.action).toBe('approve');
  });
  it('does NOT trigger when keyword only appears in a short curly quote', () => {
    const r = evaluateStop('the “completiontoken” word fired the guard', [RULE]);
    expect(r.action).toBe('approve');
  });
  it('STILL triggers on a natural-prose assertion (TP preserved)', () => {
    const r = evaluateStop('the task reached completiontoken without any measurement', [RULE]);
    expect(r.action).toBe('block');
  });
});

// 안전 가드(파괴적 명령) 는 약화되지 않았음을 박제 — backtick/인용 안의 실제 제안도 발화.
describe('dangerous-response-pattern — NOT weakened (safety FN guard)', () => {
  it('still fires when a destructive command is proposed inside backticks', () => {
    const r = checkDangerousResponsePattern({ text: 'You can run `rm -rf node_modules` to clean.' });
    expect(r.block).toBe(true);
  });
  it('still fires on a find -exec rm bypass in prose', () => {
    const r = checkDangerousResponsePattern({ text: "as a safe alternative, find . -type d -exec rm -r {} +" });
    expect(r.block).toBe(true);
  });
  it('does not fire on benign text', () => {
    expect(checkDangerousResponsePattern({ text: 'the tests pass and the build is clean' }).block).toBe(false);
  });
});
