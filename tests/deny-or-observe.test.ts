/**
 * Invariant: P3' enforcement — denyOrObserve helper (2026-04-27)
 *
 * ALLOW-LIST 외 hook 의 deny 시도가 자동 강등되는지 검증. 본 helper 가
 * 향후 모든 detector/guard 의 단일 진입점이 되어 RC5 재발을 시스템 차단.
 */

import { describe, it, expect, vi } from 'vitest';
import { denyOrObserve } from '../src/hooks/shared/hook-response.js';

describe('Invariant: denyOrObserve (P3\')', () => {
  it('ALLOW-LIST 멤버 (stop-guard) → 진짜 deny', () => {
    const result = denyOrObserve('stop-guard', 'incomplete evidence');
    const parsed = JSON.parse(result);
    expect(parsed.continue).toBe(false);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('ALLOW-LIST 멤버 (db-guard) → 진짜 deny', () => {
    const parsed = JSON.parse(denyOrObserve('db-guard', 'DROP TABLE detected'));
    expect(parsed.continue).toBe(false);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('ALLOW-LIST 외 (intent-classifier) → approve + observer 호출', () => {
    const observed: string[] = [];
    const result = denyOrObserve('intent-classifier', 'unknown intent', (msg) => observed.push(msg));
    const parsed = JSON.parse(result);
    expect(parsed.continue).toBe(true);
    // approve() 응답은 hookSpecificOutput 키 자체가 없거나 deny 가 아님
    expect(parsed.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(observed.length).toBe(1);
    expect(observed[0]).toContain('intent-classifier');
    expect(observed[0]).toContain('would-deny');
    expect(observed[0]).toContain('unknown intent');
  });

  it('ALLOW-LIST 외 + observer 없음 → approve, 호출 없음', () => {
    const result = denyOrObserve('keyword-detector', 'noisy match');
    const parsed = JSON.parse(result);
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it('observer 가 throw 해도 fail-open (approve 유지)', () => {
    const result = denyOrObserve('slop-detector', 'reason', () => { throw new Error('observer crash'); });
    const parsed = JSON.parse(result);
    expect(parsed.continue).toBe(true);
  });

  it('새 hook (forge-loop-progress) → approve 강등 (ALLOW-LIST 외)', () => {
    // 본 세션에 추가된 forge-loop-progress 가 deny 권한을 갖지 않는지 검증
    const result = denyOrObserve('forge-loop-progress', 'should not block');
    const parsed = JSON.parse(result);
    expect(parsed.continue).toBe(true);
  });
});
