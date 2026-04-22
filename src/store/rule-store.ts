/**
 * Forgen v1 — Rule Store
 *
 * Structured Rule CRUD. render_key 기반 dedupe는 renderer 책임.
 * Authoritative schema: docs/plans/2026-04-03-forgen-data-model-storage-spec.md §3
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ME_RULES } from '../core/paths.js';
import { atomicWriteJSON, safeReadJSON } from '../hooks/shared/atomic-write.js';
import type { Rule, RuleCategory, RuleScope, RuleStrength, RuleSource, RuleStatus } from './types.js';

function rulePath(ruleId: string): string {
  return path.join(ME_RULES, `${ruleId}.json`);
}

export function createRule(params: {
  category: RuleCategory;
  scope: RuleScope;
  trigger: string;
  policy: string;
  strength: RuleStrength;
  source: RuleSource;
  evidence_refs?: string[];
  render_key: string;
}): Rule {
  const now = new Date().toISOString();
  return {
    rule_id: crypto.randomUUID(),
    category: params.category,
    scope: params.scope,
    trigger: params.trigger,
    policy: params.policy,
    strength: params.strength,
    source: params.source,
    status: 'active',
    evidence_refs: params.evidence_refs ?? [],
    render_key: params.render_key,
    created_at: now,
    updated_at: now,
  };
}

export function saveRule(rule: Rule): void {
  rule.updated_at = new Date().toISOString();
  atomicWriteJSON(rulePath(rule.rule_id), rule, { pretty: true });
}

/**
 * ADR-002 T5 — rule 저장 + 기존 active rules 와 자연어 충돌 감지 + 양쪽 conflict_refs 기록.
 *
 * saveRule 과의 차이:
 *   - 저장 직후 T5 detect 실행 → 충돌 발견 시 신규 rule + 반대편 rule 모두 conflict_refs 업데이트.
 *   - auto-merge 안 함 (ADR-002 §Risks — 사용자 수동 해소).
 *   - T5 감지 실패는 저장 자체를 막지 않음 (fail-open).
 *
 * 반환: 저장된 rule + 감지된 충돌 rule_id 목록.
 */
export async function appendRule(rule: Rule): Promise<{ saved: true; conflicts_with: string[] }> {
  saveRule(rule);
  try {
    const [{ detect: detectT5 }, { appendLifecycleEvents }] = await Promise.all([
      import('../engine/lifecycle/trigger-t5-conflict.js'),
      import('../engine/lifecycle/meta-reclassifier.js'),
    ]);
    const all = loadAllRules();
    const events = detectT5({ rules: all });
    const relevant = events.filter((e) => e.evidence?.refs?.includes(rule.rule_id));
    if (relevant.length === 0) return { saved: true, conflicts_with: [] };

    // conflict_refs 양방향 업데이트
    const affected = new Set<string>();
    for (const ev of relevant) affected.add(ev.rule_id);

    for (const id of affected) {
      const target = all.find((r) => r.rule_id === id);
      if (!target) continue;
      const refs = relevant
        .filter((ev) => ev.rule_id === id)
        .flatMap((ev) => (ev.evidence?.refs ?? []).filter((r) => r !== id));
      const currentConflicts = target.lifecycle?.conflict_refs ?? [];
      const merged = [...new Set([...currentConflicts, ...refs])];
      const lifecycle = target.lifecycle ?? {
        phase: 'active' as const,
        first_active_at: target.created_at,
        inject_count: 0, accept_count: 0, violation_count: 0, bypass_count: 0,
        conflict_refs: [], meta_promotions: [],
      };
      saveRule({ ...target, lifecycle: { ...lifecycle, conflict_refs: merged } });
    }
    appendLifecycleEvents(relevant);

    const conflicts_with = [
      ...new Set(
        relevant
          .filter((e) => e.rule_id === rule.rule_id)
          .flatMap((e) => (e.evidence?.refs ?? []).filter((r) => r !== rule.rule_id))
      ),
    ];
    return { saved: true, conflicts_with };
  } catch {
    return { saved: true, conflicts_with: [] };
  }
}

export function loadRule(ruleId: string): Rule | null {
  return safeReadJSON<Rule | null>(rulePath(ruleId), null);
}

export function loadAllRules(): Rule[] {
  if (!fs.existsSync(ME_RULES)) return [];
  const rules: Rule[] = [];
  for (const file of fs.readdirSync(ME_RULES)) {
    if (!file.endsWith('.json')) continue;
    const rule = safeReadJSON<Rule | null>(path.join(ME_RULES, file), null);
    if (rule) rules.push(rule);
  }
  return rules;
}

export function loadActiveRules(): Rule[] {
  return loadAllRules().filter(r => r.status === 'active');
}

/**
 * ADR-002 Meta signal — rule 들이 프롬프트에 inject 되었음을 기록.
 * rule.lifecycle.inject_count +1, last_inject_at = now.
 * lifecycle 없던 rule 은 auto-init 하고 phase='active'.
 * Meta promotion (B→A) 의 rolling window 집계가 이 카운터를 소비한다.
 */
export function markRulesInjected(ruleIds: string[], nowIso: string = new Date().toISOString()): void {
  for (const id of ruleIds) {
    const rule = loadRule(id);
    if (!rule) continue;
    const lifecycle = rule.lifecycle ?? {
      phase: 'active' as const,
      first_active_at: rule.created_at,
      inject_count: 0,
      accept_count: 0,
      violation_count: 0,
      bypass_count: 0,
      conflict_refs: [],
      meta_promotions: [],
    };
    const updated: Rule = {
      ...rule,
      lifecycle: {
        ...lifecycle,
        inject_count: lifecycle.inject_count + 1,
        last_inject_at: nowIso,
      },
    };
    // saveRule bumps updated_at — pass through directly without re-bump
    atomicWriteJSON(rulePath(rule.rule_id), updated, { pretty: true });
  }
}

export function updateRuleStatus(ruleId: string, status: RuleStatus): boolean {
  const rule = loadRule(ruleId);
  if (!rule) return false;
  rule.status = status;
  saveRule(rule);
  return true;
}

/**
 * 현재 세션 ID와 다른 scope:'session' 규칙을 비활성화.
 * 이전 세션의 임시 규칙이 새 세션에서 영향을 미치지 않도록 정리.
 */
export function cleanupStaleSessionRules(_currentSessionId: string): number {
  if (!fs.existsSync(ME_RULES)) return 0;
  let cleaned = 0;
  for (const file of fs.readdirSync(ME_RULES)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(ME_RULES, file);
    const rule = safeReadJSON<Rule | null>(filePath, null);
    if (rule && rule.scope === 'session' && rule.status === 'active') {
      rule.status = 'suppressed';
      rule.updated_at = new Date().toISOString();
      atomicWriteJSON(filePath, rule, { pretty: true });
      cleaned++;
    }
  }
  return cleaned;
}
