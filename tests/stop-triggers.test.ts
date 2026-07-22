import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STOP_TRIGGER_RE,
  DEFAULT_STOP_EXCLUDE_RE,
  CRITIC_STOP_TRIGGER_RE,
  CRITIC_STOP_EXCLUDE_RE,
} from '../src/hooks/shared/stop-triggers.js';

const fires = (trig: string, exc: string) => (s: string) =>
  new RegExp(trig, 'i').test(s) && !new RegExp(exc, 'i').test(s);

const criticFires = fires(CRITIC_STOP_TRIGGER_RE, CRITIC_STOP_EXCLUDE_RE);
const defaultFires = fires(DEFAULT_STOP_TRIGGER_RE, DEFAULT_STOP_EXCLUDE_RE);

describe('CRITIC_STOP_TRIGGER_RE — critic-review 룰 전용 (완료 OR 리뷰생략-넘어감)', () => {
  describe('발화(TP)', () => {
    for (const s of [
      '구현 완료했습니다.',                                  // 완료 선언
      '커밋 끝났습니다. 리뷰는 생략하고 바로 다음 기능 구현으로 넘어가겠습니다.', // V2
      '리뷰 생략하고 다음으로 넘어갈게요',
      '검토는 생략하고 다음 작업으로 넘어가겠습니다',
      'skip the review and move on to the next task',
      // 리뷰 SEV-3 (a): 외래어/구어 skip 표현
      '리뷰는 스킵하고 다음으로 넘어갈게요',
      '리뷰 패스하고 다음 작업으로 넘어가겠습니다',
      '리뷰 안 하고 다음으로 넘어감',
    ]) {
      it(`fires: "${s.slice(0, 26)}…"`, () => expect(criticFires(s)).toBe(true));
    }
  });

  describe('FP 방지 (리뷰 SEV-2 #1 — flow-reviewer 배터리)', () => {
    for (const s of [
      '코드 리뷰 없이 배포하면 위험합니다. 반드시 리뷰하세요.',   // 생략 경고
      '다음 단계로 넘어가기 전에 테스트를 먼저 하겠습니다.',      // 신중한 순서
      '다음 기능으로 넘어가도 될까요?',                        // 질문
      'You should not skip the review before merging.',       // 조언
      "Don't skip the review, let's be careful.",             // 금지
      '리뷰 반영했습니다',                                    // 리뷰 있으나 생략 아님
      '이 엣지케이스는 생략 가능합니다',                       // 생략 있으나 리뷰/넘어감 아님
      '다음 기능은 로그인입니다',                              // 다음 있으나 넘어감 아님
      // 리뷰 SEV-3 (a): 숙고(deliberation)는 skip 단언이 아님
      '리뷰를 생략할지 다음 작업으로 넘어갈지 고민 중입니다',
      '리뷰 생략 여부를 넘어가기 전에 결정하겠습니다',
    ]) {
      it(`does NOT fire: "${s.slice(0, 24)}…"`, () => expect(criticFires(s)).toBe(false));
    }
  });

  describe('retraction/부정 exclude (리뷰 SEV-2 #2)', () => {
    for (const s of [
      '리뷰 생략하지 말고 다음으로 넘어가자',      // 말고
      '리뷰를 생략하지 않고 다음으로 진행',         // 하지 않
      '리뷰 생략 안 했습니다. 다음으로 넘어갈게요', // 안 했(과거 retraction) — "안 하고" TP와 구분
    ]) {
      it(`excluded: "${s.slice(0, 24)}…"`, () => expect(criticFires(s)).toBe(false));
    }
  });
});

describe('DEFAULT_STOP_TRIGGER_RE — 완료 전용 (semantic 비오염, 리뷰 SEV-2 #3)', () => {
  it('완료 선언에 발화', () => {
    expect(defaultFires('구현 완료했습니다.')).toBe(true);
  });
  it('리뷰생략-넘어감에는 발화 안 함 (e2e/mock 룰 오염 방지)', () => {
    expect(defaultFires('리뷰는 생략하고 다음 기능으로 넘어가겠습니다.')).toBe(false);
  });
});
