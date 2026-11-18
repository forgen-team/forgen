/**
 * `forgen rule list --json [--archive]` — 외부 도구가 읽는 룰 목록 (`forgen-rule-list/v1`).
 * 설계: docs/plans/2026-11-18-forgen-own-metrics.md §1. 필드는 추가만 한다(바꾸려면 버전을 올린다).
 *
 * 개인 룰(~/.forgen/me/rules, --archive 면 rules-archive 도)만 — 현재 폴더 프로젝트 룰은 넣지 않는다(`--health` 와 같은 기준).
 * 읽기 전용.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ME_BEHAVIOR, ME_RULES, ME_RULES_ARCHIVE } from './paths.js';
import { CURRENT_RULE_SCHEMA_VERSION, type Evidence, type Rule } from '../store/types.js';
import { ruleEnforced, enforceabilityLabel } from '../engine/rule-detectability.js';

export const RULE_LIST_SCHEMA = 'forgen-rule-list/v1';
const MAX_EVIDENCE = 20;

export interface RuleListEvidence { id: string; at: string | null; kind: 'user' | 'mined' | 'other'; summary: string | null }

export interface RuleListItem {
  id: string;
  status: Rule['status'];
  phase: string | null;
  category: Rule['category'];
  strength: Rule['strength'];
  source: Rule['source'];
  origin: 'user' | 'mined' | 'default' | 'other';
  scope: Rule['scope'];
  projects: string[];
  statement: string;
  trigger: string;
  renderKey: string;
  createdAt: string;
  updatedAt: string;
  counts: { inject: number; violation: number; bypass: number };
  lastInjectAt: string | null;
  lastViolationAt: string | null;
  enforce: { hasEnforceVia: boolean; mode: 'block' | 'advise'; label: '차단' | '탐지' | '자문' };
  statusHistory: Array<{ at: string; from: string; to: string; reason: string; by: string }>;
  evidence: RuleListEvidence[];
  evidenceTruncated: number;
  supersededBy: string | null;
  reviewedAt: string | null;
  archived: boolean;
}

export interface RuleList { schema: typeof RULE_LIST_SCHEMA; generatedAt: string; rules: RuleListItem[] }

export function readRuleFiles(dir: string): Rule[] {
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out: Rule[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as Rule;
      if (!r || typeof r.rule_id !== 'string' || typeof r.policy !== 'string') continue;
      if (r.schema_version != null && r.schema_version > CURRENT_RULE_SCHEMA_VERSION) continue;
      out.push(r);
    } catch { /* 깨진 파일 건너뜀 */ }
  }
  return out;
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

function evidenceOf(refs: readonly string[], cache: Map<string, Evidence | null>): { items: RuleListEvidence[]; truncated: number } {
  const items: RuleListEvidence[] = [];
  for (const id of refs) {
    if (!cache.has(id)) {
      let ev: Evidence | null = null;
      if (id && id === path.basename(id)) {
        try { ev = JSON.parse(fs.readFileSync(path.join(ME_BEHAVIOR, `${id}.json`), 'utf-8')) as Evidence; } catch { ev = null; }
      }
      cache.set(id, ev);
    }
    const ev = cache.get(id) ?? null;
    const quote = (ev?.raw_payload as { user_quote?: unknown } | undefined)?.user_quote;
    const text = typeof quote === 'string' && quote ? quote : ev?.summary;
    items.push({
      id,
      at: ev?.timestamp ?? null,
      kind: !ev ? 'other' : ev.source_component === 'auto-compound-miner' ? 'mined' : ev.type === 'explicit_correction' ? 'user' : 'other',
      summary: typeof text === 'string' ? text.replace(/\s+/g, ' ').slice(0, 200) : null,
    });
  }
  items.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return { items: items.slice(0, MAX_EVIDENCE), truncated: Math.max(0, items.length - MAX_EVIDENCE) };
}

export function toRuleListItem(r: Rule, archived: boolean, cache: Map<string, Evidence | null> = new Map()): RuleListItem {
  const lc = r.lifecycle;
  const ev = evidenceOf(r.evidence_refs ?? [], cache);
  const enforced = ruleEnforced(r);
  return {
    id: r.rule_id,
    status: r.status,
    phase: lc?.phase ?? null,
    category: r.category,
    strength: r.strength,
    source: r.source,
    origin: r.source === 'explicit_correction' ? 'user' : r.source === 'behavior_inference' ? 'mined' : r.source === 'onboarding' ? 'default' : 'other',
    scope: r.scope,
    projects: r.projects ?? [],
    statement: r.policy,
    trigger: r.trigger,
    renderKey: r.render_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    counts: { inject: n(lc?.inject_count), violation: n(lc?.violation_count), bypass: n(lc?.bypass_count) },
    lastInjectAt: lc?.last_inject_at ?? null,
    lastViolationAt: lc?.last_violation_at ?? null,
    enforce: {
      hasEnforceVia: (r.enforce_via ?? []).length > 0,
      mode: enforced ? 'block' : 'advise',
      label: enforced ? '차단' : enforceabilityLabel(r),
    },
    statusHistory: (r.status_history ?? []).map((h) => ({ at: h.at, from: h.from, to: h.to, reason: h.reason ?? '', by: h.by ?? '' })),
    evidence: ev.items,
    evidenceTruncated: ev.truncated,
    supersededBy: lc?.superseded_by ?? null,
    reviewedAt: lc?.reviewed_at ?? null,
    archived,
  };
}

export function buildRuleList(opts: { archive?: boolean; now?: number } = {}): RuleList {
  const cache = new Map<string, Evidence | null>();
  const current = readRuleFiles(ME_RULES);
  const ids = new Set(current.map((r) => r.rule_id));
  const rules = current.map((r) => toRuleListItem(r, false, cache));
  if (opts.archive) {
    for (const r of readRuleFiles(ME_RULES_ARCHIVE)) if (!ids.has(r.rule_id)) rules.push(toRuleListItem(r, true, cache));
  }
  rules.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { schema: RULE_LIST_SCHEMA, generatedAt: new Date(opts.now ?? Date.now()).toISOString(), rules };
}
