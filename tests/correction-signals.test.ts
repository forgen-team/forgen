import { describe, it, expect } from 'vitest';
import { correctionScore } from '../src/core/correction-signals.js';

describe('correctionScore', () => {
  it('명시 마커/반사실/부정은 강한 신호', () => {
    for (const t of ['그렇게 하지 마', '이거 말고 저걸로', '그게 아니라 반대야', '앞으로는 한국어로', "don't add comments", 'that is wrong']) {
      expect(correctionScore(t)).toBe(3);
    }
  });
  it('완곡·반복 요구는 중간 신호', () => {
    for (const t of ['굳이 이걸 해야 해?', '다시 해봐', '왜 이렇게 했어', '그 파일은 안 했어?']) {
      expect(correctionScore(t)).toBeGreaterThanOrEqual(2);
    }
  });
  it('중립 진행 지시는 0', () => {
    for (const t of ['다음 거 하자', '옵션 A로 가자', '빌드 돌려줘', '']) expect(correctionScore(t)).toBe(0);
  });
});
