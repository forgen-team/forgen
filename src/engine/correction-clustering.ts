/**
 * correction-clustering — 교정 룰 클러스터링 → 통합 승급 (Wave 3 W3-2).
 * 설계: reports/feature-audit/w3-2-design.md
 *
 * 문제: 같은 원칙을 문구·target 만 바꿔 N회 교정하면, promoteSessionCandidates 가
 * render_key(정확 중복)만 dedup 하므로 N개 별도 `default` 룰로 흩어진다. "사용자가
 * N번 교정했다"는 강한 개인화 신호(강도↑)가 소실된다.
 *
 * 델타 (기존 파이프라인엔 없는 2개만):
 *   D1. 의미 클러스터링 — 같은 axis 내 교정 룰을 유사도로 묶는다.
 *   D2. 반복 → 강도 — 클러스터 크기 N 을 Laplace 계승법칙 confidence 로 환산해 강도 tier 결정.
 *
 * 근거 (임의 상수 아님):
 *   - τ=0.3: `solution-injector.MIN_INJECT_RELEVANCE`(동일 relevance-scorer 표현에 2026-04-21
 *     gate sweep 으로 실측 튜닝된 게이트)을 상속.
 *   - confidence=(s+1)/(s+f+2): Laplace 계승법칙(1814) / Beta-Bernoulli 사후평균.
 *
 * 이 모듈은 *순수 로직*만 담는다 — 파일 IO/룰 저장/훅 연결은 호출측(correction-cluster-runner).
 */

import type { RuleStrength } from '../store/types.js';
import { statusConfidence } from './compound-lifecycle.js';
import { RELEVANCE_MATCH_GATE } from './relevance-gate.js';
import { calculateRelevance } from './relevance-scorer.js';
import { extractTags } from './solution-format.js';

/** τ — 클러스터 편입 유사도 임계. 정준 게이트(RELEVANCE_MATCH_GATE=0.3)를 코드로 상속. */
export const CLUSTER_SIMILARITY_TAU = RELEVANCE_MATCH_GATE;

/** 강도 승급 컷오프 — statusConfidence('verified')=0.75 를 코드로 상속(리터럴 복제 아님). */
const STRONG_CONFIDENCE_CUTOFF = statusConfidence('verified');

/** 클러스터 대상이 되는 최소 정책 텍스트 길이(너무 짧으면 tag 신호 부족). */
const MIN_POLICY_LEN = 10;

/** 클러스터링 입력: 룰의 최소 표현(순수 로직이 파일/스토어에 의존하지 않도록). */
export interface ClusterableRule {
  rule_id: string;
  /** 클러스터는 같은 category(=axis) 안에서만 형성된다. */
  category: string;
  policy: string;
  strength: RuleStrength;
  evidence_refs: string[];
}

export interface CorrectionCluster {
  /** 통합 대상 룰들(크기 ≥ 2). */
  members: ClusterableRule[];
  /** 대표 정책(가장 긴 policy — 보통 가장 서술적). 통합 룰의 policy 후보. */
  representativePolicy: string;
  /** Laplace 계승법칙 confidence = (N+1)/(N+2). */
  confidence: number;
  /** confidence → 강도 tier. hard 로는 절대 자동 도달하지 않는다. */
  strength: RuleStrength;
  /** 통합 룰의 evidence_refs(멤버 union). */
  evidenceRefs: string[];
}

/**
 * 두 정책 텍스트의 대칭 유사도. calculateRelevance 는 비대칭(prompt→solution)이라
 * 양방향 평균으로 대칭화한다. confidence 인자는 1(순수 태그 매치만 보고 싶음).
 */
export function policySimilarity(a: string, b: string): number {
  const tagsA = extractTags(a);
  const tagsB = extractTags(b);
  if (tagsA.length === 0 || tagsB.length === 0) return 0;
  const ab = calculateRelevance(tagsA, tagsB, 1) as { relevance: number };
  const ba = calculateRelevance(tagsB, tagsA, 1) as { relevance: number };
  return (ab.relevance + ba.relevance) / 2;
}

/**
 * Laplace 계승법칙 (rule of succession, 1814).
 * s = 일관 교정 횟수, f = 모순(반박) 횟수. 지속 선호일 사후평균 = (s+1)/(s+f+2).
 * N회 일관·모순0 → (N+1)/(N+2): N=1→0.67, N=2→0.75, N=3→0.80, N=5→0.86.
 */
export function laplaceConfidence(successes: number, failures = 0): number {
  return (successes + 1) / (successes + failures + 2);
}

/**
 * confidence → 강도 tier. statusConfidence 밴드(verified=0.75)에 매핑.
 * confidence ≥ 0.75 (= N≥2 일관교정) → strong. 그 미만 → default.
 * hard 는 confidence 로 자동 도달하지 않는다 — L1 안전룰 전용(오탐 시 세션 차단 위험).
 */
export function strengthForConfidence(confidence: number): RuleStrength {
  return confidence >= STRONG_CONFIDENCE_CUTOFF ? 'strong' : 'default';
}

/**
 * 같은 category(axis) 내 룰들을 유사도 그래프의 connected component 로 클러스터링.
 * 크기 ≥ 2 인 클러스터만 반환. hard 룰은 후보에서 제외(안전룰은 통합 대상 아님).
 *
 * @param rules 후보 룰들(호출측이 me-scope active explicit_correction 로 필터해서 전달)
 * @param suppressed 억제 조합 키 집합(unmerge 된 조합 재통합 방지) — 정렬된 rule_id join
 */
export function clusterCorrectionRules(
  rules: ClusterableRule[],
  suppressed: ReadonlySet<string> = new Set(),
): CorrectionCluster[] {
  const eligible = rules.filter(
    (r) => r.strength !== 'hard' && (r.policy?.length ?? 0) >= MIN_POLICY_LEN,
  );

  // category 별 그룹핑 — 클러스터는 axis 경계를 넘지 않는다.
  const byCategory = new Map<string, ClusterableRule[]>();
  for (const r of eligible) {
    const arr = byCategory.get(r.category) ?? [];
    arr.push(r);
    byCategory.set(r.category, arr);
  }

  const clusters: CorrectionCluster[] = [];

  for (const group of byCategory.values()) {
    if (group.length < 2) continue;

    // Union-Find over the group by pairwise similarity ≥ τ.
    const parent = group.map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (policySimilarity(group[i].policy, group[j].policy) >= CLUSTER_SIMILARITY_TAU) {
          union(i, j);
        }
      }
    }

    // component 수집
    const components = new Map<number, ClusterableRule[]>();
    for (let i = 0; i < group.length; i++) {
      const root = find(i);
      const arr = components.get(root) ?? [];
      arr.push(group[i]);
      components.set(root, arr);
    }

    for (const members of components.values()) {
      if (members.length < 2) continue;
      // 억제된 조합이면 스킵. 정확 일치뿐 아니라 *부분집합/상위집합*도 억제 —
      // {a,b,c} 를 unmerge 했는데 유사교정 d 도착으로 {a,b,c,d} 가 재통합되는
      // whack-a-mole 방지 (리뷰 SEV-3 #3).
      if (isSuppressedCluster(members, suppressed)) continue;

      const representativePolicy = members
        .map((m) => m.policy)
        .reduce((a, b) => (b.length > a.length ? b : a));
      const evidenceRefs = Array.from(new Set(members.flatMap((m) => m.evidence_refs ?? [])));

      // Laplace 의 N = *교정 관측 횟수* = 고유 evidence 수 (룰 객체 수가 아님).
      // raw 교정 룰은 evidence 1개씩이라 base case 는 members.length 와 동일하지만,
      // 이미 통합된 룰이 재-클러스터될 때(evidence 다수 보유) 반복 횟수를 정확히 누적한다.
      const observationCount = Math.max(evidenceRefs.length, members.length);
      const confidence = laplaceConfidence(observationCount);

      clusters.push({
        members,
        representativePolicy,
        confidence,
        strength: strengthForConfidence(confidence),
        evidenceRefs,
      });
    }
  }

  return clusters;
}

/** 클러스터 멤버 집합의 안정 키(정렬된 rule_id join) — 억제 목록/식별용. */
export function clusterKey(members: Array<{ rule_id: string }>): string {
  return members
    .map((m) => m.rule_id)
    .sort()
    .join('|');
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * 이 클러스터가 억제 대상인지 — 정확 일치뿐 아니라 부분집합/상위집합 관계도 억제한다.
 * 사용자가 거부한 조합(억제키)이 현재 클러스터에 포함(S⊆cur)되거나 현재 클러스터가
 * 거부 조합의 일부(cur⊆S)면 재통합하지 않는다. 데이터 손실 없음(안 묶으면 흩어진 채 유지).
 */
export function isSuppressedCluster(
  members: Array<{ rule_id: string }>,
  suppressed: ReadonlySet<string>,
): boolean {
  if (suppressed.size === 0) return false;
  const cur = new Set(members.map((m) => m.rule_id));
  for (const key of suppressed) {
    if (!key) continue;
    const s = new Set(key.split('|'));
    if (isSubset(s, cur) || isSubset(cur, s)) return true;
  }
  return false;
}
