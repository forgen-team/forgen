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
import { CURRENT_RULE_SCHEMA_VERSION } from './types.js';
import { initLifecycle, bumpInject } from './rule-lifecycle.js';

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
  // v0.4.1 audit-trail 불변식: rule 저장 시 lifecycle state 가 null/undefined 이면
  // active phase 기본값 주입. 이전에는 old rule 파일이 lifecycle 없이 존재해 쌤 이후
  // audit trail (phase/violation_count/meta_promotions) 추적 불가 — 이번 세션에서
  // suppressed rule 의 lifecycle=null 발견. initLifecycle 은 기존 값이 있으면 normalize,
  // 없으면 phase='active' + counters=0 초기화.
  if (!rule.lifecycle) {
    rule.lifecycle = initLifecycle(rule);
  }
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
  const rules: Rule[] = [];

  // 1) 사용자 개인 rules: ~/.forgen/me/rules
  if (fs.existsSync(ME_RULES)) {
    for (const file of fs.readdirSync(ME_RULES)) {
      if (!file.endsWith('.json')) continue;
      const rule = safeReadJSON<Rule | null>(path.join(ME_RULES, file), null);
      if (rule && isCompatibleSchema(rule, file)) rules.push(rule);
    }
  }

  // 2) 프로젝트 로컬 rules: <cwd>/.forgen/rules
  // ADR-003 Phase 1 Dogfood — 팀/프로젝트가 git 에 committed 한 L1 정책을 자동 로드.
  // 같은 rule_id 가 me 와 project 양쪽에 있으면 project 가 우선 (git 소스가 정책 진실).
  const projectRulesDir = resolveProjectRulesDir();
  if (projectRulesDir && fs.existsSync(projectRulesDir)) {
    for (const file of fs.readdirSync(projectRulesDir)) {
      if (!file.endsWith('.json')) continue;
      const rule = safeReadJSON<Rule | null>(path.join(projectRulesDir, file), null);
      if (!rule || !isCompatibleSchema(rule, file)) continue;
      const existingIdx = rules.findIndex((r) => r.rule_id === rule.rule_id);
      if (existingIdx >= 0) rules[existingIdx] = rule; // project override
      else rules.push(rule);
    }
  }

  return rules;
}

/**
 * R5-B3: schema_version 호환성 체크.
 * - undefined / 0 / CURRENT_RULE_SCHEMA_VERSION: OK
 * - > CURRENT: 상위 버전 → graceful skip (downgrade 시 silent corruption 방지)
 */
function isCompatibleSchema(rule: Rule, filename: string): boolean {
  const v = rule.schema_version;
  if (v == null || v <= CURRENT_RULE_SCHEMA_VERSION) return true;
  if (process.env.FORGEN_DEBUG_SIGNALS === '1') {
    process.stderr.write(`[forgen:rule-store] ${filename} schema_version=${v} > supported ${CURRENT_RULE_SCHEMA_VERSION} — skipped\n`);
  }
  return false;
}

/**
 * 현재 프로젝트 cwd 의 `.forgen/rules/` 경로. FORGEN_CWD/COMPOUND_CWD 우선.
 * 테스트 / CI 에서 프로젝트 스코프 로딩을 비활성화하려면 FORGEN_DISABLE_PROJECT_RULES=1.
 */
function resolveProjectRulesDir(): string | null {
  if (process.env.FORGEN_DISABLE_PROJECT_RULES === '1') return null;
  const cwd = process.env.FORGEN_CWD ?? process.env.COMPOUND_CWD ?? process.cwd();
  return path.join(cwd, '.forgen', 'rules');
}

export function loadActiveRules(): Rule[] {
  return loadAllRules().filter(r => r.status === 'active');
}

/**
 * render_key(+source, +scope)로 기존 rule을 찾는다 — status 무관(active/suppressed/removed/
 * superseded 전부 포함). ADR-013 채굴 룰 재생성 결함 수정(RCA): promoteSessionCandidates가
 * loadActiveRules() 로만 dedup 하다 보니 TTL/cap 로 은퇴(removed)된 render_key가 재차 채굴되면
 * "없음" 으로 오판해 매번 새 rule_id + created_at=now 로 재생성 — 이게 6,701개 파일 중
 * 6,525개가 removed 로 죽어 쌓인 근본 원인. 이 함수로 upsert identity 를 render_key 로
 * 고정한다: 있으면 재활성화, 없을 때만 신규 생성.
 *
 * scope 필터가 필요한 이유: processCorrection()(evidence-processor.ts)이 fix-now/avoid-this
 * 에 대해 scope:'session' 임시 rule 을 만들 때 *같은 render_key 공식*(`${axis}.${target-slug}`)
 * 을 쓴다. scope 를 안 걸면 promoteSessionCandidates 가 그 임시 rule 을 "기존 me rule" 로
 * 오인해 재활성화해버려 영구 승격이 아예 안 되는 회귀가 생긴다(실측: 회귀 테스트로 발견).
 *
 * 동일 render_key 매칭이 여럿(레거시 데이터 등 이례적 상황)이면 active 우선, 그다음
 * updated_at 최신순으로 하나만 반환.
 */
export function findRuleByRenderKey(renderKey: string, source?: RuleSource, scope?: RuleScope): Rule | null {
  const matches = loadAllRules().filter(
    (r) => r.render_key === renderKey
      && (source === undefined || r.source === source)
      && (scope === undefined || r.scope === scope),
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (b.status === 'active' && a.status !== 'active') return 1;
    return b.updated_at.localeCompare(a.updated_at);
  });
  return matches[0];
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
    // R6-F1: initLifecycle 이 정규화(카운터 ≥0, 배열 보장) 까지 포함.
    const lifecycle = initLifecycle(rule);
    const updated: Rule = {
      ...rule,
      lifecycle: bumpInject(lifecycle, nowIso),
    };
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
/** status:'removed' rule 파일 정리 결과. */
export interface PruneResult {
  /** retention 기간을 지나 삭제 대상인 rule_id (dry-run/apply 공통). */
  candidates: string[];
  /** apply=true 일 때 실제 unlink 된 rule_id (dry-run 이면 항상 빈 배열). */
  deleted: string[];
}

/** removed 룰 보관 기간 기본값 — 7일. TTL 로 은퇴된 지 이만큼 지나면 prune 대상. */
export const DEFAULT_PRUNE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * status:'removed' 파일을 retention 기간이 지난 것만 실제 unlink.
 * RCA: retire(updateRuleStatus)는 status flip만 하고 파일을 지우지 않아 6,525개 죽은
 * 파일이 ~/.forgen/me/rules 에 쌓여 loadAllRules() linear scan 비용을 키우고
 * cross-process race 창을 넓혔다. status 전이 시각(updated_at) 기준으로 retention을
 * 재는 이유: removed 직후 즉시 지우면 (a) findRuleByRenderKey 가 재활성화할 기회를
 * 없애고 (b) 오탐 은퇴를 되돌릴 유예가 사라진다.
 *
 * 기본 dry-run(apply=false) — 프로덕션 데이터 삭제는 호출측이 명시적으로 apply:true
 * 를 넘길 때만. (compound-sweep-cli 의 `--prune-removed`는 `--apply` 없으면 dry-run.)
 */
export function pruneRemovedRules(opts: { retentionMs?: number; apply?: boolean } = {}): PruneResult {
  const retentionMs = opts.retentionMs ?? DEFAULT_PRUNE_RETENTION_MS;
  const apply = opts.apply ?? false;
  const now = Date.now();
  const candidates: string[] = [];
  const deleted: string[] = [];

  if (!fs.existsSync(ME_RULES)) return { candidates, deleted };

  for (const file of fs.readdirSync(ME_RULES)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(ME_RULES, file);
    const rule = safeReadJSON<Rule | null>(filePath, null);
    if (rule?.status !== 'removed') continue;
    const age = now - Date.parse(rule.updated_at);
    if (!Number.isFinite(age) || age < retentionMs) continue;

    candidates.push(rule.rule_id);
    if (apply) {
      try {
        fs.unlinkSync(filePath);
        deleted.push(rule.rule_id);
      } catch { /* best-effort — 다음 prune 에서 재시도 */ }
    }
  }

  return { candidates, deleted };
}

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
