/**
 * ADR-002 Meta trigger — drift.jsonl 누적을 읽어 rule 의 mech 재분류 후보를 산출.
 *
 * 현 스코프 (v0.4.0 follow-up):
 *   - `stuck_loop_force_approve` 이벤트를 recent window(기본 7 일) 에서 집계.
 *   - 같은 rule_id 에서 임계치(기본 3) 이상 발생 시 **Mech demotion 후보** 로 분류.
 *   - demotion 은 Mech-A/B → 한 단계 완화:
 *       - A (block 강제) → B (self-check 권고)
 *       - B (self-check) → C (drift 측정)
 *       - C 는 그대로 (더 강등 불가)
 *   - dry-run 기본. `--apply` 시 rule 파일의 enforce_via[].mech 갱신 + meta_promotions 추가.
 *
 * v0.4.1+ 확장 여지 (본 파일에는 미구현):
 *   - Mech promotion (B → A): rolling 20 injects 중 violation 0 → 승급.
 *     이 경로는 별도 evidence source (solution-outcomes) 필요.
 *   - 30 일 쿨다운.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LifecycleEvent } from './types.js';
import type { EnforcementMech, EnforceSpec, Rule } from '../../store/types.js';
import { loadAllRules, saveRule } from '../../store/rule-store.js';

const DRIFT_LOG_PATH = path.join(os.homedir(), '.forgen', 'state', 'enforcement', 'drift.jsonl');
const LIFECYCLE_DIR = path.join(os.homedir(), '.forgen', 'state', 'lifecycle');

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_THRESHOLD = 3;

export interface DriftEntry {
  at: string;
  kind: string;
  session_id: string;
  rule_id: string;
  count: number;
  reason_preview?: string;
  message_preview?: string;
}

export interface DemotionCandidate {
  rule_id: string;
  event_count: number;
  first_at: string;
  last_at: string;
  sessions: string[];
  window_days: number;
  current_mechs: EnforcementMech[];
}

export function readDriftEntries(driftPath: string = DRIFT_LOG_PATH): DriftEntry[] {
  if (!fs.existsSync(driftPath)) return [];
  try {
    const raw = fs.readFileSync(driftPath, 'utf-8');
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) as DriftEntry; } catch { return null; }
      })
      .filter((e): e is DriftEntry => e !== null);
  } catch {
    return [];
  }
}

export function scanDriftForDemotion(options: {
  rules: Rule[];
  drift?: DriftEntry[];
  windowDays?: number;
  threshold?: number;
  now?: number;
} = { rules: [] }): DemotionCandidate[] {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const now = options.now ?? Date.now();
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
  const drift = options.drift ?? readDriftEntries();

  const byRule = new Map<string, DriftEntry[]>();
  for (const e of drift) {
    if (e.kind !== 'stuck_loop_force_approve') continue;
    const t = Date.parse(e.at);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const list = byRule.get(e.rule_id) ?? [];
    list.push(e);
    byRule.set(e.rule_id, list);
  }

  const candidates: DemotionCandidate[] = [];
  for (const [ruleId, entries] of byRule.entries()) {
    if (entries.length < threshold) continue;
    const rule = options.rules.find((r) => r.rule_id === ruleId || r.rule_id.startsWith(ruleId));
    const currentMechs = (rule?.enforce_via ?? [])
      .map((s) => s.mech)
      .filter((m, i, arr) => arr.indexOf(m) === i);
    const sortedTs = entries.map((e) => Date.parse(e.at)).sort((a, b) => a - b);
    candidates.push({
      rule_id: ruleId,
      event_count: entries.length,
      first_at: new Date(sortedTs[0]).toISOString(),
      last_at: new Date(sortedTs[sortedTs.length - 1]).toISOString(),
      sessions: [...new Set(entries.map((e) => e.session_id))],
      window_days: windowDays,
      current_mechs: currentMechs,
    });
  }
  return candidates;
}

export function demoteMech(from: EnforcementMech): EnforcementMech | null {
  if (from === 'A') return 'B';
  if (from === 'B') return 'C';
  return null;
}

export function promoteMech(from: EnforcementMech): EnforcementMech | null {
  if (from === 'B') return 'A';
  if (from === 'C') return 'B';
  return null;
}

export interface PromotionCandidate {
  rule_id: string;
  injects_rolling_n: number;
  violations_rolling_n: number;
  current_mechs: EnforcementMech[];
  reason: string;
}

/**
 * rolling N 개 inject 중 violation 0 → Mech 승급 후보.
 * inject 추적 인프라가 완비되기 전에는 `rolling_min_injects` (기본 20) 미만이면 skip.
 */
export function scanSignalsForPromotion(options: {
  rules: Rule[];
  rolling_min_injects?: number;
  ts?: number;
  signals: Map<string, import('./types.js').RuleSignals>;
}): PromotionCandidate[] {
  const minInjects = options.rolling_min_injects ?? 20;
  const out: PromotionCandidate[] = [];
  for (const rule of options.rules) {
    if (rule.status !== 'active') continue;
    const s = options.signals.get(rule.rule_id);
    if (!s) continue;
    if (s.injects_rolling_n < minInjects) continue;
    if (s.violations_rolling_n > 0) continue;
    const mechs = (rule.enforce_via ?? []).map((spec) => spec.mech);
    const hasPromotable = mechs.some((m) => m === 'B' || m === 'C');
    if (!hasPromotable) continue;
    out.push({
      rule_id: rule.rule_id,
      injects_rolling_n: s.injects_rolling_n,
      violations_rolling_n: s.violations_rolling_n,
      current_mechs: [...new Set(mechs)],
      reason: `rolling ${s.injects_rolling_n} injects, 0 violations — promotion candidate`,
    });
  }
  return out;
}

export function applyPromotion(rule: Rule, candidate: PromotionCandidate, now: number = Date.now()): ApplyResult {
  const specs: EnforceSpec[] = rule.enforce_via ?? [];
  const before = specs.map((s) => s.mech);
  const events: LifecycleEvent[] = [];
  let changed = false;

  const updatedSpecs = specs.map((spec) => {
    const to = promoteMech(spec.mech);
    if (to == null) return spec;
    changed = true;
    events.push({
      kind: 'meta_promote_to_a',
      rule_id: rule.rule_id,
      evidence: {
        source: 'signals',
        refs: [],
        metrics: { injects_rolling_n: candidate.injects_rolling_n, violations_rolling_n: candidate.violations_rolling_n },
      },
      suggested_action: 'promote_mech',
      ts: now,
    });
    return { ...spec, mech: to };
  });

  if (!changed) {
    return { rule_id: rule.rule_id, before_mech: before, after_mech: before, events: [], applied: false, reason: 'no Mech-B/C to promote' };
  }

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

  const promotions = updatedSpecs.map((spec, i) => ({
    at: new Date(now).toISOString(),
    from_mech: before[i],
    to_mech: spec.mech,
    reason: 'consistent_adherence' as const,
    trigger_stats: {
      window_n: candidate.injects_rolling_n,
      adherence_rate: 1.0,
    },
  })).filter((p) => p.from_mech !== p.to_mech);

  const updatedRule: Rule = {
    ...rule,
    enforce_via: updatedSpecs,
    lifecycle: {
      ...lifecycle,
      meta_promotions: [...lifecycle.meta_promotions, ...promotions],
    },
    updated_at: new Date(now).toISOString(),
  };

  saveRule(updatedRule);

  return {
    rule_id: rule.rule_id,
    before_mech: before,
    after_mech: updatedSpecs.map((s) => s.mech),
    events,
    applied: true,
  };
}

export interface ApplyResult {
  rule_id: string;
  before_mech: EnforcementMech[];
  after_mech: EnforcementMech[];
  events: LifecycleEvent[];
  applied: boolean;
  reason?: string;
}

export function applyDemotion(rule: Rule, candidate: DemotionCandidate, now: number = Date.now()): ApplyResult {
  const specs: EnforceSpec[] = rule.enforce_via ?? [];
  const before = specs.map((s) => s.mech);
  const events: LifecycleEvent[] = [];
  let changed = false;

  const updatedSpecs = specs.map((spec) => {
    const to = demoteMech(spec.mech);
    if (to == null) return spec;
    changed = true;
    events.push({
      kind: 'meta_demote_to_b',
      rule_id: rule.rule_id,
      evidence: {
        source: 'drift-log',
        refs: candidate.sessions,
        metrics: { event_count: candidate.event_count, window_days: candidate.window_days },
      },
      suggested_action: 'demote_mech',
      ts: now,
    });
    return { ...spec, mech: to };
  });

  if (!changed) {
    return { rule_id: rule.rule_id, before_mech: before, after_mech: before, events: [], applied: false, reason: 'no Mech-A/B to demote' };
  }

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

  const demotions = updatedSpecs.map((spec, i) => ({
    at: new Date(now).toISOString(),
    from_mech: before[i],
    to_mech: spec.mech,
    reason: 'stuck_loop_force_approve' as const,
    trigger_stats: { window_n: candidate.event_count, violation_count: candidate.event_count },
  })).filter((p) => p.from_mech !== p.to_mech);

  const after = updatedSpecs.map((s) => s.mech);
  const updatedRule: Rule = {
    ...rule,
    enforce_via: updatedSpecs,
    lifecycle: {
      ...lifecycle,
      meta_promotions: [...lifecycle.meta_promotions, ...demotions],
    },
    updated_at: new Date(now).toISOString(),
  };

  saveRule(updatedRule);

  return {
    rule_id: rule.rule_id,
    before_mech: before,
    after_mech: after,
    events,
    applied: true,
  };
}

export function appendLifecycleEvents(events: LifecycleEvent[], now: number = Date.now()): void {
  if (events.length === 0) return;
  try {
    fs.mkdirSync(LIFECYCLE_DIR, { recursive: true });
    const date = new Date(now).toISOString().slice(0, 10);
    const logPath = path.join(LIFECYCLE_DIR, `${date}.jsonl`);
    const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(logPath, body);
  } catch {
    // best-effort
  }
}

export async function runMetaScan(args: string[]): Promise<void> {
  const apply = args.includes('--apply');
  const threshold = Number(args[args.indexOf('--threshold') + 1]) || DEFAULT_THRESHOLD;
  const windowDays = Number(args[args.indexOf('--window') + 1]) || DEFAULT_WINDOW_DAYS;

  const rules = loadAllRules();
  const drift = readDriftEntries();
  const candidates = scanDriftForDemotion({ rules, drift, windowDays, threshold });

  console.log(`\n  Meta Reclassifier (Rule Lifecycle)\n`);
  console.log(`  Window: last ${windowDays} day(s)   Threshold: ${threshold} event(s)\n`);
  console.log(`  Scanned: drift.jsonl = ${drift.length} entries, rules = ${rules.length}\n`);

  if (candidates.length === 0) {
    console.log('  No demotion candidates. System stable.\n');
    return;
  }

  const allEvents: LifecycleEvent[] = [];
  for (const c of candidates) {
    console.log(`  ⚠ Candidate: rule=${c.rule_id} events=${c.event_count} sessions=${c.sessions.length} mechs=[${c.current_mechs.join(',')}]`);
    console.log(`    window: ${c.first_at} → ${c.last_at}`);

    const rule = rules.find((r) => r.rule_id === c.rule_id || r.rule_id.startsWith(c.rule_id));
    if (!rule) {
      console.log('    (rule not found in store — likely spike scenarios.json; skip)');
      continue;
    }

    if (apply) {
      const result = applyDemotion(rule, c);
      if (result.applied) {
        console.log(`    → APPLIED: ${result.before_mech.join(',')} → ${result.after_mech.join(',')}`);
        allEvents.push(...result.events);
      } else {
        console.log(`    → SKIP: ${result.reason}`);
      }
    } else {
      const proposed = (rule.enforce_via ?? []).map((s) => demoteMech(s.mech) ?? s.mech);
      console.log(`    → PROPOSE: ${(rule.enforce_via ?? []).map((s) => s.mech).join(',')} → ${proposed.join(',')}  (run with --apply to save)`);
    }
    console.log('');
  }

  if (apply && allEvents.length > 0) {
    appendLifecycleEvents(allEvents);
    console.log(`  Persisted ${allEvents.length} lifecycle event(s) to ~/.forgen/state/lifecycle/\n`);
  }
}
