/**
 * ADR-008 — rate-limit detection regex + reset 시각 파서 회귀 가드.
 *
 * Detection 패턴이 실제 메시지와 어긋나면 첫 실 트리거에서 회복 실패하므로,
 * fixture 기반으로 5 패턴 × 정상/엣지 케이스를 박제하여 향후 hotfix 시 의도치
 * 않은 회귀 차단.
 */
import { describe, it, expect } from 'vitest';
import {
  parseRateLimitResetAt,
  RATE_LIMIT_REGEX,
  TOKEN_LIMIT_REGEX,
} from '../src/hooks/context-guard.js';

const NOW_FIXED = Date.UTC(2026, 4, 15, 4, 0, 0); // 2026-05-15 04:00:00 UTC

describe('RATE_LIMIT_REGEX', () => {
  it.each([
    ['You have hit the rate limit.', true],
    ['5-hour limit reached. Try again later.', true],
    ['Weekly limit reached.', true],
    ['Usage limit exceeded for this account.', true],
    ['Quota exceeded.', true],
    ['rate-limit on tokens', true],
    ['random network error', false],
    ['conversation too long', false], // token-limit, not rate-limit
  ])('%s → %s', (msg, expected) => {
    expect(RATE_LIMIT_REGEX.test(msg)).toBe(expected);
  });
});

describe('TOKEN_LIMIT_REGEX (회귀 가드)', () => {
  it.each([
    ['context limit reached', true],
    ['token limit', true],
    ['conversation too long', true],
    ['rate limit', false], // 분리 보장
  ])('%s → %s', (msg, expected) => {
    expect(TOKEN_LIMIT_REGEX.test(msg)).toBe(expected);
  });
});

describe('parseRateLimitResetAt', () => {
  it('Pattern 1: ISO timestamp (available again at)', () => {
    const r = parseRateLimitResetAt('available again at 2026-05-15T08:00:00Z', NOW_FIXED);
    expect(r).toBe('2026-05-15T08:00:00.000Z');
  });

  it('Pattern 2a: Resets in Nh Mm', () => {
    const r = parseRateLimitResetAt('Resets in 4h 12m', NOW_FIXED);
    expect(r).toBe('2026-05-15T08:12:00.000Z');
  });

  it('Pattern 2b: Resets in Nm only', () => {
    const r = parseRateLimitResetAt('Resets in 30m', NOW_FIXED);
    expect(r).toBe('2026-05-15T04:30:00.000Z');
  });

  it('Pattern 2c: try again in N min', () => {
    const r = parseRateLimitResetAt('try again in 240 min', NOW_FIXED);
    expect(r).toBe('2026-05-15T08:00:00.000Z');
  });

  it('Pattern 3: Resets in N seconds', () => {
    const r = parseRateLimitResetAt('Try again in 18000 seconds', NOW_FIXED);
    expect(r).toBe('2026-05-15T09:00:00.000Z');
  });

  it('Pattern 4: Resets at HH:MM (UTC 가정)', () => {
    const r = parseRateLimitResetAt('Resets at 14:30 UTC', NOW_FIXED);
    expect(r).toBe('2026-05-15T14:30:00.000Z');
  });

  it('Pattern 4: Resets at HH:MM 이미 지난 시각이면 다음 날', () => {
    const r = parseRateLimitResetAt('Resets at 02:00 UTC', NOW_FIXED);
    expect(r).toBe('2026-05-16T02:00:00.000Z');
  });

  it('알려진 한계: TZ 무시 (PST → UTC 로 처리)', () => {
    // ADR-008 §2 명시 한계 — 첫 실 트리거 후 hotfix 예정
    const r = parseRateLimitResetAt('Resets at 14:30 PST', NOW_FIXED);
    expect(r).toBe('2026-05-15T14:30:00.000Z'); // PST 가 무시됨
  });

  it('weekly: Reset on <ISO>', () => {
    const r = parseRateLimitResetAt('weekly limit reached. Reset on 2026-05-21T00:00:00Z', NOW_FIXED);
    expect(r).toBe('2026-05-21T00:00:00.000Z');
  });

  it('파싱 실패 시 null', () => {
    expect(parseRateLimitResetAt('Random error message', NOW_FIXED)).toBeNull();
    expect(parseRateLimitResetAt('rate limit reached', NOW_FIXED)).toBeNull(); // 매칭은 되나 시각 정보 없음
  });
});
