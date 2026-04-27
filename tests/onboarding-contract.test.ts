/**
 * Invariant: 온보딩 문항 수 계약 통일 (W2)
 *
 * 자기증거: v0.4.1 까지 forgen --help 는 "2-question", README 는 "4문항",
 * 실제 onboarding-cli.ts 는 q1~q4 4문항 — 3 자리에서 서로 다른 수치.
 *
 * 본 invariant 는 다음을 강제:
 *   1. 실제 onboarding 함수가 4개 question 호출
 *   2. CLI help text 가 "4-question" (또는 4문항) 사용
 *   3. README 가 4문항 흐름 설명
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const EXPECTED_QUESTIONS = 4;

describe('Invariant: 온보딩 4문항 계약 (W2)', () => {
  it('onboarding-cli.ts 실제 question 호출 수', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/forge/onboarding-cli.ts'), 'utf-8');
    // q1..qN 변수가 askChoice 결과로 할당된 라인 카운트
    const matches = src.match(/const q\d+ = await askChoice\(/g) ?? [];
    expect(matches.length, `실제 askChoice 호출 ${matches.length}개`).toBe(EXPECTED_QUESTIONS);
  });

  it('cli.ts 도움말이 stale 2-question 표기 사용 안 함', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/cli.ts'), 'utf-8');
    expect(src).not.toMatch(/2-question/i);
    expect(src).not.toMatch(/2문항/);
  });

  it('cli.ts 도움말이 4-question 표기 사용', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/cli.ts'), 'utf-8');
    // onboarding 관련 줄에 4-question 또는 4문항이 등장
    const hasFourEn = /4-question/i.test(src);
    const hasFourKo = /4문항/.test(src);
    expect(hasFourEn || hasFourKo, 'cli.ts 도움말에 "4-question" 또는 "4문항" 표기 필요').toBe(true);
  });

  it('onboarding.ts 주석 명세 라인이 현재 4문항 표기', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/forge/onboarding.ts'), 'utf-8');
    // 주석 영역(파일 시작 ~ first import) 의 첫 명세 라인 (* N문항 온보딩 형식)
    const headerEnd = src.indexOf('import');
    const header = headerEnd > 0 ? src.slice(0, headerEnd) : src;
    // "N문항 온보딩" 형식의 직접 명세는 4 만 허용 (history 인용 컨텍스트는 OK)
    const directClaims = header.match(/^\s*\*\s*(\d+)문항 온보딩/gm) ?? [];
    for (const claim of directClaims) {
      expect(claim, `stale 명세 라인: "${claim.trim()}"`).toMatch(/4문항/);
    }
    expect(directClaims.length, '주석에 N문항 온보딩 명세 라인 ≥1').toBeGreaterThan(0);
  });

  it('README 4 로케일이 4-question 또는 4문항/4問/4题 표기', () => {
    const locales = ['README.md', 'README.ko.md', 'README.ja.md', 'README.zh.md'];
    // 영문 + 한국어 + 일본어 + 중국어 표기 모두 cover
    const fourPattern = /4(-|\s)?(question|문항|問|题|題)|4(つの|個の)?(質問|문항)|4个问题/i;
    for (const locale of locales) {
      const filePath = path.join(REPO_ROOT, locale);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(fourPattern.test(content), `${locale} 에 4문항/4-question/4問/4题 표기 필요`).toBe(true);
    }
  });
});
