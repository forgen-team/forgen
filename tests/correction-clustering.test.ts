import { describe, it, expect } from 'vitest';
import {
  policySimilarity,
  laplaceConfidence,
  strengthForConfidence,
  clusterCorrectionRules,
  clusterKey,
  CLUSTER_SIMILARITY_TAU,
  type ClusterableRule,
} from '../src/engine/correction-clustering.js';

function rule(id: string, category: string, policy: string, extra: Partial<ClusterableRule> = {}): ClusterableRule {
  return { rule_id: id, category, policy, strength: 'default', evidence_refs: [`ev-${id}`], ...extra };
}

describe('correction-clustering (W3-2)', () => {
  describe('laplaceConfidence — rule of succession', () => {
    it('(N+1)/(N+2) for consistent corrections', () => {
      expect(laplaceConfidence(1)).toBeCloseTo(0.667, 2);
      expect(laplaceConfidence(2)).toBeCloseTo(0.75, 2);
      expect(laplaceConfidence(3)).toBeCloseTo(0.8, 2);
      expect(laplaceConfidence(5)).toBeCloseTo(0.857, 2);
    });
    it('failures lower confidence: (s+1)/(s+f+2)', () => {
      expect(laplaceConfidence(3, 1)).toBeCloseTo(0.667, 2);
      expect(laplaceConfidence(2, 2)).toBeCloseTo(0.5, 2);
    });
  });

  describe('strengthForConfidence — hard never auto', () => {
    it('conf ≥ 0.75 (N≥2) → strong', () => {
      expect(strengthForConfidence(laplaceConfidence(2))).toBe('strong');
      expect(strengthForConfidence(laplaceConfidence(3))).toBe('strong');
    });
    it('conf < 0.75 (N=1) → default', () => {
      expect(strengthForConfidence(laplaceConfidence(1))).toBe('default');
    });
    it('never returns hard even at very high confidence', () => {
      expect(strengthForConfidence(0.99)).toBe('strong');
      expect(strengthForConfidence(1.0)).toBe('strong');
    });
  });

  describe('policySimilarity — symmetric', () => {
    it('identical policies → high similarity', () => {
      const s = policySimilarity('완료 선언 전 실제 검증하라', '완료 선언 전 실제 검증하라');
      expect(s).toBeGreaterThan(CLUSTER_SIMILARITY_TAU);
    });
    it('unrelated policies → low similarity', () => {
      const s = policySimilarity('사이드바에 shrink-0 적용', 'npm publish 는 완성도 도달 시에만');
      expect(s).toBeLessThan(CLUSTER_SIMILARITY_TAU);
    });
    it('is symmetric a↔b', () => {
      const a = '기능이 라우트에 존재한다고 완성으로 판단하지 말 것';
      const b = '기능 동작을 단정하기 전에 실제 환경을 먼저 확인하라';
      expect(policySimilarity(a, b)).toBeCloseTo(policySimilarity(b, a), 6);
    });
    it('empty tags → 0', () => {
      expect(policySimilarity('', 'anything here')).toBe(0);
    });
  });

  describe('clusterCorrectionRules', () => {
    it('groups same-principle rules in one axis into a cluster (size≥2)', () => {
      const rules = [
        rule('a', 'quality', '완료 선언 전에 실제 동작을 검증하라 프로덕션 환경 확인'),
        rule('b', 'quality', '완료 선언 전 실제 검증 필수 라우트 존재만으로 완성 판단 금지'),
        rule('c', 'quality', '실제 동작 검증 후에만 완료 선언 프로덕션 확인 필수'),
      ];
      const clusters = clusterCorrectionRules(rules);
      expect(clusters.length).toBe(1);
      expect(clusters[0].members.length).toBe(3);
      expect(clusters[0].strength).toBe('strong');
      expect(clusters[0].confidence).toBeCloseTo(0.8, 2);
      // evidence union
      expect(clusters[0].evidenceRefs.sort()).toEqual(['ev-a', 'ev-b', 'ev-c']);
    });

    it('confidence uses correction-observation count (evidence), not rule-object count', () => {
      // one member is an already-merged rule carrying 3 evidence refs; another is a raw rule.
      // observation count = 4 (not 2 members) → laplace(4) = 0.83, not laplace(2) = 0.75.
      const rules = [
        { rule_id: 'merged1', category: 'quality', policy: '완료 선언 전에 실제 동작을 검증하라 프로덕션 환경 확인', strength: 'strong' as const, evidence_refs: ['e1', 'e2', 'e3'] },
        rule('d', 'quality', '완료 선언 전 실제 검증 필수 라우트 존재만으로 완성 판단 금지'),
      ];
      const clusters = clusterCorrectionRules(rules);
      expect(clusters.length).toBe(1);
      expect(clusters[0].confidence).toBeCloseTo(laplaceConfidence(4), 2); // 4 observations
      expect(clusters[0].evidenceRefs.sort()).toEqual(['e1', 'e2', 'e3', 'ev-d']);
    });

    it('does not cluster across different axes', () => {
      const rules = [
        rule('a', 'quality', '완료 선언 전 실제 검증 프로덕션 확인'),
        rule('b', 'communication', '완료 선언 전 실제 검증 프로덕션 확인'), // same text, different axis
      ];
      expect(clusterCorrectionRules(rules).length).toBe(0);
    });

    it('does not cluster unrelated rules', () => {
      const rules = [
        rule('a', 'workflow', '사이드바 네비게이션에 shrink-0 필수 적용'),
        rule('b', 'workflow', 'npm publish 는 완성도 도달 시에만 진행'),
      ];
      expect(clusterCorrectionRules(rules).length).toBe(0);
    });

    it('excludes hard rules from clustering (safety rules never merged)', () => {
      const rules = [
        rule('a', 'safety', 'rm -rf 는 사용자 확인 없이 실행 금지 위험 명령', { strength: 'hard' }),
        rule('b', 'safety', 'rm -rf 는 사용자 확인 없이 실행 금지 위험 명령', { strength: 'hard' }),
      ];
      expect(clusterCorrectionRules(rules).length).toBe(0);
    });

    it('respects suppression list (unmerged combos not re-clustered)', () => {
      const rules = [
        rule('a', 'quality', '완료 선언 전에 실제 동작을 검증하라 프로덕션 환경 확인'),
        rule('b', 'quality', '완료 선언 전 실제 검증 필수 라우트 존재만으로 완성 판단 금지'),
      ];
      const suppressed = new Set([clusterKey(rules)]);
      expect(clusterCorrectionRules(rules, suppressed).length).toBe(0);
      // without suppression, it would cluster
      expect(clusterCorrectionRules(rules).length).toBe(1);
    });

    it('subset-aware suppression: rejected {a,b} blocks superset {a,b,c} (whack-a-mole)', () => {
      const rules = [
        rule('a', 'quality', '완료 선언 전에 실제 동작을 검증하라 프로덕션 환경 확인'),
        rule('b', 'quality', '완료 선언 전 실제 검증 필수 라우트 존재만으로 완성 판단 금지'),
        rule('c', 'quality', '실제 동작 검증 후에만 완료 선언 프로덕션 확인 필수'),
      ];
      // user previously unmerged {a,b}
      const suppressed = new Set(['a|b']);
      // now a new similar correction c arrives → {a,b,c} must NOT re-form
      expect(clusterCorrectionRules(rules, suppressed).length).toBe(0);
    });

    it('skips too-short policies (insufficient tag signal)', () => {
      const rules = [
        rule('a', 'quality', 'x'),
        rule('b', 'quality', 'y'),
      ];
      expect(clusterCorrectionRules(rules).length).toBe(0);
    });

    it('empty / single input → no clusters', () => {
      expect(clusterCorrectionRules([]).length).toBe(0);
      expect(clusterCorrectionRules([rule('a', 'quality', '완료 선언 전 실제 검증 프로덕션')]).length).toBe(0);
    });
  });

  describe('clusterKey — stable regardless of order', () => {
    it('same members different order → same key', () => {
      const k1 = clusterKey([{ rule_id: 'b' }, { rule_id: 'a' }, { rule_id: 'c' }]);
      const k2 = clusterKey([{ rule_id: 'a' }, { rule_id: 'c' }, { rule_id: 'b' }]);
      expect(k1).toBe(k2);
      expect(k1).toBe('a|b|c');
    });
  });
});
