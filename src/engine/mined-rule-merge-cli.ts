/**
 * CLI handler for `forgen rule merge-mined [--apply]` (ADR-017 D3).
 *
 * 채굴(behavior_inference, `auto:`) 룰을 채굴끼리만 병합하고, explicit 룰과 같은 개념인
 * 채굴 룰은 explicit 에 *링크*만 건다(흡수 금지 — ADR-013 불변식). 기본은 dry-run:
 * "채굴 N → M (병합 K, explicit 링크 L)" 과 각 클러스터의 멤버·대표 policy 를 출력한다.
 * `--apply` 로 적용. 되돌리기는 `forgen rule unmerge <id>`.
 */

import { type MinedMergePlan, runMinedRuleMerge } from './correction-cluster-runner.js';

const POLICY_PREVIEW = 70;

function preview(policy: string): string {
  const one = policy.replace(/\s+/g, ' ').trim();
  return one.length > POLICY_PREVIEW ? `${one.slice(0, POLICY_PREVIEW)}…` : one;
}

function short(id: string): string {
  return id.slice(0, 8);
}

export function renderMinedMergePlan(plan: MinedMergePlan): string {
  const mergedCount = plan.clusters.reduce((n, c) => n + c.memberIds.length, 0);
  const lines: string[] = [];
  lines.push(
    `채굴 ${plan.totalMined} → ${plan.projectedMined} (병합 ${mergedCount}, explicit 링크 ${plan.explicitLinks.length})`,
  );

  if (plan.explicitLinks.length > 0) {
    lines.push('');
    lines.push(`[explicit 링크 ${plan.explicitLinks.length}] — 채굴 룰은 숨김, explicit 은 "채굴 관측 N회" 만 증가`);
    for (const l of plan.explicitLinks) {
      lines.push(
        `  ${short(l.minedRuleId)} (유사도 ${l.similarity.toFixed(2)}, 관측 ${l.observations}) → ${short(l.explicitRuleId)}`,
      );
      lines.push(`      채굴:     ${preview(l.minedPolicy)}`);
      lines.push(`      explicit: ${preview(l.explicitPolicy)}`);
    }
  }

  plan.clusters.forEach((c, i) => {
    lines.push('');
    const absorb = c.absorberId ? ` (기존 통합 룰 ${short(c.absorberId)} 에 흡수)` : '';
    lines.push(
      `[클러스터 ${i + 1}] ${c.category} · 멤버 ${c.memberIds.length} · created_at ${c.oldestCreatedAt.slice(0, 10)} 기준${absorb}`,
    );
    lines.push(`  대표: ${preview(c.representativePolicy)}`);
    c.memberIds.forEach((id, j) => {
      lines.push(`    - ${short(id)}  ${preview(c.memberPolicies[j] ?? '')}`);
    });
  });

  if (plan.explicitLinks.length === 0 && plan.clusters.length === 0) {
    lines.push('');
    lines.push('병합/링크 대상 없음.');
  }
  return lines.join('\n');
}

export async function handleMergeMined(args: string[]): Promise<void> {
  const apply = args.includes('--apply');
  const unknown = args.filter((a) => a !== '--apply');
  if (unknown.length > 0) {
    console.error(`Usage: forgen rule merge-mined [--apply]  (unknown: ${unknown.join(' ')})`);
    process.exit(2);
  }

  const { plan, applied } = await runMinedRuleMerge({ apply });
  console.log(renderMinedMergePlan(plan));

  if (!applied) {
    if (plan.explicitLinks.length > 0 || plan.clusters.length > 0) {
      console.log('');
      console.log('(dry-run) 적용하려면: forgen rule merge-mined --apply');
    }
    return;
  }

  console.log('');
  console.log(
    `✓ 적용 — explicit 링크 ${applied.linked}, 신규 통합 룰 ${applied.mergedRuleIds.length}, superseded 원본 ${applied.supersededIds.length}`,
  );
  for (const id of applied.mergedRuleIds) console.log(`  통합 룰: ${id}`);
  console.log('  되돌리기: forgen rule unmerge <통합 룰 id | explicit 룰 id>');
}
