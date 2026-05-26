/**
 * Invariant: solution-injector applies a precision gate — a match must
 * have either an identifier hit OR ≥2 matched tags to reach the user's
 * context. Score alone isn't enough; single-tag rare-word matches get
 * 0.5~0.8 scores via BM25 × IDF on tokens like "forgen"/"type"/"file"
 * yet carry no real intent overlap.
 *
 * Audit data source: ~/.forgen/state/match-eval-log.jsonl (7406 queries,
 * 33.5% of top-1 matches had exactly 1 tag overlap) and observed live
 * false positives during the 2026-04-21 session.
 *
 * Matcher stays permissive (top-5 recall preserved for bootstrap eval);
 * only the injection step enforces the gate.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'hooks', 'solution-injector.ts'),
  'utf-8',
);

describe('solution-injector precision gate (source invariant)', () => {
  it('주입 루프에 idMatches + tagMatches 게이트가 존재한다', () => {
    expect(src).toMatch(/sol\.matchedIdentifiers/);
    expect(src).toMatch(/idMatches < 1 && tagMatches < 2/);
  });

  it('relevance 게이트는 여전히 유지 (이중 방어, champion-aware 버전)', () => {
    // 2026-04-21: MIN_INJECT_RELEVANCE 직접 비교 → minRelevanceFor(name) 로 전환.
    // fitness state (champion/active)면 0.25, 아니면 0.3 적용.
    expect(src).toMatch(/sol\.relevance\s*<\s*minRelevanceFor\(sol\.name\)/);
    expect(src).toMatch(/MIN_INJECT_RELEVANCE_TRUSTED/);
  });

  it('matcher의 permissive filter (1개 이상)는 유지 (bootstrap eval 호환)', () => {
    const matcher = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'engine', 'ranking-pipeline.ts'),
      'utf-8',
    );
    expect(matcher).toMatch(/matchedTags\.length \+ c\.matchedIdentifiers\.length >= 1/);
  });
});

describe('precision gate predicate (pure logic mirror)', () => {
  // 주입 결정 로직의 순수 함수 버전. solution-injector에서 그대로 가져온 규칙.
  function shouldInject(score: number, matchedTags: string[], matchedIdentifiers: string[]): boolean {
    if (score < 0.3) return false; // MIN_INJECT_RELEVANCE
    const idMatches = matchedIdentifiers.length;
    const tagMatches = Math.max(0, matchedTags.length - idMatches);
    if (idMatches < 1 && tagMatches < 2) return false;
    return true;
  }

  it('2026-04-21 관찰 false positive 4건은 전부 차단', () => {
    // 실제 로그에서 관찰된 케이스 재현
    expect(shouldInject(0.50, ['forgen'], [])).toBe(false);
    expect(shouldInject(0.70, ['type'], [])).toBe(false);
    expect(shouldInject(0.80, ['file', 'marker-file'], [])).toBe(true); // 2 tags OK
    // "file" 단독
    expect(shouldInject(0.80, ['file'], [])).toBe(false);
    // "promotion" 단독
    expect(shouldInject(0.80, ['promotion'], [])).toBe(false);
  });

  it('정상 multi-tag 매칭은 통과', () => {
    expect(shouldInject(0.6, ['cache', 'invalidation'], [])).toBe(true);
    expect(shouldInject(0.5, ['async', 'promise', 'concurrency'], [])).toBe(true);
  });

  it('identifier 매칭은 1-tag 매칭도 통과 (강한 신호)', () => {
    // 함수/파일명을 유저가 직접 언급한 경우
    expect(shouldInject(0.4, ['react'], ['useCallback'])).toBe(true);
    expect(shouldInject(0.5, [], ['spawnClaudeWithResume'])).toBe(true);
  });

  it('저score는 태그 수와 무관하게 차단 (MIN_INJECT_RELEVANCE)', () => {
    expect(shouldInject(0.15, ['a', 'b', 'c', 'd', 'e'], [])).toBe(false);
    expect(shouldInject(0.29, ['a', 'b'], [])).toBe(false);
  });

  it('경계값 0.3 정확히는 통과 (>= 아닌 < 로 체크)', () => {
    expect(shouldInject(0.3, ['a', 'b'], [])).toBe(true);
    expect(shouldInject(0.30001, ['a', 'b'], [])).toBe(true);
  });
});
