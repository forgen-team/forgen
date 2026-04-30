/**
 * Pathfinder D4 + D5 회귀 테스트 — text-sanitizer.
 *
 * 배경 (PATHFINDER-2026-04-30/02-duplication-report.md):
 *  - D4: stop-guard 3종 체크가 raw lastMessage 에 regex 직접 적용 → observer XML
 *    구조 출력이 점수/사실 키워드와 매칭 (FP 50%+).
 *  - D5: self-paradox — regex 트리거 어휘를 *인용해* 설명만 해도 본인 매칭.
 *    ("4/10" 같은 리터럴 인용이 \b\d+\/(10|100)\b 매칭).
 *
 * sanitizer 는 stop-guard 진입 시 lastMessage 에 한 번 적용되어 두 결함 동시 차단.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeForGuard } from '../src/checks/_shared/text-sanitizer.js';

describe('sanitizeForGuard — D4 structured-output 면제', () => {
  it('<observation> 블록 본문이 제거된다', () => {
    const raw = `사용자에게 응답.\n<observation>\n  <type>discovery</type>\n  <title>신뢰도 95/100 진단</title>\n</observation>\n계속.`;
    const out = sanitizeForGuard(raw);
    expect(out).not.toContain('신뢰도 95/100');
    expect(out).not.toContain('<observation>');
    expect(out).toContain('사용자에게 응답');
    expect(out).toContain('계속');
  });

  it('<summary> 블록도 제거된다', () => {
    const raw = `<summary><request>x</request><investigated>y verified</investigated></summary>본문`;
    expect(sanitizeForGuard(raw)).not.toContain('verified');
    expect(sanitizeForGuard(raw)).toContain('본문');
  });

  it('여러 structured tag 가 섞여있어도 모두 제거', () => {
    const raw = `prefix\n<title>완료 95/100</title>\n<subtitle>passed</subtitle>\nsuffix`;
    const out = sanitizeForGuard(raw);
    expect(out).not.toContain('95/100');
    expect(out).not.toContain('passed');
    expect(out).toContain('prefix');
    expect(out).toContain('suffix');
  });
});

describe('sanitizeForGuard — D5 self-paradox 면제 (인용 stripping)', () => {
  it('inline backtick 코드는 제거된다', () => {
    const raw = '예시 패턴은 `4/10` 형식입니다.';
    expect(sanitizeForGuard(raw)).not.toContain('4/10');
    expect(sanitizeForGuard(raw)).toContain('예시 패턴은');
  });

  it('fenced code block 도 제거', () => {
    const raw = "정규식 예시:\n```\n신뢰도 90%\n```\n끝.";
    const out = sanitizeForGuard(raw);
    expect(out).not.toContain('신뢰도 90%');
    expect(out).toContain('정규식 예시');
    expect(out).toContain('끝');
  });

  it('짧은 직인용("…")은 제거', () => {
    const raw = 'Hook 이 "verified" 키워드를 잡습니다.';
    expect(sanitizeForGuard(raw)).not.toContain('verified');
    expect(sanitizeForGuard(raw)).toContain('Hook');
    expect(sanitizeForGuard(raw)).toContain('키워드를 잡습니다');
  });
});

describe('sanitizeForGuard — TP 보존 (진짜 인플레이션은 살아남음)', () => {
  it('자연 산문 안의 "신뢰도 95/100" 은 유지', () => {
    const raw = '구현 완료. 신뢰도 95/100 으로 자신 있습니다.';
    const out = sanitizeForGuard(raw);
    expect(out).toContain('신뢰도 95/100');
    expect(out).toContain('완료');
  });

  it('자연 산문의 "verified" 는 유지', () => {
    const raw = 'All tests passed. The implementation is verified end-to-end.';
    const out = sanitizeForGuard(raw);
    expect(out).toContain('verified');
    expect(out).toContain('passed');
  });

  it('짧은 직인용 외 긴 따옴표 본문은 보존 (40자 초과)', () => {
    const raw = '사용자가 말했다 "구현 완료. 모든 검증 끝. 신뢰도 95/100 으로 자신 있습니다." 라고.';
    const out = sanitizeForGuard(raw);
    expect(out).toContain('신뢰도 95/100');
  });
});

describe('sanitizeForGuard — idempotent + 비파괴', () => {
  it('빈 문자열은 그대로', () => {
    expect(sanitizeForGuard('')).toBe('');
  });

  it('두 번 적용해도 결과 동일', () => {
    const raw = '<observation>x verified</observation>본문 `4/10`';
    const a = sanitizeForGuard(raw);
    const b = sanitizeForGuard(a);
    expect(a).toBe(b);
  });
});
