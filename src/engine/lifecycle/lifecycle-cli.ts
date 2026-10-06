/**
 * CLI handler for `forgen lifecycle-scan`.
 *
 * 전체 lifecycle 트리거(T1~T5 + Meta) 를 쓴 집계 데이터 기반으로 실행.
 * default dry-run, --apply 시 rule 파일에 상태 전이 반영.
 */

import * as path from 'node:path';
import { loadAllRules, saveRule } from '../../store/rule-store.js';
import { STATE_DIR } from '../../core/paths.js';
import { collectSignals, readJsonlSafe, isConfirmedBypass, isSyntheticSession } from './signals.js';
import { detect as detectT2 } from './trigger-t2-violation.js';
import { detect as detectT3 } from './trigger-t3-bypass.js';
import { detect as detectT4 } from './trigger-t4-decay.js';
import { detect as detectT5 } from './trigger-t5-conflict.js';
import {
  scanDriftForDemotion,
  applyDemotion,
  scanSignalsForPromotion,
  applyPromotion,
  readDriftEntries,
  appendLifecycleEvents,
} from './meta-reclassifier.js';
import { foldEvents } from './orchestrator.js';
import type { LifecycleEvent, RuleSignals, ViolationEntry, } from './types.js';

const LIFECYCLE_DIR = path.join(STATE_DIR, 'lifecycle');

export async function handleLifecycleScan(args: string[]): Promise<void> {
  const apply = args.includes('--apply');
  const now = Date.now();

  const rules = loadAllRules();
  if (rules.length === 0) {
    console.log('\n  No rules in ~/.forgen/me/rules. Nothing to scan.\n');
    return;
  }

  const violations = readJsonlSafe<ViolationEntry>(
    path.join(STATE_DIR, 'enforcement', 'violations.jsonl')
  );
  // ADR-017 D1: bypass.jsonl(자연어 휴리스틱, 전량 오탐)은 더 이상 읽지 않는다. T3 입력은
  // violations 의 kind:'bypass_confirmed'(사용자 명시 우회) 뿐이며 collectSignals 가 거기서 뽑는다.
  const bypassConfirmed = violations.filter(isConfirmedBypass).length;
  const syntheticExcluded = violations.filter((v) => isSyntheticSession(v.session_id)).length;
  const drift = readDriftEntries();

  const signals = new Map<string, RuleSignals>();
  for (const r of rules) signals.set(r.rule_id, collectSignals(r, { violations, now }));

  const events: LifecycleEvent[] = [
    ...detectT2({ rules, signals, ts: now }),
    ...detectT3({ rules, signals, ts: now }),
    ...detectT4({ rules, signals, ts: now }),
    ...detectT5({ rules, ts: now }),
  ];

  const demotionCandidates = scanDriftForDemotion({ rules, drift, now });
  const promotionCandidates = scanSignalsForPromotion({ rules, signals, ts: now });

  console.log(`\n  Lifecycle Scan — ${rules.length} rule(s)  (${apply ? 'APPLY' : 'dry-run'})\n`);
  console.log(`  Signals: violations.jsonl=${violations.length} (synthetic-session excluded ${syntheticExcluded})  bypass_confirmed=${bypassConfirmed}  drift.jsonl=${drift.length}\n`);

  if (events.length === 0 && demotionCandidates.length === 0 && promotionCandidates.length === 0) {
    console.log('  No lifecycle events. System stable.\n');
    return;
  }

  console.log(`  Rule health events: ${events.length}`);
  const byKind = new Map<string, number>();
  for (const e of events) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  for (const [k, n] of byKind.entries()) console.log(`    ${k}: ${n}`);

  console.log(`\n  Meta candidates: promote=${promotionCandidates.length}  demote=${demotionCandidates.length}`);

  if (!apply) {
    for (const e of events) {
      console.log(`    → ${e.kind.padEnd(24)} rule=${e.rule_id.slice(0, 8)} action=${e.suggested_action}`);
    }
    for (const c of demotionCandidates) {
      console.log(`    → meta_demote              rule=${c.rule_id.slice(0, 8)} events=${c.event_count}`);
    }
    for (const c of promotionCandidates) {
      console.log(`    → meta_promote             rule=${c.rule_id.slice(0, 8)} injects=${c.injects_rolling_n}`);
    }
    console.log('\n  Run with --apply to persist.\n');
    return;
  }

  // APPLY path: fold T2~T5 events into rules, save, then do Meta.
  const byId = foldEvents(rules, events, now);
  let saved = 0;
  for (const [ruleId, updated] of byId.entries()) {
    const original = rules.find((r) => r.rule_id === ruleId);
    if (!original) continue;
    if (updated === original) continue;
    saveRule(updated);
    saved += 1;
  }
  if (events.length > 0) appendLifecycleEvents(events, now);

  // Meta apply
  const metaEvents: LifecycleEvent[] = [];
  for (const c of demotionCandidates) {
    const rule = rules.find((r) => r.rule_id === c.rule_id);
    if (!rule) continue;
    const result = applyDemotion(rule, c, now);
    if (result.applied) metaEvents.push(...result.events);
  }
  for (const c of promotionCandidates) {
    const rule = rules.find((r) => r.rule_id === c.rule_id);
    if (!rule) continue;
    const result = applyPromotion(rule, c, now);
    if (result.applied) metaEvents.push(...result.events);
  }
  if (metaEvents.length > 0) appendLifecycleEvents(metaEvents, now);

  console.log(`\n  Applied: ${saved} rule(s) updated, ${metaEvents.length} health event(s).`);
  console.log(`  Log: ${LIFECYCLE_DIR}/${new Date(now).toISOString().slice(0, 10)}.jsonl\n`);
}
