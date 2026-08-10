/**
 * Invariant: 4 로케일 README 의 학습-루프 서술이 consent 모델과 동기화 유지
 *
 * 자기증거: EN README(edfec4a)는 "session ends → auto-compound extracts" 라는
 * **무조건 추출** 프레이밍을 opt-in consent 모델(ADR-012)로 정직화했으나,
 * ko/ja/zh 3개 번역본은 한동안 미반영 상태로 남아 부정직 서술을 노출했다
 * (ko 는 v0.4.4 기준까지 뒤처짐). 본 테스트는 그 drift 가 다시 발생하지 못하게 한다.
 *
 * 두 방향으로 강제한다:
 *  (1) POSITIVE — 4 로케일 모두 consent 모델의 load-bearing 토큰을 포함해야 한다.
 *      번역본이 낡은 버전으로 되돌려지거나, 새 로케일이 정직화 블록 없이 추가되면 실패.
 *  (2) NEGATIVE — 어떤 로케일도 무조건-추출 프레이밍(`auto-compound` 문자열)을
 *      포함하면 안 된다. 정직화 이전 산문/다이어그램이 되살아나면 실패.
 *
 * 토큰은 세 언어에서 영어 기술용어로 그대로 보존되므로(critic 확인) 언어 비의존적이다.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const LOCALES = ['README.md', 'README.ko.md', 'README.ja.md', 'README.zh.md'];

// consent 모델을 정직하게 서술하려면 반드시 등장해야 하는 토큰들.
// 하나라도 빠지면 그 로케일은 EN 원본과 동기화가 깨진 것.
const REQUIRED_TOKENS = [
  'forgen compound consent on', // opt-in 게이트 (transcript 추출의 유일한 활성 경로)
  'opt-in', // 추출은 opt-in 임을 명시
  'egress 0', // corrections→rules 는 egress 0 (always-on)
  'advisory-only', // 채굴 룰은 advisory-only (ADR-013)
  'compound sweep', // 시간 기반 backstop (ADR-011)
  '<private>', // redaction 범위 고지
];

// 정직화 이전의 "무조건 추출" 프레이밍이 되살아나면 안 되는 토큰.
const FORBIDDEN_TOKENS = [
  'auto-compound', // "세션 끝나면 auto-compound 가 (무조건) 추출" — ADR-012 위반
];

describe('Invariant: README i18n consent-model 동기화 (learning loop)', () => {
  for (const locale of LOCALES) {
    it(`${locale} 가 consent 모델 필수 토큰을 모두 포함`, () => {
      const filePath = path.join(REPO_ROOT, locale);
      expect(fs.existsSync(filePath), `${locale} 존재해야 함`).toBe(true);
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const token of REQUIRED_TOKENS) {
        expect(
          content.includes(token),
          `${locale} 에 consent 토큰 누락: "${token}" — EN 원본과 학습-루프 서술이 어긋남. ` +
            `README.md 의 "Between sessions (automatic)" 블록 기준으로 재동기화 필요.`,
        ).toBe(true);
      }
    });

    it(`${locale} 가 무조건-추출 프레이밍을 포함하지 않음`, () => {
      const content = fs.readFileSync(path.join(REPO_ROOT, locale), 'utf-8');
      for (const token of FORBIDDEN_TOKENS) {
        expect(
          content.includes(token),
          `${locale} 에 금지 토큰 발견: "${token}" — 정직화 이전의 무조건-추출 서술이 되살아남. ` +
            `opt-in consent 모델(ADR-012)과 모순되므로 제거 필요.`,
        ).toBe(false);
      }
    });
  }
});
