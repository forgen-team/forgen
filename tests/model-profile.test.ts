/**
 * tests/model-profile.test.ts — ADR-010 W4-3 per-model 가드 프로필.
 * 측정 근거: v0.4.11 opus-4.8 blocks=0 (easy+hard) → advise.
 * 미측정 모델은 보수적 block. 캐시는 주입 가능한 home 으로 실제 fs 검증.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { guardModeForModel, cacheSessionModel, readSessionModel } from '../src/checks/_shared/model-profile.js';

describe('guardModeForModel (측정 기반 테이블)', () => {
  it('opus-4.8 (측정: blocks=0) → advise', () => {
    expect(guardModeForModel('claude-opus-4-8')).toBe('advise');
    expect(guardModeForModel('claude-opus-4-8[1m]')).toBe('advise');
  });

  it('미측정 모델은 전부 보수적 block (sonnet-5 포함 — R1/R2 측정 전)', () => {
    expect(guardModeForModel('claude-sonnet-5')).toBe('block');
    expect(guardModeForModel('claude-haiku-4-5-20251001')).toBe('block');
    expect(guardModeForModel('gpt-5-codex')).toBe('block');
  });

  it('리뷰 SEV-2: 버전 경계 — 가상의 4-80/4-88 은 미측정이므로 block', () => {
    expect(guardModeForModel('claude-opus-4-80')).toBe('block');
    expect(guardModeForModel('claude-opus-4-88')).toBe('block');
    expect(guardModeForModel('claude-opus-4-8-turbo')).toBe('advise'); // 비숫자 구분자 = 같은 4.8 계열
  });

  it('unknown(null/빈 값) → block (현행 유지 — statusline 캐시 부재 폴백)', () => {
    expect(guardModeForModel(null)).toBe('block');
    expect(guardModeForModel(undefined)).toBe('block');
    expect(guardModeForModel('')).toBe('block');
  });
});

describe('세션 모델 캐시 (실제 fs)', () => {
  let HOME: string;
  beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-model-')); delete process.env.FORGEN_MODEL; });
  afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); delete process.env.FORGEN_MODEL; });

  it('cache → read roundtrip; 부재 시 null', () => {
    expect(readSessionModel('sess-1', HOME)).toBeNull();
    cacheSessionModel('sess-1', 'claude-opus-4-8', HOME);
    expect(readSessionModel('sess-1', HOME)).toBe('claude-opus-4-8');
    // 다른 세션은 격리
    expect(readSessionModel('sess-2', HOME)).toBeNull();
  });

  it('FORGEN_MODEL env 가 캐시보다 우선 (fgx 런처/CI 폴백 경로)', () => {
    cacheSessionModel('sess-1', 'claude-sonnet-5', HOME);
    process.env.FORGEN_MODEL = 'claude-opus-4-8';
    expect(readSessionModel('sess-1', HOME)).toBe('claude-opus-4-8');
  });

  it('파손 캐시 → null (fail-open)', () => {
    cacheSessionModel('sess-1', 'x', HOME);
    fs.writeFileSync(path.join(HOME, '.forgen', 'state', 'current-model-sess-1.json'), '{broken');
    expect(readSessionModel('sess-1', HOME)).toBeNull();
  });
});
