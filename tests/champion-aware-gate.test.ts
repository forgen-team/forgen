/**
 * Invariant: champion-aware injection gate — fitness state `champion` or
 * `active` gets a lower 0.25 threshold; everything else uses 0.3.
 *
 * Audit evidence (2026-04-21 gate sweep, /tmp/forgen-gate-sweep2.mjs):
 *   Gate A (flat 0.3):            precision 100%, recall 60%  ← too strict
 *   Gate B (flat 0.25):           precision 95.5%, recall 84%  ← noise risk
 *   Gate G (champion-aware):      precision 95.5%, recall 84%  ← selected
 *   Gate D (tags-only, no score): precision 88.5%, recall 92%, off-topic
 *                                  specificity 33% ← unacceptable
 *
 * Rationale for G over B: identical recall on the tested workload, but G
 * keeps the stricter floor on untested/underperform solutions — when the
 * corpus grows, a new noisy solution stays at 0.3 until it earns the
 * relaxation via actual accept history.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MIN_INJECT_RELEVANCE, MIN_INJECT_RELEVANCE_TRUSTED } from '../src/hooks/solution-injector.js';

describe('champion-aware gate constants', () => {
  it('default (draft/underperform) 임계값은 0.3', () => {
    expect(MIN_INJECT_RELEVANCE).toBe(0.3);
  });

  it('trusted (champion/active) 임계값은 0.25', () => {
    expect(MIN_INJECT_RELEVANCE_TRUSTED).toBe(0.25);
  });

  it('trusted < default (완화됐음)', () => {
    expect(MIN_INJECT_RELEVANCE_TRUSTED).toBeLessThan(MIN_INJECT_RELEVANCE);
  });
});

describe('champion-aware gate source invariant', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'hooks', 'solution-injector.ts'),
    'utf-8',
  );

  it('주입 루프에 minRelevanceFor 함수가 존재한다', () => {
    expect(src).toMatch(/function minRelevanceFor/);
  });

  it('fitness state로 champion/active 분기한다', () => {
    expect(src).toMatch(/state === 'champion' \|\| state === 'active'/);
  });

  it('fitness load 실패는 fail-open (default 0.3 적용)', () => {
    // 주석 + 코드에서 "default 0.3 적용" 근거 확인
    const codeOnly = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(codeOnly).toMatch(/catch.*log\.debug/);
  });
});

describe('precision gate predicate (pure logic mirror)', () => {
  function shouldInject(
    score: number,
    matchedTags: string[],
    matchedIdentifiers: string[],
    fitnessState?: string,
  ): boolean {
    const threshold = (fitnessState === 'champion' || fitnessState === 'active')
      ? MIN_INJECT_RELEVANCE_TRUSTED
      : MIN_INJECT_RELEVANCE;
    if (score < threshold) return false;
    const idMatches = matchedIdentifiers.length;
    const tagMatches = Math.max(0, matchedTags.length - idMatches);
    if (idMatches < 1 && tagMatches < 2) return false;
    return true;
  }

  it('champion 솔루션은 0.25도 통과', () => {
    expect(shouldInject(0.25, ['a', 'b'], [], 'champion')).toBe(true);
    expect(shouldInject(0.27, ['a', 'b'], [], 'champion')).toBe(true);
  });

  it('active 솔루션도 0.25 완화 혜택', () => {
    expect(shouldInject(0.25, ['a', 'b'], [], 'active')).toBe(true);
  });

  it('draft/underperform은 0.3 그대로', () => {
    expect(shouldInject(0.25, ['a', 'b'], [], 'draft')).toBe(false);
    expect(shouldInject(0.25, ['a', 'b'], [], 'underperform')).toBe(false);
    expect(shouldInject(0.29, ['a', 'b'], [], 'draft')).toBe(false);
    expect(shouldInject(0.30, ['a', 'b'], [], 'draft')).toBe(true);
  });

  it('fitness 정보 없으면 default (0.3) 적용', () => {
    // 신규 설치: outcomes 비어 있어 computeFitness 결과 없음
    expect(shouldInject(0.25, ['a', 'b'], [], undefined)).toBe(false);
    expect(shouldInject(0.30, ['a', 'b'], [], undefined)).toBe(true);
  });

  it('2-tag 규칙은 state와 무관하게 적용', () => {
    // champion이어도 tag 1개만이면 차단
    expect(shouldInject(0.8, ['only-one'], [], 'champion')).toBe(false);
    // identifier 매칭 있으면 통과
    expect(shouldInject(0.3, ['x'], ['myFunction'], 'champion')).toBe(true);
  });

  it('2026-04-21 gate sweep 결과 재현 (champion 솔루션 0.27 recall 개선)', () => {
    // 시뮬 sim-005에서 score 0.30, tags 2인 TDD 매칭은 champion 되면 통과
    expect(shouldInject(0.30, ['test', 'tdd'], [], 'champion')).toBe(true);
    // score 0.27 champion solution도 이제 통과 (recall 회복)
    expect(shouldInject(0.27, ['refactor', 'safety'], [], 'champion')).toBe(true);
    // 반면 draft 솔루션의 0.27은 여전히 차단 (precision 유지)
    expect(shouldInject(0.27, ['refactor', 'safety'], [], 'draft')).toBe(false);
  });
});

describe('cold-start 판정 (0.9.0 — draft 기록은 세지 않는다)', async () => {
  const { isColdStartFitness, MIN_INJECT_RELEVANCE_COLD_START } = await import('../src/hooks/solution-injector.js');
  it('draft 만 5개면 여전히 신규 사용자(0.2)', () => {
    expect(isColdStartFitness(['draft', 'draft', 'draft', 'draft', 'draft'])).toBe(true);
    expect(MIN_INJECT_RELEVANCE_COLD_START).toBe(0.2);
  });
  it('판정이 난 기록이 5개면 표준 경로', () => {
    expect(isColdStartFitness(['active', 'champion', 'underperform', 'active', 'champion', 'draft'])).toBe(false);
  });
  it('판정 4개 + draft 여럿은 신규 사용자', () => {
    expect(isColdStartFitness(['active', 'active', 'champion', 'underperform', 'draft', 'draft', 'draft'])).toBe(true);
  });
});
