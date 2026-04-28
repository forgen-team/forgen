/**
 * execHost default timeout invariant — feat/codex-support Phase 3 deferred fix.
 *
 * 회귀 박제:
 *   - codex 60-90s tail latency 가 정상이라 30s default 는 false-positive ETIMEDOUT 유발.
 *   - 90s 마진 보장 + claude 와 codex 가 분리된 invariant.
 *
 * 실 CLI 호출은 단위 테스트 어려움 (network/auth 의존) → constant invariant 만 박제.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEOUT_BY_HOST } from '../../src/host/exec-host.js';

describe('DEFAULT_TIMEOUT_BY_HOST', () => {
  it('codex 기본 timeout 은 90s 이상 (60-90s tail latency 마진)', () => {
    expect(DEFAULT_TIMEOUT_BY_HOST.codex).toBeGreaterThanOrEqual(90_000);
  });

  it('claude 기본 timeout 은 30s 이하 (-p 는 보통 1-5s)', () => {
    expect(DEFAULT_TIMEOUT_BY_HOST.claude).toBeLessThanOrEqual(30_000);
  });

  it('codex timeout > claude timeout (host 별 분리 invariant)', () => {
    expect(DEFAULT_TIMEOUT_BY_HOST.codex).toBeGreaterThan(DEFAULT_TIMEOUT_BY_HOST.claude);
  });

  it('두 host 모두 명시 정의 — undefined 회귀 차단', () => {
    expect(DEFAULT_TIMEOUT_BY_HOST.claude).toBeDefined();
    expect(DEFAULT_TIMEOUT_BY_HOST.codex).toBeDefined();
    expect(typeof DEFAULT_TIMEOUT_BY_HOST.claude).toBe('number');
    expect(typeof DEFAULT_TIMEOUT_BY_HOST.codex).toBe('number');
  });
});
