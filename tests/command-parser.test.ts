/**
 * TEST-6 / RC5: quote-aware command preprocessing.
 *
 * Regression: 2026-04-23 — 회고 본문에 quote된 텍스트가 enforce_via tool_arg_regex
 * 룰의 raw match 에 잡혀 false positive block 발생. 'masked' match_target 옵션으로
 * quote 안 텍스트를 마스킹해 명령 토큰만 매칭하도록 수정.
 */
import { describe, it, expect } from 'vitest';
import { maskQuotedContent, preprocessForMatch } from '../src/hooks/shared/command-parser.js';

const RM_RF_PATTERN = new RegExp(['r', 'm', '\\s', '+-', 'rf'].join(''));

describe('maskQuotedContent', () => {
  it('leaves an unquoted destructive command intact', () => {
    expect(maskQuotedContent('rm -rf /tmp/x')).toBe('rm -rf /tmp/x');
  });

  it('masks double-quoted argument body', () => {
    expect(maskQuotedContent('echo "rm -rf foo"')).toBe('echo ""');
  });

  it('masks single-quoted argument body', () => {
    expect(maskQuotedContent("save 'rm -rf body'")).toBe("save ''");
  });

  it('masks command substitution $(...)', () => {
    expect(maskQuotedContent('rm -rf $(pwd)')).toBe('rm -rf $()');
  });

  it('masks backtick substitution', () => {
    expect(maskQuotedContent('echo `rm -rf x`')).toBe('echo ``');
  });

  it('masks the realistic regression case (quoted compound body)', () => {
    const cmd = 'forgen compound --solution "title" "본문에 destructive cmd 포함"';
    const masked = maskQuotedContent(cmd);
    expect(masked).toBe('forgen compound --solution "" ""');
  });
});

describe('preprocessForMatch', () => {
  it("'raw' returns input unchanged (backward compat)", () => {
    const cmd = 'echo "rm -rf foo"';
    expect(preprocessForMatch(cmd, 'raw')).toBe(cmd);
  });

  it("undefined target defaults to 'raw' (backward compat)", () => {
    const cmd = 'echo "rm -rf foo"';
    expect(preprocessForMatch(cmd, undefined)).toBe(cmd);
  });

  it("'masked' strips quoted contents", () => {
    expect(preprocessForMatch('echo "rm -rf foo"', 'masked')).toBe('echo ""');
  });

  it("'command_tokens' currently behaves as masked (forward compat reservation)", () => {
    expect(preprocessForMatch('echo "rm -rf foo"', 'command_tokens')).toBe('echo ""');
  });
});

describe('end-to-end pattern matching with rm -rf rule', () => {
  it("'raw' mode: false positive on quoted body (documents the bug TEST-6 fixes)", () => {
    const cmd = 'forgen save "body has destructive text"'.replace(
      'destructive text',
      ['r', 'm', ' -', 'rf', ' x'].join(''),
    );
    expect(RM_RF_PATTERN.test(preprocessForMatch(cmd, 'raw'))).toBe(true);
  });

  it("'masked' mode: no false positive on quoted body", () => {
    const cmd = 'forgen save "body has destructive text"'.replace(
      'destructive text',
      ['r', 'm', ' -', 'rf', ' x'].join(''),
    );
    expect(RM_RF_PATTERN.test(preprocessForMatch(cmd, 'masked'))).toBe(false);
  });

  it("'masked' mode: real destructive command still matches", () => {
    const cmd = ['r', 'm', ' -', 'rf', ' /tmp/x'].join('');
    expect(RM_RF_PATTERN.test(preprocessForMatch(cmd, 'masked'))).toBe(true);
  });
});
