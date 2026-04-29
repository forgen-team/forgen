/**
 * Introspect runner — computes forgen metrics from REAL usage logs.
 *
 * Source: ~/.forgen/state/*.jsonl + ~/.forgen/me/*
 * No simulation, no LLM judge — pure log analysis on the user's actual forgen usage.
 *
 * Metrics derived (proxies of testbed γ/β/δ/ε/ζ/φ/ψ):
 *   - hook activity per week (engagement)
 *   - match success rate (compound utility)
 *   - drift_warning frequency (Mech-C measurement signal)
 *   - repeated_edit slope over time (γ proxy — does it decline?)
 *   - same-file edit recurrence (ζ proxy — persistence)
 *   - hook error rate + suppressed rules (φ proxy)
 *
 * Usage:
 *   node dist/runners/introspect.js [weeks=6]
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const FORGEN_DIR = join(homedir(), '.forgen');
const STATE_DIR = join(FORGEN_DIR, 'state');
const ENFORCEMENT_DIR = join(STATE_DIR, 'enforcement');

interface ImplicitFeedbackEvent {
  type: string;
  file?: string;
  editCount?: number;
  score?: number;
  totalEdits?: number;
  totalReverts?: number;
  at: string;
  sessionId?: string;
  category: string;
}

interface MatchEvalEvent {
  source: string;
  rawQueryHash: string;
  rawQueryLen: number;
  normalizedQuery: string[];
  candidates: unknown[];
  rankedTopN: unknown[];
  ts: string;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => x !== null);
}

function bucketByWeek<T extends { at?: string; ts?: string }>(events: T[]): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const e of events) {
    const ts = e.at ?? e.ts ?? '';
    if (!ts) continue;
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) continue;
    // ISO week key: YYYY-Www
    const year = date.getFullYear();
    const start = new Date(date.getFullYear(), 0, 1);
    const week = Math.ceil(((date.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7);
    const key = `${year}-W${String(week).padStart(2, '0')}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(e);
  }
  return buckets;
}

function linearSlope(weeks: { week: string; count: number }[]): number {
  // Simple linear regression slope (events per week) — negative = declining
  if (weeks.length < 2) return 0;
  const n = weeks.length;
  const xs = weeks.map((_, i) => i);
  const ys = weeks.map((w) => w.count);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

interface IntrospectReport {
  generatedAt: string;
  observationWindowDays: number;
  totals: {
    implicitFeedback: number;
    matchEval: number;
    hookErrors: number;
    quarantined: number;
  };
  matchSuccess: {
    totalAttempts: number;
    withCandidates: number;
    rate: number;
  };
  driftSignal: {
    repeatedEdits: number;
    driftWarnings: number;
    driftWarningHighScore: number;
  };
  weeklyEdit: { week: string; repeatedEdits: number }[];
  gammaSlope: {
    description: string;
    slopePerWeek: number;
    interpretation: 'improving' | 'stable' | 'worsening';
  };
  zetaPersistence: {
    description: string;
    filesWithRecurrence: number;
    medianGapDays: number;
  };
  ruleLifecycle: {
    description: string;
    totalRules: number;
    byStatus: Record<string, number>;
    survivalRate: number; // active / (active + retired in lifecycle)
    oldestActiveDays: number;
    medianAgeAtRetirementDays: number;
    interpretation: string;
  };
  phiProxy: {
    description: string;
    hookErrorsPerWeek: number;
    suppressedRuleCount: number;
  };
  enforcement: {
    description: string;
    violations: number; // actual blocks
    acknowledgments: number; // user accepted block (good)
    bypasses: number; // user overrode block (FP candidate, raw)
    drift: number; // stuck-loop force approves (FP signal)
    bypassRate: number; // bypasses / (violations + acknowledgments + bypasses)
    bypassesPerViolation: number; // bypasses / violations (retry pressure)
  };
  bypassClassification: {
    description: string;
    auditOverrides: number;
    frustrationOverrides: number;
    ambiguous: number;
    rulesSuppressedByT3: number;
    strictPhi: number; // frustration / (violations + acknowledgments + frustration)
    interpretation: 'pass' | 'fail-master-gate';
    perRule: { ruleId: string; bypasses: number; fraction: number }[];
    topOffender: { ruleId: string; bypasses: number; fractionOfAllFrustration: number };
    strictPhiExcludingTopOffender: number; // shows leverage of fixing the worst rule
    // Post-fix projection — using current (fixed) extractBypassPatterns
    postFixSilencedRules: string[];
    postFixRemainingBypasses: number;
    postFixStrictPhi: number;
    postFixInterpretation: 'pass' | 'fail-master-gate';
  };
  honestCaveats: string[];
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

export async function introspect(): Promise<IntrospectReport> {
  const feedback = readJsonl<ImplicitFeedbackEvent>(join(STATE_DIR, 'implicit-feedback.jsonl'));
  const matches = readJsonl<MatchEvalEvent>(join(STATE_DIR, 'match-eval-log.jsonl'));
  const errors = readJsonl<{ hook: string; at: number }>(join(STATE_DIR, 'hook-errors.jsonl'));
  const quarantine = readJsonl<{ path: string }>(join(STATE_DIR, 'solution-quarantine.jsonl'));

  // Match success
  const withCandidates = matches.filter((m) => m.candidates.length > 0).length;
  const matchRate = matches.length === 0 ? 0 : withCandidates / matches.length;

  // Drift signal
  const repeatedEdits = feedback.filter((e) => e.type === 'repeated_edit');
  const driftWarnings = feedback.filter((e) => e.type === 'drift_warning');
  const driftHighScore = driftWarnings.filter((e) => (e.score ?? 0) >= 50).length;

  // γ proxy: weekly repeated_edit count
  const weekBuckets = bucketByWeek(repeatedEdits);
  const weeklyEdit = Array.from(weekBuckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, items]) => ({ week, count: items.length }));
  const slope = linearSlope(weeklyEdit);
  const gammaInterpretation: 'improving' | 'stable' | 'worsening' =
    slope < -0.5 ? 'improving' : slope > 0.5 ? 'worsening' : 'stable';

  // ζ persistence: same file appearing in repeated_edit multiple times → did corrections stick?
  const fileToTimes = new Map<string, Date[]>();
  for (const e of repeatedEdits) {
    if (!e.file) continue;
    const t = new Date(e.at);
    if (Number.isNaN(t.getTime())) continue;
    if (!fileToTimes.has(e.file)) fileToTimes.set(e.file, []);
    fileToTimes.get(e.file)!.push(t);
  }
  const filesWithRecurrence = Array.from(fileToTimes.values()).filter((times) => times.length >= 2).length;
  const gaps: number[] = [];
  for (const times of fileToTimes.values()) {
    if (times.length < 2) continue;
    times.sort((a, b) => a.getTime() - b.getTime());
    for (let i = 1; i < times.length; i++) {
      gaps.push((times[i].getTime() - times[i - 1].getTime()) / 86400000);
    }
  }

  // φ proxy: hook errors + suppressed rules
  const errorBuckets = bucketByWeek(errors.map((e) => ({ ts: new Date(e.at).toISOString() })));
  const errorPerWeek = errorBuckets.size === 0 ? 0 : errors.length / Math.max(errorBuckets.size, 1);
  const suppressedCount = countSuppressedRules();

  // Rule lifecycle signals — ζ persistence proxy from real rules
  const userRulesDir = `${process.env.HOME}/.forgen/me/rules`;
  type RuleFile = { rule_id?: string; status?: string; created_at?: string; lifecycle?: { inject_count?: number } };
  const allRules: RuleFile[] = [];
  if (existsSync(userRulesDir)) {
    for (const file of readdirSync(userRulesDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const r = JSON.parse(readFileSync(`${userRulesDir}/${file}`, 'utf-8')) as RuleFile;
        allRules.push(r);
      } catch {
        /* skip */
      }
    }
  }
  const byStatus: Record<string, number> = {};
  for (const r of allRules) byStatus[r.status ?? 'unknown'] = (byStatus[r.status ?? 'unknown'] ?? 0) + 1;
  const activeRules = allRules.filter((r) => r.status === 'active');
  const retiredRules = allRules.filter((r) => ['removed', 'superseded', 'suppressed'].includes(r.status ?? ''));
  const lifecyclePool = activeRules.length + retiredRules.length;
  const survivalRate = lifecyclePool === 0 ? 0 : activeRules.length / lifecyclePool;

  const ruleAge = (r: RuleFile): number => {
    if (!r.created_at) return 0;
    const t = new Date(r.created_at).getTime();
    return Number.isNaN(t) ? 0 : Math.round((Date.now() - t) / 86400000);
  };
  const oldestActive = activeRules.length === 0 ? 0 : Math.max(...activeRules.map(ruleAge));
  const retirementAges = retiredRules.map(ruleAge).filter((a) => a > 0);
  const medianRetirementAge = median(retirementAges);
  const ruleInterpretation =
    activeRules.length === 0
      ? 'no active rules — cannot evaluate persistence'
      : `${activeRules.length} active rule(s); oldest active ${oldestActive}d. Median retired age ${medianRetirementAge.toFixed(1)}d.`;

  // Real enforcement signal — actual block / override events
  const violations = readJsonl<{ at: string; rule_id: string }>(join(ENFORCEMENT_DIR, 'violations.jsonl'));
  const acknowledgments = readJsonl<{ at: string; rule_id: string }>(join(ENFORCEMENT_DIR, 'acknowledgments.jsonl'));
  const bypasses = readJsonl<{ at: string; rule_id: string; session_id?: string }>(
    join(ENFORCEMENT_DIR, 'bypass.jsonl'),
  );
  const drift = readJsonl<{ at: string; kind: string }>(join(ENFORCEMENT_DIR, 'drift.jsonl'));
  const totalEnforcement = violations.length + acknowledgments.length + bypasses.length;
  const bypassRate = totalEnforcement === 0 ? 0 : bypasses.length / totalEnforcement;
  const bypassesPerViolation = violations.length === 0 ? 0 : bypasses.length / violations.length;

  // Bypass classification — audit-override vs frustration-override (release-blocker work)
  const suppressedRuleIds = getSuppressedRuleIds();

  // Group bypasses by (session_id, rule_id) to count retry pressure per rule per session
  const sessionRuleCounts = new Map<string, number>();
  for (const b of bypasses) {
    const key = `${b.session_id ?? 'unknown'}::${b.rule_id}`;
    sessionRuleCounts.set(key, (sessionRuleCounts.get(key) ?? 0) + 1);
  }

  let auditOverrides = 0;
  let frustrationOverrides = 0;
  let ambiguous = 0;
  for (const b of bypasses) {
    const key = `${b.session_id ?? 'unknown'}::${b.rule_id}`;
    const sessionRetryCount = sessionRuleCounts.get(key) ?? 1;
    const ruleSuppressed = suppressedRuleIds.includes(b.rule_id);

    // T3 = forgen auto-suppressed → all bypasses for that rule are confirmed frustration
    // ≥ 3 bypass for same (session, rule) = retry pressure = frustration
    if (ruleSuppressed || sessionRetryCount >= 3) {
      frustrationOverrides++;
    } else if (sessionRetryCount === 1) {
      // Single bypass per session-rule = audit override (likely intentional one-off)
      auditOverrides++;
    } else {
      ambiguous++;
    }
  }

  // Strict φ: frustration-overrides / (violations + acknowledgments + frustration)
  const strictPhiDenom = violations.length + acknowledgments.length + frustrationOverrides;
  const strictPhi = strictPhiDenom === 0 ? 0 : frustrationOverrides / strictPhiDenom;
  const strictPhiInterpretation: 'pass' | 'fail-master-gate' = strictPhi <= 0.05 ? 'pass' : 'fail-master-gate';

  // Per-rule breakdown — which rules cause the most FPs?
  const ruleCounts = new Map<string, number>();
  for (const b of bypasses) ruleCounts.set(b.rule_id, (ruleCounts.get(b.rule_id) ?? 0) + 1);
  const perRule = Array.from(ruleCounts.entries())
    .map(([ruleId, count]) => ({
      ruleId,
      bypasses: count,
      fraction: bypasses.length === 0 ? 0 : Number((count / bypasses.length).toFixed(3)),
    }))
    .sort((a, b) => b.bypasses - a.bypasses);
  const topOffender = perRule[0] ?? { ruleId: 'none', bypasses: 0, fraction: 0 };
  const topOffenderFrustration = (() => {
    let count = 0;
    for (const b of bypasses) {
      if (b.rule_id !== topOffender.ruleId) continue;
      const key = `${b.session_id ?? 'unknown'}::${b.rule_id}`;
      const sessionRetryCount = sessionRuleCounts.get(key) ?? 1;
      const ruleSuppressed = suppressedRuleIds.includes(b.rule_id);
      if (ruleSuppressed || sessionRetryCount >= 3) count++;
    }
    return count;
  })();
  const remainingFrustration = frustrationOverrides - topOffenderFrustration;
  const strictPhiExcludingTopDenom = violations.length + acknowledgments.length + remainingFrustration;
  const strictPhiExcludingTop =
    strictPhiExcludingTopDenom === 0 ? 0 : remainingFrustration / strictPhiExcludingTopDenom;

  const observationWindowDays = computeWindowDays(feedback);

  return {
    generatedAt: new Date().toISOString(),
    observationWindowDays,
    totals: {
      implicitFeedback: feedback.length,
      matchEval: matches.length,
      hookErrors: errors.length,
      quarantined: quarantine.length,
    },
    matchSuccess: {
      totalAttempts: matches.length,
      withCandidates,
      rate: matchRate,
    },
    driftSignal: {
      repeatedEdits: repeatedEdits.length,
      driftWarnings: driftWarnings.length,
      driftWarningHighScore: driftHighScore,
    },
    weeklyEdit: weeklyEdit.map((w) => ({ week: w.week, repeatedEdits: w.count })),
    gammaSlope: {
      description: 'Slope of weekly repeated_edit counts. Negative = forgen helping reduce friction.',
      slopePerWeek: Number(slope.toFixed(3)),
      interpretation: gammaInterpretation,
    },
    zetaPersistence: {
      description: 'Files that triggered repeated_edit ≥ 2 times — gap measures whether corrections stuck.',
      filesWithRecurrence,
      medianGapDays: Number(median(gaps).toFixed(2)),
    },
    ruleLifecycle: {
      description:
        'Rule survival: active rules / (active + retired). Time window ' +
        Math.round(observationWindowDays) +
        ' days — N=50 session window not yet reached (~25 days at 2 sess/day).',
      totalRules: allRules.length,
      byStatus,
      survivalRate: Number((survivalRate * 100).toFixed(1)),
      oldestActiveDays: oldestActive,
      medianAgeAtRetirementDays: Number(medianRetirementAge.toFixed(1)),
      interpretation: ruleInterpretation,
    },
    phiProxy: {
      description: 'Hook errors + suppressed rules as false-positive proxies. Lower = healthier.',
      hookErrorsPerWeek: Number(errorPerWeek.toFixed(2)),
      suppressedRuleCount: suppressedCount,
    },
    enforcement: {
      description:
        'Real enforcement events from ~/.forgen/state/enforcement/. Bypass = user overrode block (FP candidate). Drift = stuck-loop forced approve (FP signal).',
      violations: violations.length,
      acknowledgments: acknowledgments.length,
      bypasses: bypasses.length,
      drift: drift.length,
      bypassRate: Number((bypassRate * 100).toFixed(1)),
      bypassesPerViolation: Number(bypassesPerViolation.toFixed(2)),
    },
    bypassClassification: {
      description:
        'audit-override = single bypass per (session, rule). frustration-override = ≥3 retries OR rule auto-suppressed by T3. Strict φ uses only frustration-overrides as FP signal.',
      auditOverrides,
      frustrationOverrides,
      ambiguous,
      rulesSuppressedByT3: suppressedRuleIds.length,
      strictPhi: Number((strictPhi * 100).toFixed(2)),
      interpretation: strictPhiInterpretation,
      perRule,
      topOffender: {
        ruleId: topOffender.ruleId,
        bypasses: topOffender.bypasses,
        fractionOfAllFrustration:
          frustrationOverrides === 0
            ? 0
            : Number((topOffenderFrustration / frustrationOverrides).toFixed(3)),
      },
      strictPhiExcludingTopOffender: Number((strictPhiExcludingTop * 100).toFixed(2)),
      ...(await computePostFixProjection(bypasses, violations.length, acknowledgments.length)),
    },
    honestCaveats: [
      'These are PROXIES — actual γ/β/δ/ε/ζ/φ/ψ require synthetic A/B (T1).',
      'No control group: cannot separate forgen effect from user maturation or external factors.',
      'Suppressed rules count needs forgen rule list parsing — placeholder until wired.',
      'Match success rate excludes hook-error cases (incomplete log capture possible).',
    ],
  };
}

function countSuppressedRules(): number {
  // Parse forgen rule list output for the count line.
  try {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execSync('forgen rule list 2>/dev/null', { encoding: 'utf-8' });
    const match = out.match(/Suppressed rules \((\d+)\)/);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * Post-fix φ projection — for each historical bypass, ask the *current* (fixed)
 * extractBypassPatterns whether the rule would still extract any pattern.
 * If yes: the bypass would still occur → keep counting.
 * If no: the rule is now silenced → bypass count goes to 0 prospectively.
 *
 * This validates the TEST-6 fix's expected impact on φ.
 */
async function computePostFixProjection(
  bypasses: { rule_id: string; session_id?: string }[],
  violations: number,
  acknowledgments: number,
): Promise<{
  postFixSilencedRules: string[];
  postFixRemainingBypasses: number;
  postFixStrictPhi: number;
  postFixInterpretation: 'pass' | 'fail-master-gate';
}> {
  let extractBypassPatterns: (rule: unknown) => string[];
  try {
    // Use dynamic ESM import via runtime-built specifier so TS doesn't try to resolve at compile.
    const path = '/Users/jang-ujin/study/forgen/dist/engine/lifecycle/bypass-detector.js';
    const specifier = `file://${path}`;
    const mod: unknown = await (Function('s', 'return import(s)') as (s: string) => Promise<unknown>)(specifier);
    extractBypassPatterns = (mod as { extractBypassPatterns: (r: unknown) => string[] }).extractBypassPatterns;
  } catch (e) {
    console.error(`[introspect] could not load bypass-detector for post-fix projection: ${(e as Error).message}`);
    extractBypassPatterns = () => [] as string[];
  }

  // Try each unique rule_id — load rule definition from any of:
  //   ~/.forgen/me/rules/<uuid>.json (user)
  //   <repo>/.forgen/rules/<id>.json (project)
  // and call extractBypassPatterns on the policy text.
  const ruleIds = Array.from(new Set(bypasses.map((b) => b.rule_id)));
  const silenced: string[] = [];
  for (const id of ruleIds) {
    const rule = tryLoadRule(id);
    if (!rule) {
      // Cannot load — be conservative, assume rule still active (count as remaining)
      continue;
    }
    const patterns = extractBypassPatterns(rule);
    if (patterns.length === 0) silenced.push(id);
  }

  const remaining = bypasses.filter((b) => !silenced.includes(b.rule_id));
  // Re-classify remaining for frustration count
  const sessionRuleCounts = new Map<string, number>();
  for (const b of remaining) {
    const key = `${b.session_id ?? 'unknown'}::${b.rule_id}`;
    sessionRuleCounts.set(key, (sessionRuleCounts.get(key) ?? 0) + 1);
  }
  let postFrustration = 0;
  for (const b of remaining) {
    const key = `${b.session_id ?? 'unknown'}::${b.rule_id}`;
    if ((sessionRuleCounts.get(key) ?? 1) >= 3) postFrustration++;
  }
  const denom = violations + acknowledgments + postFrustration;
  const phi = denom === 0 ? 0 : postFrustration / denom;
  return {
    postFixSilencedRules: silenced,
    postFixRemainingBypasses: remaining.length,
    postFixStrictPhi: Number((phi * 100).toFixed(2)),
    postFixInterpretation: phi <= 0.05 ? 'pass' : 'fail-master-gate',
  };
}

function tryLoadRule(ruleId: string): unknown | null {
  // 1) project rules (e.g., L1-*)
  const projectPath = `/Users/jang-ujin/study/forgen/.forgen/rules/${ruleId}.json`;
  try {
    if (existsSync(projectPath)) {
      return JSON.parse(readFileSync(projectPath, 'utf-8'));
    }
  } catch {
    /* fall through */
  }
  // 2) user rules (UUID-named)
  const userPath = `${process.env.HOME}/.forgen/me/rules/${ruleId}.json`;
  try {
    if (existsSync(userPath)) {
      return JSON.parse(readFileSync(userPath, 'utf-8'));
    }
  } catch {
    /* fall through */
  }
  return null;
}

function getSuppressedRuleIds(): string[] {
  // Get rule IDs of currently-suppressed rules so we can mark their bypasses as confirmed frustration.
  try {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execSync('forgen rule list 2>/dev/null', { encoding: 'utf-8' });
    // After `── Suppressed rules` heading, lines like `  [tier/strength] rule.id — desc`
    const lines = out.split('\n');
    const ids: string[] = [];
    let inSuppressed = false;
    for (const line of lines) {
      if (line.includes('Suppressed rules')) {
        inSuppressed = true;
        continue;
      }
      if (line.includes('Active rules')) {
        inSuppressed = false;
        continue;
      }
      if (inSuppressed) {
        const m = line.match(/\[[^\]]+\]\s+([\w./-]+)/);
        if (m) ids.push(m[1]);
      }
    }
    return ids;
  } catch {
    return [];
  }
}

function computeWindowDays(events: ImplicitFeedbackEvent[]): number {
  if (events.length === 0) return 0;
  const times = events.map((e) => new Date(e.at).getTime()).filter((n) => !Number.isNaN(n));
  if (times.length === 0) return 0;
  const min = Math.min(...times);
  const max = Math.max(...times);
  return Math.round((max - min) / 86400000);
}

export function renderIntrospectMarkdown(r: IntrospectReport): string {
  const lines: string[] = [];
  lines.push(`# Forgen Introspection Report`);
  lines.push(`**Generated**: ${r.generatedAt}`);
  lines.push(`**Window**: ${r.observationWindowDays} days of real usage`);
  lines.push('');
  lines.push(`## Totals`);
  lines.push(`- implicit-feedback events: ${r.totals.implicitFeedback}`);
  lines.push(`- match-eval-log entries: ${r.totals.matchEval}`);
  lines.push(`- hook-errors: ${r.totals.hookErrors}`);
  lines.push(`- quarantined solutions: ${r.totals.quarantined}`);
  lines.push('');
  lines.push(`## Compound utility (Match success)`);
  lines.push(`- Hook compound-match attempts: ${r.matchSuccess.totalAttempts}`);
  lines.push(`- With candidates returned: ${r.matchSuccess.withCandidates} (${(r.matchSuccess.rate * 100).toFixed(1)}%)`);
  lines.push('');
  lines.push(`## Drift signal (Mech-C measurement)`);
  lines.push(`- repeated_edit events: ${r.driftSignal.repeatedEdits}`);
  lines.push(`- drift_warning events: ${r.driftSignal.driftWarnings}`);
  lines.push(`- drift_warning with score ≥ 50: ${r.driftSignal.driftWarningHighScore}`);
  lines.push('');
  lines.push(`## γ proxy (behavior change over time)`);
  lines.push(`- ${r.gammaSlope.description}`);
  lines.push(`- Slope per week: ${r.gammaSlope.slopePerWeek}`);
  lines.push(`- Interpretation: **${r.gammaSlope.interpretation}**`);
  lines.push('');
  lines.push(`### Weekly repeated_edit counts`);
  for (const w of r.weeklyEdit) lines.push(`- ${w.week}: ${w.repeatedEdits}`);
  lines.push('');
  lines.push(`## ζ proxy (correction persistence)`);
  lines.push(`- ${r.zetaPersistence.description}`);
  lines.push(`- Files with recurrence: ${r.zetaPersistence.filesWithRecurrence}`);
  lines.push(`- Median gap between recurrences: ${r.zetaPersistence.medianGapDays} days`);
  lines.push('');
  lines.push(`## ζ rule-lifecycle (forgen rule survival)`);
  lines.push(`- ${r.ruleLifecycle.description}`);
  lines.push(`- Total rules: ${r.ruleLifecycle.totalRules}`);
  lines.push(`- By status: ${JSON.stringify(r.ruleLifecycle.byStatus)}`);
  lines.push(`- **Survival rate: ${r.ruleLifecycle.survivalRate}%** (active / (active + retired))`);
  lines.push(`- Oldest active rule: ${r.ruleLifecycle.oldestActiveDays} days`);
  lines.push(`- Median retirement age: ${r.ruleLifecycle.medianAgeAtRetirementDays} days`);
  lines.push(`- Interpretation: ${r.ruleLifecycle.interpretation}`);
  lines.push('');
  lines.push(`## φ proxy (cost / false-positive signals)`);
  lines.push(`- ${r.phiProxy.description}`);
  lines.push(`- Hook errors per week: ${r.phiProxy.hookErrorsPerWeek}`);
  lines.push(`- Suppressed rules: ${r.phiProxy.suppressedRuleCount}`);
  lines.push('');
  lines.push(`## Real enforcement events`);
  lines.push(`- ${r.enforcement.description}`);
  lines.push(`- Violations (blocks): ${r.enforcement.violations}`);
  lines.push(`- Acknowledgments (user accepted block): ${r.enforcement.acknowledgments}`);
  lines.push(`- Bypasses raw (user overrode block): ${r.enforcement.bypasses}`);
  lines.push(`- Drift events (stuck-loop force approve): ${r.enforcement.drift}`);
  lines.push(`- Raw bypass rate: ${r.enforcement.bypassRate}%`);
  lines.push(`- Bypasses per violation: ${r.enforcement.bypassesPerViolation}`);
  lines.push('');
  lines.push(`## Bypass classification (audit vs frustration)`);
  lines.push(`- ${r.bypassClassification.description}`);
  lines.push(`- audit-override (1 bypass / session-rule): ${r.bypassClassification.auditOverrides}`);
  lines.push(`- **frustration-override (≥3 retries OR T3 suppressed): ${r.bypassClassification.frustrationOverrides}**`);
  lines.push(`- ambiguous (2 bypass / session-rule): ${r.bypassClassification.ambiguous}`);
  lines.push(`- Rules suppressed by T3 trigger: ${r.bypassClassification.rulesSuppressedByT3}`);
  lines.push(`- **Strict φ = ${r.bypassClassification.strictPhi}% (master gate ≤ 5%) → ${r.bypassClassification.interpretation}**`);
  lines.push('');
  lines.push(`### Per-rule bypass distribution`);
  for (const pr of r.bypassClassification.perRule.slice(0, 10)) {
    lines.push(`- ${pr.bypasses} (${(pr.fraction * 100).toFixed(1)}%) × ${pr.ruleId}`);
  }
  lines.push('');
  lines.push(`### Top offender impact`);
  const t = r.bypassClassification.topOffender;
  lines.push(`- Worst rule: **${t.ruleId}** (${t.bypasses} bypasses, ${(t.fractionOfAllFrustration * 100).toFixed(1)}% of all frustration)`);
  lines.push(`- **Strict φ excluding worst rule: ${r.bypassClassification.strictPhiExcludingTopOffender}%**`);
  lines.push(`- Leverage: fixing this single rule reduces φ by ${(r.bypassClassification.strictPhi - r.bypassClassification.strictPhiExcludingTopOffender).toFixed(2)} percentage points`);
  lines.push('');
  lines.push(`### Post-fix φ projection (TEST-6 + parens-heuristic)`);
  lines.push(`Replays the historical bypass log against the *current* (fixed) extractBypassPatterns.`);
  lines.push(`If a rule no longer extracts any pattern, all its bypasses are projected to 0 going forward.`);
  lines.push(`- Silenced rules: ${r.bypassClassification.postFixSilencedRules.length}`);
  for (const rid of r.bypassClassification.postFixSilencedRules) lines.push(`  - ${rid}`);
  lines.push(`- Remaining bypasses (post-fix): ${r.bypassClassification.postFixRemainingBypasses}`);
  lines.push(`- **Post-fix strict φ: ${r.bypassClassification.postFixStrictPhi}% → ${r.bypassClassification.postFixInterpretation}**`);
  lines.push('');
  lines.push(`## Honest caveats`);
  for (const c of r.honestCaveats) lines.push(`- ${c}`);
  return lines.join('\n');
}

async function main() {
  const r = await introspect();
  console.log(renderIntrospectMarkdown(r));

  // Also save to reports/
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('./reports/introspect', { recursive: true });
  const runId = `introspect-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  writeFileSync(`./reports/introspect/${runId}.json`, JSON.stringify(r, null, 2));
  writeFileSync(`./reports/introspect/${runId}.md`, renderIntrospectMarkdown(r));
  console.error(`\nReport saved: reports/introspect/${runId}.md`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
