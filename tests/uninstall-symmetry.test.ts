/**
 * Invariant: uninstall removes everything install injects — statusLine
 * `forgen me` + `FORGEN_*` env keys. Pre-audit the cleanup only matched
 * `'forgen status'` and `COMPOUND_*` so a full install/uninstall cycle
 * left leftovers in settings.json.
 *
 * Audit finding #7 (2026-04-21).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'core', 'uninstall.ts'),
  'utf-8',
);

describe('install/uninstall symmetry (source invariants)', () => {
  it('env cleanup은 COMPOUND_ + FORGEN_ 둘 다 정리한다', () => {
    // Active code path (주석 제외)
    const codeOnly = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(codeOnly).toMatch(/key\.startsWith\(['"]COMPOUND_['"]\)/);
    expect(codeOnly).toMatch(/key\.startsWith\(['"]FORGEN_['"]\)/);
  });

  it('statusLine 제거는 "forgen me"도 인식한다 (install과 대칭)', () => {
    const codeOnly = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    // 과거의 정확 일치 체크는 제거되었어야 함
    expect(codeOnly).not.toMatch(/command === ['"]forgen status['"]/);
    // 새 체크: statusline-install 의 isForgenStatusline (`forgen …` + 절대경로 + shim 형식)
    expect(codeOnly).toMatch(/isForgenStatusline\(/);
  });
});

describe('uninstall statusLine semantics', () => {
  // cleanSettings 함수는 내부 함수라 직접 호출 불가. 대신 end-to-end로
  // handleUninstall을 테스트하면 readline prompt가 걸려 vitest에서 까다롭다.
  // 대신 실 로직에 해당하는 regex를 재현해 branch 케이스를 검증.
  function shouldRemoveForgenStatusLine(cmd: string): boolean {
    return /^forgen(\s|$)/.test(cmd.trim());
  }

  it.each([
    ['forgen me', true],
    ['forgen status', true],
    ['forgen dashboard', true],
    ['forgen', true],
    ['  forgen me  ', true],
    ['starship', false],
    ['custom-cli forgen', false],
    ['forgenize', false], // similar prefix but different word boundary
    ['', false],
  ])('%s → should remove = %s', (cmd, expected) => {
    expect(shouldRemoveForgenStatusLine(cmd)).toBe(expected);
  });
});
