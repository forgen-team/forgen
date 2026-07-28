import { describe, it, expect } from 'vitest';
import { resolveHaikuConsent } from '../src/core/compound-consent.js';

describe('resolveHaikuConsent (ADR-012 D 티어드 우선순위)', () => {
  it('default = off (opt-in)', () => {
    expect(resolveHaikuConsent({}, undefined)).toEqual({ enabled: false, source: 'default' });
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
