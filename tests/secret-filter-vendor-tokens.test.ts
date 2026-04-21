/**
 * Invariant: secret-filter covers vendor-specific token formats that
 * the generic `(sk|pk|api-key)[_-]` pattern misses.
 *
 * Follow-up audit (2026-04-21, finding #B): GitHub PATs (`ghp_`, `gho_`,
 * `ghs_`, `ghu_`, `ghr_`), Google API keys (`AIza…`), and Slack tokens
 * (`xox[abpors]-…`) are the three highest-volume real-world leak
 * formats and were all unmatched by the old rule set.
 */
import { describe, it, expect } from 'vitest';
import { detectSecrets, SECRET_PATTERNS } from '../src/hooks/secret-filter.js';

function names(text: string): string[] {
  return detectSecrets(text).map((p) => p.name);
}

describe('secret-filter vendor-token coverage', () => {
  it('GitHub PAT (ghp_, gho_, ghs_, ghu_, ghr_) 은 감지된다', () => {
    for (const prefix of ['ghp', 'gho', 'ghs', 'ghu', 'ghr']) {
      const token = `${prefix}_` + 'a'.repeat(40);
      expect(names(`GITHUB_TOKEN=${token}`)).toContain('GitHub Token');
    }
  });

  it('Google API key (AIza + 35자) 는 감지된다', () => {
    // Google 표준 포맷: AIza + 35자 [0-9A-Za-z_-]
    const key = 'AIza' + 'B'.repeat(35);
    expect(names(`GOOGLE_API_KEY=${key}`)).toContain('Google API Key');
  });

  it('Slack 토큰 (xoxb-, xoxp- 등) 은 감지된다', () => {
    for (const prefix of ['xoxb', 'xoxp', 'xoxa', 'xoxr', 'xoxs', 'xoxo']) {
      const token = `${prefix}-1234567890-abcdefghijk`;
      const got = names(`SLACK_TOKEN=${token}`);
      expect(got).toContain('Slack Token');
    }
  });

  it('기존 패턴(sk-, AKIA, JWT 등)은 계속 동작', () => {
    expect(names('OPENAI_KEY=sk-proj-' + 'x'.repeat(40))).toContain('API Key');
    expect(names('AWS=AKIA' + 'A'.repeat(16))).toContain('AWS Access Key');
    expect(names(`bearer "${'x'.repeat(30)}"`)).toContain('Token/Bearer/JWT');
  });

  it('일반 텍스트 false-positive 없음', () => {
    expect(names('hello world, no secrets here')).toEqual([]);
    expect(names('const name = "forgen"; // just a name')).toEqual([]);
    // ghp_ 앞에 다른 문자가 붙은 경우 (word boundary 필요)
    expect(names('somethinghp_' + 'x'.repeat(40))).not.toContain('GitHub Token');
  });

  it('신규 패턴이 SECRET_PATTERNS에 포함되어 있다 (source invariant)', () => {
    const names_all = SECRET_PATTERNS.map((p) => p.name);
    expect(names_all).toContain('GitHub Token');
    expect(names_all).toContain('Google API Key');
    expect(names_all).toContain('Slack Token');
  });
});
