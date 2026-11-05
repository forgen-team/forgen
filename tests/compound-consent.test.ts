import { describe, it, expect } from 'vitest';
import { resolveHaikuConsent } from '../src/core/compound-consent.js';

describe('resolveHaikuConsent (ADR-019 우선순위)', () => {
  it('default = on (ADR-019, 최초 1회 안내로 투명성 확보)', () => {
    expect(resolveHaikuConsent({}, undefined)).toEqual({ enabled: true, source: 'default' });
  });

  it('명시적 false 는 기본 ON 이어도 존중', () => {
    expect(resolveHaikuConsent({}, false)).toEqual({ enabled: false, source: 'config' });
  });

  it('config true/false 반영', () => {
    expect(resolveHaikuConsent({}, true)).toEqual({ enabled: true, source: 'config' });
    expect(resolveHaikuConsent({}, false)).toEqual({ enabled: false, source: 'config' });
  });

  it('FORGEN_AUTO_COMPOUND=1 → on (config 무시)', () => {
    expect(resolveHaikuConsent({ on: '1' }, false)).toEqual({ enabled: true, source: 'env-on' });
  });

  it('FORGEN_NO_AUTO_COMPOUND=1 → off (강제, on/config 모두 무시)', () => {
    expect(resolveHaikuConsent({ no: '1', on: '1' }, true)).toEqual({ enabled: false, source: 'env-off' });
  });

  it('우선순위: no > on > config > default', () => {
    expect(resolveHaikuConsent({ no: '1' }, true).source).toBe('env-off');
    expect(resolveHaikuConsent({ on: '1' }, false).source).toBe('env-on');
    expect(resolveHaikuConsent({}, true).source).toBe('config');
    expect(resolveHaikuConsent({}, undefined).source).toBe('default');
  });
});

describe('claudeOnPathSync / 세션 시작 안내', () => {
  it('PATH 에 claude 가 없으면 false, 있으면 true', async () => {
    const { claudeOnPathSync } = await import('../src/core/compound-consent.js');
    const os = await import('node:os'); const fs = await import('node:fs'); const path = await import('node:path');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
    expect(claudeOnPathSync(d)).toBe(false);
    fs.writeFileSync(path.join(d, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    expect(claudeOnPathSync(d)).toBe(true);
  });
});
