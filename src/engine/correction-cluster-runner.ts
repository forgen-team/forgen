/**
 * correction-cluster-runner — W3-2 클러스터링 실행 (파일 IO / 룰 저장 / 훅 연결).
 * 순수 로직은 correction-clustering.ts. 여기서만 rule-store 를 건드린다.
 *
 * 흐름 (세션종료 시 auto-compound-runner:promoteSessionCandidates 직후 호출):
 *   1. me-scope active explicit_correction 룰(비-hard) 로드
 *   2. 억제목록 로드 → clusterCorrectionRules
 *   3. 각 클러스터: T5 내부 모순이면 스킵(conflict 우선), 아니면 통합 rule 생성 +
 *      원본 superseded + clustered_into 링크
 *   4. 통합 요약 반환(호출측이 알림)
 *
 * unmerge: 통합 rule 제거 + 원본 active 복원 + 조합을 억제목록에 추가(재통합 방지).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../core/logger.js';
import { STATE_DIR } from '../core/paths.js';
import { atomicWriteJSON, safeReadJSON } from '../hooks/shared/atomic-write.js';
import { withFileLock } from '../hooks/shared/file-lock.js';
import { createRule, loadAllRules, loadRule, saveRule } from '../store/rule-store.js';
import type { Rule } from '../store/types.js';
import {
  type ClusterableRule,
  type CorrectionCluster,
  clusterCorrectionRules,
  clusterKey,
  findMostSimilarRule,
  isSuppressedCluster,
  mergeAcrossCategories,
} from './correction-clustering.js';

const log = createLogger('correction-cluster');

const SUPPRESSION_PATH = path.join(STATE_DIR, 'cluster-suppression.json');
/** 동시 세션종료 클러스터링 직렬화용 락 대상 경로(SEV-3 #4). */
const CLUSTER_LOCK_PATH = path.join(STATE_DIR, 'cluster-run');

interface SuppressionState {
  /** unmerge 된 클러스터 조합 키(정렬 rule_id join) — 재통합 금지. */
  keys: string[];
}

function loadSuppression(): Set<string> {
  const st = safeReadJSON<SuppressionState | null>(SUPPRESSION_PATH, null);
  return new Set(st?.keys ?? []);
}

function saveSuppression(keys: Set<string>): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJSON(SUPPRESSION_PATH, { keys: [...keys] } satisfies SuppressionState);
  } catch (e) {
    log.debug('cluster-suppression 저장 실패', e);
  }
}

function toClusterable(r: Rule): ClusterableRule {
  return {
    rule_id: r.rule_id,
    category: r.category,
    policy: r.policy,
    strength: r.strength,
    evidence_refs: r.evidence_refs ?? [],
  };
}

/**
 * render_key for a merged cluster rule: `category.cluster.<slug>-<hash>`.
 * 리뷰 SEV-3: slug(30자 접두)만으로는 두 별개 클러스터가 같은 slug 를 가질 때
 * dedupeByRenderKey 가 하나를 조용히 드롭(교정 소실)할 수 있다. clusterKey 해시를
 * 접미해 통합룰 render_key 를 무조건 유니크화 → 충돌 원천봉쇄(가독성 유지).
 */
function mergedRenderKey(cluster: CorrectionCluster): string {
  const category = cluster.members[0]?.category ?? 'workflow';
  const slug = cluster.representativePolicy
    .toLowerCase()
    .replace(/[^가-힣a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 30);
  const hash = crypto
    .createHash('sha1')
    .update(clusterKey(cluster.members))
    .digest('hex')
    .slice(0, 8);
  return `${category}.cluster.${slug}-${hash}`;
}

/** 통합(cluster-merge) 룰인지 — render_key 의 `.cluster.` 인픽스로 식별(내부 생성만 사용). */
function isClusterMergedRule(r: Rule): boolean {
  return r.render_key.includes('.cluster.');
}

export interface ClusterMergeResult {
  /** 통합 rule_id. */
  mergedRuleId: string;
  /** 통합된 원본 rule_id 들. */
  memberIds: string[];
  category: string;
  strength: string;
  confidence: number;
  policy: string;
}

/**
 * 세션종료 클러스터링 실행. 통합 발생 시 각 통합 요약 배열 반환(빈 배열이면 no-op).
 * 자동 실행이므로 조용하지 않게 — 호출측이 결과를 stderr/알림으로 노출한다.
 */
export async function runCorrectionClustering(): Promise<ClusterMergeResult[]> {
  // 리뷰 SEV-3 #4: auto-compound 는 세션별 detached 실행이라 두 세션 동시 종료 시
  // 병렬 진입 가능 → 같은 후보로 각자 통합룰 생성/last-write-wins 불일치. 파일락으로
  // 클러스터링 임계구역을 직렬화한다. fail-open(락 실패는 예외 → 호출측 catch).
  fs.mkdirSync(STATE_DIR, { recursive: true }); // 락 파일 생성 전 상태 디렉터리 보장
  return withFileLock(CLUSTER_LOCK_PATH, () => runCorrectionClusteringLocked());
}

async function runCorrectionClusteringLocked(): Promise<ClusterMergeResult[]> {
  const all = loadAllRules();
  const candidates = all.filter(
    (r) =>
      r.scope === 'me' &&
      r.status === 'active' &&
      r.source === 'explicit_correction' &&
      r.strength !== 'hard',
  );
  if (candidates.length < 2) return [];

  const suppressed = loadSuppression();
  const clusters = clusterCorrectionRules(candidates.map(toClusterable), suppressed);
  if (clusters.length === 0) return [];

  // T5 내부 모순 확인용 detector (동적 import — 순환 의존 회피).
  const { detect: detectT5 } = await import('./lifecycle/trigger-t5-conflict.js');

  const results: ClusterMergeResult[] = [];

  for (const cluster of clusters) {
    const memberRules = cluster.members
      .map((m) => candidates.find((c) => c.rule_id === m.rule_id))
      .filter((r): r is Rule => Boolean(r));
    if (memberRules.length < 2) continue;

    // 클러스터 내부에 T5 모순(상반 교정)이 있으면 통합하지 않는다 — conflict 해소 우선.
    const conflicts = detectT5({ rules: memberRules });
    if (conflicts.length > 0) {
      log.debug(`클러스터 통합 스킵(T5 모순): ${clusterKey(cluster.members)}`);
      continue;
    }

    const category = memberRules[0].category;

    // 리뷰 SEV-3 #2: 클러스터에 이미 통합룰이 있으면 새 M2 를 만들지 않고 *기존 통합룰에
    // 흡수*한다(supersession 체인 방지). evidence/강도/policy 를 갱신하고 신규 멤버만
    // superseded. 없으면 새 통합룰 생성.
    const existingMerged = memberRules.filter(isClusterMergedRule);
    let mergedId: string;
    let absorbed: Rule[];

    if (existingMerged.length > 0) {
      const absorber = existingMerged[0];
      absorber.status = 'active';
      absorber.clustered_into = undefined;
      absorber.policy = cluster.representativePolicy;
      absorber.strength = cluster.strength;
      absorber.evidence_refs = cluster.evidenceRefs;
      saveRule(absorber);
      mergedId = absorber.rule_id;
      absorbed = memberRules.filter((r) => r.rule_id !== absorber.rule_id);
    } else {
      const merged = createRule({
        category,
        scope: 'me',
        trigger: memberRules[0].trigger,
        policy: cluster.representativePolicy,
        strength: cluster.strength,
        source: 'explicit_correction',
        evidence_refs: cluster.evidenceRefs,
        render_key: mergedRenderKey(cluster),
      });
      saveRule(merged);
      mergedId = merged.rule_id;
      absorbed = memberRules;
    }

    // 흡수된 원본은 삭제하지 않고 superseded + clustered_into 링크(unmerge 복원 가능).
    for (const orig of absorbed) {
      orig.status = 'superseded';
      orig.clustered_into = mergedId;
      saveRule(orig);
    }

    results.push({
      mergedRuleId: mergedId,
      memberIds: absorbed.map((r) => r.rule_id),
      category,
      strength: cluster.strength,
      confidence: cluster.confidence,
      policy: cluster.representativePolicy,
    });
    log.debug(`클러스터 통합: +${absorbed.length}룰 → ${mergedId} (${cluster.strength})`);
  }

  return results;
}

export interface UnmergeResult {
  ok: boolean;
  restored: string[];
  reason?: string;
}

/**
 * 통합 취소: 통합 rule 을 removed 처리하고 원본 룰을 active 복원, 조합을 억제목록에 추가.
 * 억제로 인해 다음 세션종료에 같은 조합이 재통합되지 않는다.
 *
 * ADR-017 D3: 대상이 *explicit 링크 타깃*(채굴 룰이 `clustered_into` 로 가리키는 explicit
 * 룰 — 통합 산물이 아님)이면 explicit 룰은 removed 하지 않고 링크만 푼다(related_to 제거,
 * mined_observations 차감). 채굴끼리 통합한 `auto:…cluster…` 룰은 기존 경로대로 removed.
 */
export function unmergeCluster(mergedRuleId: string): UnmergeResult {
  const merged = loadRule(mergedRuleId);
  if (!merged) return { ok: false, restored: [], reason: `통합 rule 없음: ${mergedRuleId}` };

  const all = loadAllRules();
  const members = all.filter((r) => r.clustered_into === mergedRuleId);
  if (members.length === 0) {
    return { ok: false, restored: [], reason: '이 통합 rule 에 연결된 원본이 없음' };
  }

  for (const orig of members) {
    orig.status = 'active';
    orig.clustered_into = undefined;
    orig.related_to = undefined;
    saveRule(orig);
  }

  const linkedMined = members.filter((r) => isMinedRule(r));
  // 링크 타깃 판정: 통합 산물이 아니면서(=explicit 소스) 채굴 멤버만 달려 있는 explicit 룰.
  const isLinkTarget = !isMinedRule(merged) && linkedMined.length === members.length;

  if (isLinkTarget) {
    detachMinedLinks(merged, linkedMined);
  } else {
    // 통합 산물이 explicit 클러스터 룰이고 채굴 링크도 달려 있던 혼합 케이스: 채굴 링크는
    // 위에서 이미 복원됐으므로 카운터만 정리하고 통합 룰은 기존대로 removed.
    if (linkedMined.length > 0) detachMinedLinks(merged, linkedMined);
    merged.status = 'removed';
    saveRule(merged);
  }

  // 이 조합을 억제목록에 추가 → 재통합/재링크 방지. 링크는 (채굴, explicit) 쌍 단위로 억제해
  // 다른 채굴 룰의 링크나 채굴끼리 통합에는 영향을 주지 않는다(isSuppressedCluster 의
  // 부분집합 판정은 2원소 쌍과 다른 조합 사이에 교차하지 않음).
  const suppressed = loadSuppression();
  if (isLinkTarget) {
    for (const m of linkedMined) suppressed.add(clusterKey([m, merged]));
  } else {
    suppressed.add(clusterKey(members));
  }
  saveSuppression(suppressed);

  return { ok: true, restored: members.map((r) => r.rule_id) };
}

function detachMinedLinks(explicitRule: Rule, mined: Rule[]): void {
  const ids = new Set(mined.map((m) => m.rule_id));
  const related = (explicitRule.related_to ?? []).filter((id) => !ids.has(id));
  explicitRule.related_to = related.length > 0 ? related : undefined;
  const decrement = mined.reduce((n, m) => n + minedObservationCount(m), 0);
  const next = Math.max(0, (explicitRule.mined_observations ?? 0) - decrement);
  explicitRule.mined_observations = next > 0 ? next : undefined;
  saveRule(explicitRule);
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR-017 D3 — 채굴 룰 병합 (채굴끼리만 · explicit 과는 링크만)
//
// 불변식(ADR-013, D3 원문):
//   - explicit 룰로의 흡수 금지. 채굴 evidence 는 explicit 의 evidence_refs 에 합산하지 않고
//     strength 도 건드리지 않는다 — `mined_observations` 카운터만 올린다.
//   - 채굴끼리 통합 룰은 strength 'default' 고정, source 'behavior_inference', render_key
//     'auto:' 네임스페이스 유지, enforce_via [] (advisory-only).
//   - 통합 룰의 created_at 은 가장 오래된 원본(TTL carry-forward, 재채굴로 TTL 연장 금지).
//   - 원본은 superseded + clustered_into 로 보존 → unmergeCluster 로 왕복.
// ─────────────────────────────────────────────────────────────────────────────

const AUTO_MINED_PREFIX = 'auto:';

function isMinedRule(r: Rule): boolean {
  return r.source === 'behavior_inference' && r.render_key.startsWith(AUTO_MINED_PREFIX);
}

/** 채굴 룰 1개가 대표하는 관측 횟수 — evidence 수(최소 1). */
function minedObservationCount(r: Rule): number {
  return Math.max(1, r.evidence_refs?.length ?? 0);
}

export interface MinedExplicitLink {
  minedRuleId: string;
  minedPolicy: string;
  explicitRuleId: string;
  explicitPolicy: string;
  similarity: number;
  /** 링크 시 explicit.mined_observations 에 더해질 관측 수. */
  observations: number;
}

export interface MinedClusterPlan {
  category: Rule['category'];
  /** 통합 대상 원본(기존 통합 룰이 있으면 그 룰은 absorberId 로 분리되고 여기엔 신규만). */
  memberIds: string[];
  memberPolicies: string[];
  representativePolicy: string;
  /** 가장 오래된 원본 created_at — 통합 룰의 created_at. */
  oldestCreatedAt: string;
  /** 클러스터 안에 이미 통합 룰이 있으면 그 rule_id(흡수, 체인 방지). */
  absorberId?: string;
}

export interface MinedMergePlan {
  /** 계획 수립 시점의 active 채굴 룰 수. */
  totalMined: number;
  explicitLinks: MinedExplicitLink[];
  clusters: MinedClusterPlan[];
  /** 적용 후 예상 active 채굴 룰 수 = total − 링크 − Σ멤버 + 신규 통합 룰 수. */
  projectedMined: number;
}

export interface MinedMergeApplyResult {
  linked: number;
  mergedRuleIds: string[];
  supersededIds: string[];
}

/** 멤버 다수결 category — 동수면 관측(evidence) 합이 큰 쪽, 그래도 같으면 먼저 나온 쪽. */
function majorityCategory(members: Rule[]): Rule['category'] {
  const tally = new Map<Rule['category'], { count: number; obs: number }>();
  for (const m of members) {
    const t = tally.get(m.category) ?? { count: 0, obs: 0 };
    t.count++;
    t.obs += minedObservationCount(m);
    tally.set(m.category, t);
  }
  let best = members[0].category;
  let bt = tally.get(best) as { count: number; obs: number };
  for (const [cat, t] of tally) {
    if (t.count > bt.count || (t.count === bt.count && t.obs > bt.obs)) {
      best = cat;
      bt = t;
    }
  }
  return best;
}

/**
 * 병합 계획(읽기 전용). 순서: (1) explicit 동개념 링크 → (2) 남은 채굴 룰끼리 클러스터.
 * explicit 매칭은 1:1 최고점(category 무시). 채굴끼리는 2단: 1차 clusterCorrectionRules
 * (category 경계 유지 — 전이 연결이 category 를 넘으면 무관한 개념까지 한 덩어리가 된다는
 * 실측에 근거) → 2차 mergeAcrossCategories(더 높은 임계 + 대표 policy 직접 유사도만 사용).
 */
export function planMinedRuleMerge(): MinedMergePlan {
  const all = loadAllRules();
  const activeMe = all.filter((r) => r.scope === 'me' && r.status === 'active');
  const mined = activeMe.filter(isMinedRule);
  const explicit = activeMe.filter((r) => !isMinedRule(r) && r.source !== 'behavior_inference');
  const suppressed = loadSuppression();

  const explicitLinks: MinedExplicitLink[] = [];
  const linkedIds = new Set<string>();
  for (const m of mined) {
    // 이미 통합된 채굴 클러스터 룰은 explicit 에 링크하지 않는다 — 멤버가 딸려 있어
    // 링크 unmerge 가 멤버 복원까지 번진다. 원본 단위로만 링크.
    if (isClusterMergedRule(m)) continue;
    const eligible = explicit.filter((e) => !isSuppressedCluster([m, e], suppressed));
    const best = findMostSimilarRule(m.policy, eligible);
    if (!best) continue;
    explicitLinks.push({
      minedRuleId: m.rule_id,
      minedPolicy: m.policy,
      explicitRuleId: best.rule.rule_id,
      explicitPolicy: best.rule.policy,
      similarity: best.similarity,
      observations: minedObservationCount(m),
    });
    linkedIds.add(m.rule_id);
  }

  const remaining = mined.filter((r) => !linkedIds.has(r.rule_id));
  const byId = new Map(remaining.map((r) => [r.rule_id, r]));

  // 1차: category 내 클러스터. 2차: 1차 결과 + 잔여 단독 룰을 category 무관하게 대표 유사도로 병합.
  const primary = clusterCorrectionRules(remaining.map(toClusterable), suppressed);
  const inPrimary = new Set(primary.flatMap((c) => c.members.map((m) => m.rule_id)));
  const units: Rule[][] = primary.map((c) =>
    c.members.map((m) => byId.get(m.rule_id)).filter((r): r is Rule => Boolean(r)),
  );
  for (const r of remaining) {
    if (inPrimary.has(r.rule_id) || r.strength === 'hard' || (r.policy?.length ?? 0) < 10) continue;
    units.push([r]);
  }
  const groups = mergeAcrossCategories(units, suppressed);

  const clusters: MinedClusterPlan[] = [];
  for (const memberRules of groups) {
    if (memberRules.length < 2) continue;
    // 기존 통합 룰이 여럿이면 관측이 가장 많은 것이 흡수자, 나머지는 신규 멤버로 흡수된다
    // (2단 트리: 원본→옛 통합 룰→흡수자. unmerge 시 옛 통합 룰이 그대로 복원된다).
    const absorber = memberRules
      .filter(isClusterMergedRule)
      .sort((a, b) => minedObservationCount(b) - minedObservationCount(a))[0];
    const fresh = absorber
      ? memberRules.filter((r) => r.rule_id !== absorber.rule_id)
      : memberRules;
    if (fresh.length === 0) continue;
    clusters.push({
      category: majorityCategory(memberRules),
      memberIds: fresh.map((r) => r.rule_id),
      memberPolicies: fresh.map((r) => r.policy),
      representativePolicy: memberRules
        .map((r) => r.policy)
        .reduce((a, b) => (b.length > a.length ? b : a)),
      oldestCreatedAt: memberRules
        .map((r) => r.created_at)
        .reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)),
      absorberId: absorber?.rule_id,
    });
  }

  const superseded = clusters.reduce((n, c) => n + c.memberIds.length, 0);
  const newMerged = clusters.filter((c) => !c.absorberId).length;
  return {
    totalMined: mined.length,
    explicitLinks,
    clusters,
    projectedMined: mined.length - explicitLinks.length - superseded + newMerged,
  };
}

/**
 * 채굴 룰 병합 실행. apply=false 면 계획만 반환(파일 변경 없음).
 * apply=true 면 클러스터 락 안에서 계획을 *다시* 수립해 적용한다(dry-run 과 apply 사이의
 * 상태 변화로 stale 계획이 적용되는 것을 막는다).
 */
export async function runMinedRuleMerge(opts: { apply: boolean }): Promise<{
  plan: MinedMergePlan;
  applied: MinedMergeApplyResult | null;
}> {
  if (!opts.apply) return { plan: planMinedRuleMerge(), applied: null };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return withFileLock(CLUSTER_LOCK_PATH, async () => {
    const plan = planMinedRuleMerge();
    const applied = await applyMinedRuleMergePlan(plan);
    return { plan, applied };
  });
}

async function applyMinedRuleMergePlan(plan: MinedMergePlan): Promise<MinedMergeApplyResult> {
  const result: MinedMergeApplyResult = { linked: 0, mergedRuleIds: [], supersededIds: [] };

  // (1) explicit 링크 — 채굴 룰은 superseded+clustered_into(explicit), explicit 은 카운터만.
  for (const link of plan.explicitLinks) {
    const mined = loadRule(link.minedRuleId);
    const explicit = loadRule(link.explicitRuleId);
    if (!mined || !explicit || mined.status !== 'active' || explicit.status !== 'active') continue;
    linkMinedToExplicit(mined, explicit);
    result.linked++;
    result.supersededIds.push(mined.rule_id);
  }

  // (2) 채굴끼리 통합.
  const { detect: detectT5 } = await import('./lifecycle/trigger-t5-conflict.js');
  for (const cluster of plan.clusters) {
    const fresh = cluster.memberIds
      .map((id) => loadRule(id))
      .filter((r): r is Rule => Boolean(r) && r?.status === 'active');
    if (fresh.length === 0) continue;
    const absorber = cluster.absorberId ? loadRule(cluster.absorberId) : null;
    if (!absorber && fresh.length < 2) continue;

    // 상반 교정이 한 클러스터에 있으면 통합하지 않는다(explicit 경로와 동일).
    const conflicts = detectT5({ rules: absorber ? [absorber, ...fresh] : fresh });
    if (conflicts.length > 0) {
      log.debug(`채굴 클러스터 통합 스킵(T5 모순): ${clusterKey(fresh)}`);
      continue;
    }

    const evidenceRefs = Array.from(
      new Set([...(absorber?.evidence_refs ?? []), ...fresh.flatMap((r) => r.evidence_refs ?? [])]),
    );
    const oldestCreatedAt = [absorber, ...fresh]
      .filter((r): r is Rule => Boolean(r))
      .map((r) => r.created_at)
      .reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));

    let mergedId: string;
    if (absorber) {
      absorber.status = 'active';
      absorber.clustered_into = undefined;
      absorber.policy = cluster.representativePolicy;
      absorber.category = cluster.category;
      absorber.strength = 'default';
      absorber.evidence_refs = evidenceRefs;
      absorber.created_at = oldestCreatedAt;
      absorber.enforce_via = [];
      saveRule(absorber);
      mergedId = absorber.rule_id;
    } else {
      const merged = createRule({
        category: cluster.category,
        scope: 'me',
        trigger: fresh[0].trigger,
        policy: cluster.representativePolicy,
        strength: 'default',
        source: 'behavior_inference',
        evidence_refs: evidenceRefs,
        render_key: `${AUTO_MINED_PREFIX}${mergedRenderKey({
          members: fresh.map(toClusterable),
          representativePolicy: cluster.representativePolicy,
          confidence: 0,
          strength: 'default',
          evidenceRefs,
        })}`,
      });
      merged.created_at = oldestCreatedAt; // TTL carry-forward — 통합으로 수명 연장 금지
      merged.enforce_via = []; // advisory-only 유지
      saveRule(merged);
      mergedId = merged.rule_id;
      result.mergedRuleIds.push(mergedId);
    }

    for (const orig of fresh) {
      orig.status = 'superseded';
      orig.clustered_into = mergedId;
      saveRule(orig);
      result.supersededIds.push(orig.rule_id);
    }
    log.debug(`채굴 클러스터 통합: +${fresh.length}룰 → ${mergedId}`);
  }

  return result;
}

/**
 * 채굴 룰 ↔ explicit 룰 링크(흡수 아님). evidence_refs/strength 는 양쪽 모두 불변.
 * promoteSessionCandidates 의 사전 중복 검사(explicit 매칭)와 병합 실행이 공유한다.
 */
export function linkMinedToExplicit(mined: Rule, explicit: Rule): void {
  mined.status = 'superseded';
  mined.clustered_into = explicit.rule_id;
  mined.related_to = [explicit.rule_id];
  saveRule(mined);
  recordMinedObservation(explicit, minedObservationCount(mined), mined.rule_id);
}

/**
 * explicit 룰에 "채굴 관측 N회" 를 기록한다. evidence_refs 에는 절대 합산하지 않는다 —
 * 합산하면 laplaceConfidence 경로로 환각 교정 1건이 explicit 을 strong 으로 올릴 수 있다
 * (ADR-017 D3 기각 사유). strength 도 건드리지 않는다.
 */
export function recordMinedObservation(explicit: Rule, count: number, minedRuleId?: string): void {
  explicit.mined_observations = (explicit.mined_observations ?? 0) + count;
  if (minedRuleId) {
    const related = new Set(explicit.related_to ?? []);
    related.add(minedRuleId);
    explicit.related_to = [...related];
  }
  saveRule(explicit);
}
