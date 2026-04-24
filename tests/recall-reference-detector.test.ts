/**
 * H4 완결: recall_referenced detector.
 *
 * US-06 의 recommendation_surfaced 가 "주입됐다" 만 측정했고 이 detector 가
 * "Claude 가 실제 응답에서 참조/인용했다" 까지 닫는다.
 */
import { describe, it, expect } from 'vitest';
import {
  detectRecallReferences,
  type InjectedSolutionEntry,
} from '../src/core/recall-reference-detector.js';

describe('detectRecallReferences — H4 완결', () => {
  it('empty text → 빈 결과', () => {
    const r = detectRecallReferences('', [{ name: 'foo-bar' }]);
    expect(r.newlyReferenced).toEqual([]);
  });

  it('empty injected → 빈 결과', () => {
    const r = detectRecallReferences('hello', []);
    expect(r.newlyReferenced).toEqual([]);
  });

  it('솔루션 name 이 응답에 등장하면 감지', () => {
    const sols: InjectedSolutionEntry[] = [
      { name: 'retro-v040-collab-gap' },
      { name: 'vitest-mock-esm' },
    ];
    const r = detectRecallReferences(
      'retro-v040-collab-gap 에서 본 패턴대로 진행했습니다.',
      sols,
    );
    expect(r.newlyReferenced).toEqual(['retro-v040-collab-gap']);
  });

  it('이미 _referenced:true 인 엔트리는 건너뜀', () => {
    const sols: InjectedSolutionEntry[] = [
      { name: 'retro-v040-collab-gap', _referenced: true },
    ];
    const r = detectRecallReferences(
      'retro-v040-collab-gap 언급함',
      sols,
    );
    expect(r.newlyReferenced).toEqual([]);
  });

  it('이름이 너무 짧으면 (< 4자) 오매칭 방지로 제외', () => {
    const sols: InjectedSolutionEntry[] = [{ name: 'foo' }];
    const r = detectRecallReferences('foo bar baz', sols);
    expect(r.newlyReferenced).toEqual([]);
  });

  it('여러 솔루션 동시 감지', () => {
    const sols: InjectedSolutionEntry[] = [
      { name: 'pattern-alpha' },
      { name: 'pattern-beta' },
      { name: 'pattern-gamma' },
    ];
    const r = detectRecallReferences(
      '이번에는 pattern-alpha 와 pattern-gamma 를 적용했다. beta 는 아직.',
      sols,
    );
    expect(r.newlyReferenced).toEqual(['pattern-alpha', 'pattern-gamma']);
  });

  it('부분 문자열이 아닌 정확한 slug 매칭', () => {
    const sols: InjectedSolutionEntry[] = [{ name: 'retro-v040-collab-gap' }];
    // 'retro' 만으로는 매칭 안 됨 (slug 전체여야)
    const r = detectRecallReferences('retro 회고', sols);
    expect(r.newlyReferenced).toEqual([]);
  });
});
