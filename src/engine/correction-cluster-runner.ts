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

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../core/logger.js';
import { STATE_DIR } from '../core/paths.js';
import { atomicWriteJSON, safeReadJSON } from '../hooks/shared/atomic-write.js';
import { createRule, loadAllRules, loadRule, saveRule } from '../store/rule-store.js';
import type { Rule } from '../store/types.js';
import {
  type ClusterableRule,
  type CorrectionCluster,
  clusterCorrectionRules,
  clusterKey,
} from './correction-clustering.js';

const log = createLogger('correction-cluster');

const SUPPRESSION_PATH = path.join(STATE_DIR, 'cluster-suppression.json');

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

/** render_key for a merged cluster rule (category.cluster.<stable slug>). */
function mergedRenderKey(cluster: CorrectionCluster): string {
  const category = cluster.members[0]?.category ?? 'workflow';
  const slug = cluster.representativePolicy
    .toLowerCase()
    .replace(/[^가-힣a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 30);
  return `${category}.cluster.${slug}`;
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

    // 원본은 삭제하지 않고 superseded + clustered_into 링크 (unmerge 복원 가능).
    for (const orig of memberRules) {
      orig.status = 'superseded';
      orig.clustered_into = merged.rule_id;
      saveRule(orig);
    }

    results.push({
      mergedRuleId: merged.rule_id,
      memberIds: memberRules.map((r) => r.rule_id),
      category,
      strength: cluster.strength,
      confidence: cluster.confidence,
      policy: cluster.representativePolicy,
    });
    log.debug(`클러스터 통합: ${memberRules.length}룰 → ${merged.rule_id} (${cluster.strength})`);
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
    saveRule(orig);
  }

  merged.status = 'removed';
  saveRule(merged);

  // 이 조합을 억제목록에 추가 → 재통합 방지.
  const suppressed = loadSuppression();
  suppressed.add(clusterKey(members));
  saveSuppression(suppressed);

  return { ok: true, restored: members.map((r) => r.rule_id) };
}
