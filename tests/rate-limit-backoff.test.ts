/**
 * ADR-008 §3 — exponential backoff schedule for rate-limit when resetAt 파싱 실패.
 * 1m → 5m → 15m → 30m → 1h → 2h cap (idx ≥ 5 동일).
 *
 * 합산 ≤ 6h hard cap 보장 (MAX_RESUMES_RATE=10 이지만 backoff 자체는 schedule 끝).
 */
import { describe, it, expect } from 'vitest';
import { rateLimitBackoffMs } from '../src/core/spawn.js';

describe('rateLimitBackoffMs', () => {
  it.each([
    [0, 60_000],          // 1m
    [1, 5 * 60_000],      // 5m
    [2, 15 * 60_000],     // 15m
    [3, 30 * 60_000],     // 30m
    [4, 60 * 60_000],     // 1h
    [5, 2 * 60 * 60_000], // 2h cap
    [6, 2 * 60 * 60_000], // cap 유지
    [10, 2 * 60 * 60_000],
  ])('attempt %d → %d ms', (attempt, expected) => {
    expect(rateLimitBackoffMs(attempt)).toBe(expected);
  });

  it('schedule 합 ≤ 6h hard cap (첫 6 시도)', () => {
    let total = 0;
    for (let i = 0; i < 6; i++) total += rateLimitBackoffMs(i);
    expect(total).toBeLessThanOrEqual(6 * 60 * 60_000);
  });
});
