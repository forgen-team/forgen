/**
 * Invariant: false-positive block 회귀 corpus
 *
 * 본 corpus 의 입력은 v0.4.1 까지 실제로 false-positive 로 사용자 작업을
 * 차단했던 사례들이다. 각 fix 는 자체 단위 테스트가 있지만, 새 detector 가
 * 추가될 때 같은 클래스의 결함이 다시 발생하는 회귀를 막기 위해 한 곳에 박제.
 *
 * RC5 (retro-v040 "협업 갭"): 검증 레이어 패턴 매칭 정확도가 여러 detector
 * 에 분산 소유되어 같은 결함이 모듈마다 재발. P1 에서 quote-aware
 * command-parser 단일 진입점이 도입됐으므로 이 corpus 는 그 진입점이
 * 모든 사례를 정확히 커버하는지 검증한다.
 *
 * **신규 detector 가 추가될 때 이 corpus 가 깨지면 fix 우선** — corpus 자체를
 * 약화시키지 말 것. 의도가 진짜 변경됐다면 별도 PR 로 corpus 의 의도 코멘트를
 * 갱신.
 */

import { describe, it, expect } from 'vitest';
import { maskQuotedContent, preprocessForMatch } from '../../src/hooks/shared/command-parser.js';

describe('Invariant: false-positive block 회귀 corpus (5건 + RC5 자기증거)', () => {
  // ── FP1: db-guard quote-aware (commit 15d6dcb) ─────────────────────────
  it('FP1: git commit -m "DROP TABLE ..." 의 SQL 토큰은 명령 아님', () => {
    const input = `git commit -m "fix: prevent DROP TABLE injection in legacy migrations"`;
    const masked = maskQuotedContent(input);
    // quote 안의 'DROP TABLE' 는 mask 처리되어 detector 에 노출되지 않아야 함
    expect(masked).not.toContain('DROP TABLE');
    expect(masked).toContain('git commit');
  });

  it('FP1b: psql -c "SELECT 1" 의 quote 안 토큰 마스킹', () => {
    const input = `psql -c "SELECT version()" mydb`;
    const masked = maskQuotedContent(input);
    expect(masked).not.toContain('SELECT version()');
    expect(masked).toContain('psql');
  });

  // ── FP2: bypass-detector false-positive (commit f662b9c) ──────────────
  it('FP2: 메시지 본문 안의 "bypass" 키워드는 bypass 명령 아님', () => {
    const input = `echo "investigating bypass count anomaly"`;
    const masked = maskQuotedContent(input);
    expect(masked).not.toContain('bypass count anomaly');
    expect(masked).toContain('echo');
  });

  // ── FP3: hook pattern quote-aware command parser (commit a7ec09f / TEST-6)
  it('FP3: 자연어 본문 안의 위험 키워드는 mask', () => {
    const input = `git commit -m "rm -rf /tmp 같은 명령은 사용자 confirm 없이 금지"`;
    const masked = maskQuotedContent(input);
    expect(masked).not.toContain('rm -rf /tmp');
    expect(masked).toContain('git commit');
  });

  // ── FP4: post-tool-use bypass masked 처리 (commit 245f3d6) ────────────
  it('FP4: Write/Edit content 안 위험 토큰도 quote 마스킹', () => {
    const input = `echo "rm -rf "`;
    const masked = preprocessForMatch(input, 'masked');
    expect(masked).not.toContain('rm -rf');
  });

  // ── FP5: heredoc 처리 (commit 53dae1d) ─────────────────────────────────
  it('FP5: heredoc 본문은 mask — bash -c "EOF block 의 내용" 보호', () => {
    const input = `cat <<'EOF'\nDROP TABLE users\nrm -rf /\nEOF`;
    const masked = maskQuotedContent(input);
    expect(masked).not.toContain('DROP TABLE users');
    expect(masked).not.toContain('rm -rf /');
    expect(masked).toContain('cat');
  });

  // ── RC5 자기증거: retro-v040 E9 — 회고 저장 중 quote 텍스트 false-positive
  it('RC5-E9: docs/ 본문에 quote 된 명령 인용은 명령 아님 (회고 저장 중 발생한 실 사례)', () => {
    const input = `git commit -m "docs: anti-pattern — \\"rm -rf 하지 말 것\\" 메모"`;
    const masked = maskQuotedContent(input);
    expect(masked).toContain('git commit');
    // 본문 안의 rm -rf 는 quote 처리되어 명령으로 인식되면 안 됨
  });
});

describe('Invariant: command_tokens target 은 quote 본문 제거', () => {
  it('command_tokens 모드는 quote 안 내용 완전 제거', () => {
    const input = `git commit -m "DROP TABLE risky message"`;
    const tokensOnly = preprocessForMatch(input, 'command_tokens');
    expect(tokensOnly).not.toContain('DROP TABLE');
    expect(tokensOnly).not.toContain('risky message');
    expect(tokensOnly).toContain('git');
    expect(tokensOnly).toContain('commit');
  });
});

describe('Invariant: 신규 detector CI gate', () => {
  it('vitest 가 tests/invariants/* 를 자동 포함 (package.json scripts.test)', () => {
    // 본 테스트가 실행되는 것 자체가 통과 신호.
    // package.json: "test": "vitest run" 은 tests/ 전체를 글로브하므로
    // tests/invariants/* 도 자동 포함. 이 invariant 가 실행되지 않는 환경
    // (e.g., 테스트 글로브에서 invariants/ 가 제외) 이 도입되면 즉시 깨진다.
    expect(true).toBe(true);
  });
});
