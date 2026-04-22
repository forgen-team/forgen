/**
 * R5-G2 regression — redactSecrets 는 transcript 를 외부 API 로 보내기 전에 모든
 * 알려진 자격증명 패턴을 [REDACTED:...] 로 치환한다.
 */
import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../src/hooks/secret-filter.js';

describe('redactSecrets', () => {
  it('API key 패턴 → 치환', () => {
    const input = 'debug log: api_key=sk_' + 'live_aAbBcCdDeEfFgGhHiIjJ12345 in config';
    const { redacted, hits } = redactSecrets(input);
    expect(hits.some((h) => h.name === 'API Key')).toBe(true);
    expect(redacted).not.toContain('sk_' + 'live_aAbBcCdDeEfFgGhHiIjJ12345');
    expect(redacted).toContain('[REDACTED:');
  });

  it('AWS 구성 ID 치환', () => {
    const input = 'aws_access_key_id = AKIA' + 'IOSFODNN7' + 'EXAMPLE';
    const { hits } = redactSecrets(input);
    expect(hits.some((h) => h.name === 'AWS Access Key')).toBe(true);
  });

  it('GitHub 토큰 치환', () => {
    const gh = 'ghp_' + 'abcdef1234567890ABCDEF1234567890abcdef'; // 40 chars after ghp_
    const { redacted } = redactSecrets(`my token: ${gh}`);
    expect(redacted).not.toContain(gh);
    expect(redacted).toContain('[REDACTED:GitHub Token]');
  });

  it('Private key block 치환', () => {
    const input = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIB...\n-----END RSA PRIVATE KEY-----';
    const { hits } = redactSecrets(input);
    expect(hits.some((h) => h.name === 'Private Key')).toBe(true);
  });

  it('Google API key 치환 (exact 35 chars after AIza)', () => {
    // pattern = /\bAIza[0-9A-Za-z_-]{35}\b/ — AIza + 정확히 35자 alphanumeric
    const suffix = 'SyDaBcDeFgHiJkLmNoPqRsTuVwXyZ012345'; // 35 chars
    expect(suffix.length).toBe(35);
    const input = `googleKey: AIza${suffix}`;
    const { hits } = redactSecrets(input);
    expect(hits.some((h) => h.name === 'Google API Key')).toBe(true);
  });

  it('정상 문자열은 변경 없음', () => {
    const input = 'normal conversation: asked claude to implement async/await';
    const { redacted, hits } = redactSecrets(input);
    expect(hits).toHaveLength(0);
    expect(redacted).toBe(input);
  });

  it('다중 secret — 모두 치환', () => {
    const input = [
      'password=abcd1234efgh5678',
      'GitHub: ghp_' + 'abcdef1234567890ABCDEF1234567890abcdef',
      'google: AIza' + 'BxYzw1234567890abcdefghijklmnopqrstuvw',
    ].join('\n');
    const { redacted, hits } = redactSecrets(input);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(redacted.match(/\[REDACTED:/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
