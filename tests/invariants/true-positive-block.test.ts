/**
 * Invariant: true-positive block corpus (정당 block)
 *
 * retro-v040 의 E5 (rm -rf 9회) / E6 (secret commit 4회) 사례는 false-positive 가
 * **아니라** 정당한 block. 사용자가 confirm 없이 위험 작업 시도 → 가드가 차단.
 *
 * P2 의 핵심 분리: false-positive corpus 와 분리하여 박제. 이 입력들은
 * 어떤 fix 가 들어와도 **반드시 block 권한을 가진 명령으로 식별**되어야 함.
 * 가드 약화 회귀를 즉시 감지.
 */

import { describe, it, expect } from 'vitest';
import { maskQuotedContent, preprocessForMatch } from '../../src/hooks/shared/command-parser.js';

describe('Invariant: true-positive 명령 토큰 보존 (E5/E6)', () => {
  // ── E5: rm -rf 9회 — 정당 block 사례 ───────────────────────────────────
  it('E5: 평문 rm -rf 명령은 mask 후에도 토큰 보존', () => {
    const input = `rm -rf ~/.forgen/state`;
    const masked = preprocessForMatch(input, 'masked');
    expect(masked).toContain('rm');
    expect(masked).toContain('-rf');
  });

  it('E5b: rm -rf 가 다른 명령 뒤에 chain 되어도 토큰 보존', () => {
    const input = `cd /tmp && rm -rf old-data`;
    const masked = preprocessForMatch(input, 'masked');
    expect(masked).toContain('rm');
    expect(masked).toContain('-rf');
  });

  // ── E6: secret commit 4회 — 정당 block ────────────────────────────────
  it('E6: env 파일 본문이 quote 밖에 있으면 마스킹되지 않아 secret-filter 가 캐치 가능', () => {
    const input = `cat .env`;
    const masked = preprocessForMatch(input, 'raw');
    expect(masked).toContain('.env');
  });

  // ── 일반 위험 명령 ─────────────────────────────────────────────────────
  it('TP1: DROP TABLE 이 평문이면 보존 (db-guard 가 캐치)', () => {
    const input = `psql -c "DROP TABLE users"`;
    const tokens = preprocessForMatch(input, 'command_tokens');
    // command_tokens 는 quote 본문 제거하지만 명령 자체는 보존
    expect(tokens).toContain('psql');
    // 단, quote 안의 DROP TABLE 은 의도적으로 제거 (명령 토큰만 남김)
    // 이건 db-guard 가 quote 본문 토큰을 별도로 검사하는 layered defense
    expect(tokens).not.toContain('DROP TABLE');
  });

  it('TP2: 평문 DROP TABLE (no quote) 은 raw 에서 보존', () => {
    const input = `mysql --execute=DROP TABLE users`;
    const masked = preprocessForMatch(input, 'masked');
    expect(masked).toContain('DROP');
  });
});
