import { describe, it, expect } from 'vitest';
import { classifyBehaviorKind, mapKindToAxisRefs, type BehaviorKind } from '../src/core/behavior-classifier.js';

describe('classifyBehaviorKind', () => {
  it('[품질안전] 라벨 → safety', () => {
    expect(classifyBehaviorKind('- [품질안전] TDD 필수, 프로덕션 전 e2e 의무')).toBe('safety');
  });

  it('[자율성] 라벨 → autonomy', () => {
    expect(classifyBehaviorKind('- [자율성] 사소한 변경은 묻지 않고 진행')).toBe('autonomy');
  });

  it('[워크플로우] 라벨 → workflow', () => {
    expect(classifyBehaviorKind('- [워크플로우] 테스트 → 구현 → 리팩토링 순서')).toBe('workflow');
  });

  it('순서 토큰만 있어도 → workflow', () => {
    expect(classifyBehaviorKind('패턴: PR 리뷰 시 보안 → 테스트 → 코드 품질 순서')).toBe('workflow');
  });

  it('[의사결정] 라벨 → thinking', () => {
    expect(classifyBehaviorKind('- [의사결정] 실측 우선, 직관 보류')).toBe('thinking');
  });

  it('어떤 라벨도 없으면 preference', () => {
    expect(classifyBehaviorKind('- [커뮤니케이션] 짧고 구조화된 응답 선호')).toBe('preference');
  });

  it('우선순위 — [품질안전] 이 워크플로우 토큰보다 우선', () => {
    expect(classifyBehaviorKind('- [품질안전] 안전성 검증 순서대로 → 진행')).toBe('safety');
  });

  it('우선순위 — [자율성] 이 [의사결정] 보다 우선', () => {
    expect(classifyBehaviorKind('- [자율성] 큰 결정은 [의사결정] 후 진행')).toBe('autonomy');
  });
});

describe('mapKindToAxisRefs — 4축 모두 cover (D1\'\' 핵심 검증)', () => {
  it('safety → quality_safety', () => {
    expect(mapKindToAxisRefs('safety')).toEqual(['quality_safety']);
  });

  it('autonomy → autonomy', () => {
    expect(mapKindToAxisRefs('autonomy')).toEqual(['autonomy']);
  });

  it('workflow → judgment_philosophy', () => {
    expect(mapKindToAxisRefs('workflow')).toEqual(['judgment_philosophy']);
  });

  it('thinking → judgment_philosophy', () => {
    expect(mapKindToAxisRefs('thinking')).toEqual(['judgment_philosophy']);
  });

  it('preference → communication_style', () => {
    expect(mapKindToAxisRefs('preference')).toEqual(['communication_style']);
  });

  it('5개 kind 가 4축 모두 cover (axis 합집합 검증)', () => {
    const allAxes = new Set<string>();
    const kinds: BehaviorKind[] = ['safety', 'autonomy', 'workflow', 'thinking', 'preference'];
    for (const k of kinds) {
      for (const a of mapKindToAxisRefs(k)) allAxes.add(a);
    }
    expect(allAxes).toEqual(new Set(['quality_safety', 'autonomy', 'judgment_philosophy', 'communication_style']));
  });

  it('반환값은 새 배열 (mutation 차단)', () => {
    const a = mapKindToAxisRefs('safety');
    a.push('hacked');
    expect(mapKindToAxisRefs('safety')).toEqual(['quality_safety']);
  });
});

describe('AC3 — quality 성격 발화 1건 → axis_refs[0] === quality_safety', () => {
  it('실 LLM 출력 시뮬레이션 입력', () => {
    const llmOutput = '- [품질안전] 테스트 커버리지 100% 미만 시 머지 거부 (관찰 근거: 최근 5건 PR 모두 90%+ 요구)';
    const kind = classifyBehaviorKind(llmOutput);
    const axisRefs = mapKindToAxisRefs(kind);
    expect(axisRefs[0]).toBe('quality_safety');
  });

  it('AC3 — autonomy 성격 발화 → axis_refs[0] === autonomy', () => {
    const llmOutput = '- [자율성] 보일러플레이트 변경은 사용자 확인 없이 진행 (관찰 근거: 5건 자동 진행 후 모두 수용)';
    const axisRefs = mapKindToAxisRefs(classifyBehaviorKind(llmOutput));
    expect(axisRefs[0]).toBe('autonomy');
  });
});

describe('회귀 — 기존 3분기 동작 보존', () => {
  it('워크플로우 패턴(이전 형식)이 여전히 workflow → judgment_philosophy', () => {
    const old = '- [워크플로우] 항상 TDD: red → green → refactor';
    expect(mapKindToAxisRefs(classifyBehaviorKind(old))).toEqual(['judgment_philosophy']);
  });

  it('의사결정(이전 형식)이 여전히 thinking → judgment_philosophy', () => {
    const old = '- [의사결정] 코드 정확성보다 런타임 결과 우선';
    expect(mapKindToAxisRefs(classifyBehaviorKind(old))).toEqual(['judgment_philosophy']);
  });

  it('커뮤니케이션(이전 형식)이 여전히 preference → communication_style', () => {
    const old = '- [커뮤니케이션] 짧고 구조화된 응답 선호';
    expect(mapKindToAxisRefs(classifyBehaviorKind(old))).toEqual(['communication_style']);
  });
});
