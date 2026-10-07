import { describe, it, expect } from 'vitest';
import { isSyntheticSession, isSyntheticEntry, isRealBlock, isConfirmedBypass, syntheticStamp } from '../src/engine/lifecycle/signals.js';

const UUID = '3f2b8c1e-9a4d-4e7b-8c55-1a2b3c4d5e6f';
const CODEX_UUID_V7 = '019a2b3c-4d5e-7f60-8a1b-2c3d4e5f6a7b';

describe('합성 세션/엔트리 판정 (ADR-017 §9)', () => {
  it('uuid(Claude/Codex) 는 실세션', () => {
    expect(isSyntheticSession(UUID)).toBe(false);
    expect(isSyntheticSession(CODEX_UUID_V7)).toBe(false);
  });
  it('default/unknown/빈값/비문자열/비-uuid 하네스 id 는 합성', () => {
    for (const s of ['default', 'unknown', '', undefined, 42, 'forgen-eval-1780000000000-abc123', 'repro-sev2', 'enforce-test', 'w43-probe', 'real-s1']) {
      expect(isSyntheticSession(s)).toBe(true);
    }
  });
  it('synthetic:true 플래그는 uuid 세션이어도 집계 제외', () => {
    expect(isSyntheticEntry({ session_id: UUID, synthetic: true })).toBe(true);
    expect(isRealBlock({ kind: 'block', session_id: UUID, synthetic: true })).toBe(false);
    expect(isRealBlock({ kind: 'block', session_id: UUID })).toBe(true);
    expect(isConfirmedBypass({ kind: 'bypass_confirmed', session_id: UUID, synthetic: true })).toBe(false);
  });
  it('FORGEN_SYNTHETIC=1 일 때만 stamp', () => {
    const prev = process.env.FORGEN_SYNTHETIC;
    try {
      delete process.env.FORGEN_SYNTHETIC;
      expect(syntheticStamp()).toEqual({});
      process.env.FORGEN_SYNTHETIC = '1';
      expect(syntheticStamp()).toEqual({ synthetic: true });
    } finally {
      if (prev === undefined) delete process.env.FORGEN_SYNTHETIC;
      else process.env.FORGEN_SYNTHETIC = prev;
    }
  });
});
