import { describe, it, expect } from 'vitest';
import { BLOCKING_ALLOWLIST, canBlock, requiresPolicyDoc } from '../src/hooks/shared/blocking-allowlist.js';

describe('Blocking ALLOW-LIST (P3\')', () => {
  it('현재 정책 — 4개 hook 만 block 권한', () => {
    expect(BLOCKING_ALLOWLIST.size).toBe(4);
    expect(canBlock('stop-guard')).toBe(true);
    expect(canBlock('pre-tool-use')).toBe(true);
    expect(canBlock('secret-filter')).toBe(true);
    expect(canBlock('db-guard')).toBe(true);
  });

  it('ALLOW-LIST 외 hook 은 block 권한 없음 (관찰 신호로 강등 대상)', () => {
    expect(canBlock('intent-classifier')).toBe(false);
    expect(canBlock('keyword-detector')).toBe(false);
    expect(canBlock('slop-detector')).toBe(false);
    expect(canBlock('mismatch-detector')).toBe(false);
    expect(canBlock('legacy-detector')).toBe(false);
    expect(canBlock('plugin-detector')).toBe(false);
    expect(canBlock('runtime-detector')).toBe(false);
  });

  it('새 hook 은 정책 문서 필수 — requiresPolicyDoc=true', () => {
    expect(requiresPolicyDoc('forge-loop-progress')).toBe(true);
    expect(requiresPolicyDoc('new-experimental-hook')).toBe(true);
  });

  it('ALLOW-LIST 에 추가된 hook 은 정책 문서 면제', () => {
    expect(requiresPolicyDoc('stop-guard')).toBe(false);
    expect(requiresPolicyDoc('db-guard')).toBe(false);
  });

  it('정책 invariant — ALLOW-LIST 변경 시 review 트리거', () => {
    // 본 테스트가 깨지면 ALLOW-LIST 가 의도 없이 변경된 것.
    // 의도된 변경이라면 본 expected 값을 함께 갱신 (commit diff 가 review 필수).
    expect([...BLOCKING_ALLOWLIST].sort()).toEqual([
      'db-guard',
      'pre-tool-use',
      'secret-filter',
      'stop-guard',
    ]);
  });
});
