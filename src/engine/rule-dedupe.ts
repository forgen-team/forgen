/**
 * `forgen rule dedupe [--apply]` — 같은 문장 활성 룰 정리 (2026-11 재설계 D4).
 *
 * 활성 scope:'me' 룰을 출처별(explicit / 채굴)로 나눠 정규화 문장(normalizePolicy)이 같은 묶음을 찾는다.
 * 남길 룰: strength(hard > strong > default > soft) → 오래된 created_at. 나머지는 superseded(superseded_by = 남길 룰).
 * 남길 룰에는 같은 출처 증거를 합치고(ADR-013: explicit 와 채굴 증거는 섞지 않음) projects 는 합집합(하나라도 전역이면 전역).
 * hard 룰은 대체하지 않는다. 미리보기가 기본이고, 적용 전에 스냅샷을 만든다(되돌리기: forgen rule restore).
 */
import { loadAllRules, loadRule, rulePath, saveRule } from '../store/rule-store.js';
import { withStatusChange } from '../store/rule-lifecycle.js';
import { mergeRuleProjects } from '../store/rule-scope.js';
import { normalizePolicy } from '../store/rule-normalize.js';
import { withFileLockSync } from '../hooks/shared/file-lock.js';
import { createSnapshot } from './rule-recovery-cli.js';
import type { Rule } from '../store/types.js';

const STRENGTH_RANK: Record<string, number> = { hard: 0, strong: 1, default: 2, soft: 3 };

export interface DedupeGroup { keeper: Rule; duplicates: Rule[] }

export function planDedupe(rules: Rule[]): DedupeGroup[] {
  const groups = new Map<string, Rule[]>();
  for (const r of rules) {
    if (r.status !== 'active' || r.scope !== 'me') continue;
    if (r.source !== 'explicit_correction' && r.source !== 'behavior_inference') continue;
    const key = normalizePolicy(r.policy);
    if (key.length < 10) continue;
    const k = `${r.source}\u0000${key}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: DedupeGroup[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) =>
      (STRENGTH_RANK[a.strength] ?? 9) - (STRENGTH_RANK[b.strength] ?? 9)
      || Date.parse(a.created_at) - Date.parse(b.created_at)
      || a.rule_id.localeCompare(b.rule_id));
    const [keeper, ...rest] = sorted;
    const duplicates = rest.filter((r) => r.strength !== 'hard');
    if (duplicates.length > 0) out.push({ keeper, duplicates });
  }
  return out;
}

export interface DedupeResult { groups: number; superseded: number; snapshot: string | null }

export function applyDedupe(rules: Rule[] = loadAllRules()): DedupeResult {
  const plan = planDedupe(rules);
  if (plan.length === 0) return { groups: 0, superseded: 0, snapshot: null };
  const snapshot = createSnapshot('pre-dedupe');
  let superseded = 0;
  for (const { keeper, duplicates } of plan) {
    try {
      withFileLockSync(rulePath(keeper.rule_id), () => {
        const fresh = loadRule(keeper.rule_id);
        if (!fresh || fresh.status !== 'active') return;
        const evidence = [...new Set([...fresh.evidence_refs, ...duplicates.flatMap((d) => d.evidence_refs ?? [])])];
        const projects = mergeRuleProjects([fresh, ...duplicates]);
        const { projects: _old, ...rest } = fresh;
        saveRule({ ...rest, ...(projects ? { projects } : {}), evidence_refs: evidence });
      });
    } catch { continue; } // 남길 룰을 못 잠그면 이 묶음은 건드리지 않는다
    for (const d of duplicates) {
      try {
        withFileLockSync(rulePath(d.rule_id), () => {
          const fresh = loadRule(d.rule_id);
          if (!fresh || fresh.status !== 'active') return;
          const next = withStatusChange(fresh, 'superseded', `duplicate-of ${keeper.rule_id}`, 'dedupe');
          saveRule({ ...next, ...(next.lifecycle ? { lifecycle: { ...next.lifecycle, superseded_by: keeper.rule_id } } : {}) });
          superseded++;
        });
      } catch { /* 다음 실행에서 */ }
    }
  }
  return { groups: plan.length, superseded, snapshot };
}

export function handleRuleDedupe(args: string[]): void {
  const plan = planDedupe(loadAllRules());
  if (!args.includes('--apply')) {
    console.log(`같은 문장 활성 룰: ${plan.length}묶음`);
    for (const g of plan.slice(0, 20)) {
      console.log(`  남김 ${g.keeper.rule_id.slice(0, 8)} [${g.keeper.strength}]  ${g.keeper.policy.replace(/\s+/g, ' ').slice(0, 70)}`);
      for (const d of g.duplicates) console.log(`    대체 ${d.rule_id.slice(0, 8)} [${d.strength}]`);
    }
    if (plan.length > 0) console.log('적용: forgen rule dedupe --apply  (적용 전 스냅샷, 되돌리기: forgen rule restore <이름> --yes)');
    return;
  }
  const r = applyDedupe();
  console.log(r.groups === 0 ? '정리할 같은 문장 룰이 없습니다.' : `✓ [forgen] ${r.groups}묶음, ${r.superseded}개 룰을 대체 처리했습니다. 되돌리기: forgen rule restore ${r.snapshot} --yes`);
}
