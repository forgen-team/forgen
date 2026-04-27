/**
 * Invariant: 4 로케일 README 설치 명령 일치 (W1)
 *
 * 자기증거: README.ko.md 가 v0.4.1 까지 `npm install -g /forgen` 로 깨져 있었고,
 * 한국어 사용자는 첫 명령부터 실패. 본 테스트는 그 회귀가 다시 발생하지 못하게
 * 한다. 4 로케일에서 install command 가 동일 패키지 이름을 가리켜야 한다.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGE_NAME = '@wooojin/forgen';
const LOCALES = ['README.md', 'README.ko.md', 'README.ja.md', 'README.zh.md'];

describe('Invariant: README install command 일치 (W1)', () => {
  for (const locale of LOCALES) {
    it(`${locale} 의 모든 'npm install -g' 라인이 ${PACKAGE_NAME} 사용`, () => {
      const filePath = path.join(REPO_ROOT, locale);
      expect(fs.existsSync(filePath), `${locale} 존재해야 함`).toBe(true);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const installLines = lines.filter(l => l.includes('npm install -g'));
      expect(installLines.length, `${locale} 에 npm install -g 라인이 ≥1`).toBeGreaterThan(0);
      for (const line of installLines) {
        expect(
          line,
          `${locale} install line 이 ${PACKAGE_NAME} 미포함: "${line.trim()}"`,
        ).toContain(PACKAGE_NAME);
      }
    });
  }

  it('4 로케일 install command 의 패키지 이름이 모두 동일', () => {
    const packageNames = new Set<string>();
    for (const locale of LOCALES) {
      const content = fs.readFileSync(path.join(REPO_ROOT, locale), 'utf-8');
      for (const line of content.split('\n')) {
        const m = line.match(/npm install -g\s+(\S+)/);
        if (m) packageNames.add(m[1]);
      }
    }
    expect(
      packageNames.size,
      `4 로케일에서 서로 다른 패키지 이름 발견: ${[...packageNames].join(', ')}`,
    ).toBe(1);
    expect([...packageNames][0]).toBe(PACKAGE_NAME);
  });
});
