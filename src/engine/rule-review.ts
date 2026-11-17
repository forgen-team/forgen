/**
 * `forgen rule review` — 검토 대기(flagged) 룰 처리 (2026-11 재설계 D7, ADR-002 "flagged → active: 재검토 후 사용자 승인").
 *
 *   forgen rule review                       원인별 목록
 *   forgen rule review --keep <id...>        유지: phase active + reviewed_at (그 이후 기록만 다시 센다)
 *   forgen rule review --suppress <id...>    끄기: status suppressed (hard 룰은 거부)
 *
 * 원인은 lifecycle 로그에서 그 룰의 마지막 flag 이벤트로 판정한다. 수정은 명령이 아니라 Claude 에게
 * "이 룰을 이렇게 바꿔"라고 말하면 correction-record(rule_id, prefer-from-now)로 대체된다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ME_BEHAVIOR } from '../core/paths.js';
import { loadAllRules, loadRule, rulePath, saveRule, updateRuleStatus } from '../store/rule-store.js';
import { withFileLockSync } from '../hooks/shared/file-lock.js';
import { lifecycleDir, t1Targets } from './lifecycle/t5-hygiene.js';
import { isRealBlock, precisionByRule, readVerdicts, readViolationsWindow } from './lifecycle/signals.js';
import type { Rule } from '../store/types.js';

export type FlagCause = 'correction' | 'violations' | 'bypass' | 'legacy' | 'conflict' | 'unknown';

export const FLAG_CAUSE_LABEL: Record<FlagCause, string> = {
  correction: '교정으로 수정 요청됨',
  violations: '반복 차단 — 검토',
  bypass: '우회됨',
  legacy: '옛 교정 추측 매칭(오탐) — forgen rule unflag',
  conflict: '충돌 감지 기록(참고)',
  unknown: '원인 기록 없음',
};

const KIND_TO_CAUSE: Record<string, FlagCause> = {
  t1_explicit_correction: 'correction',
  t2_repeated_violation: 'violations',
  t3_user_bypass: 'bypass',
  t5_conflict_detected: 'conflict',
};

export interface FlagInfo { cause: FlagCause; at?: string; evidenceRef?: string }

/** 룰별 마지막 flag 원인. T5 는 T1·T2·T3 기록이 하나도 없을 때만 원인으로 본다(관찰 기록일 뿐이므로). */
export function flagCauses(ruleIds: Set<string>, dir: string = lifecycleDir()): Map<string, FlagInfo> {
  const best = new Map<string, FlagInfo & { ts: number; strong: boolean }>();
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl(\.\d+)?$/.test(f)).sort(); } catch { return new Map(); }
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf-8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let e: { kind?: string; rule_id?: string; ts?: number; evidence?: { refs?: string[] } };
      try { e = JSON.parse(line); } catch { continue; }
      let cause = e.kind ? KIND_TO_CAUSE[e.kind] : undefined;
      if (!cause || !e.rule_id || !ruleIds.has(e.rule_id)) continue;
      // 룰을 지목하지 않은 T1 은 0.6.9 이전 추측 매칭의 오탐 — 약한 원인으로 본다.
      if (cause === 'correction' && !t1Targets(e.rule_id, e.evidence?.refs?.[0])) cause = 'legacy';
      const ts = typeof e.ts === 'number' ? e.ts : Date.parse(`${f.slice(0, 10)}T00:00:00Z`);
      const strong = cause !== 'conflict' && cause !== 'legacy';
      const prev = best.get(e.rule_id);
      if (prev && (prev.strong && !strong || (prev.strong === strong && prev.ts > ts))) continue;
      best.set(e.rule_id, { cause, ts, strong, at: new Date(ts).toISOString(), evidenceRef: cause === 'correction' ? e.evidence?.refs?.[0] : undefined });
    }
  }
  const out = new Map<string, FlagInfo>();
  for (const id of ruleIds) {
    const b = best.get(id);
    out.set(id, b ? { cause: b.cause, at: b.at, evidenceRef: b.evidenceRef } : { cause: 'unknown' });
  }
  return out;
}

function correctionText(evidenceId: string | undefined): string | null {
  if (!evidenceId || evidenceId !== path.basename(evidenceId)) return null;
  try {
    const e = JSON.parse(fs.readFileSync(path.join(ME_BEHAVIOR, `${evidenceId}.json`), 'utf-8')) as { summary?: string; raw_payload?: { user_quote?: string } };
    return (e.raw_payload?.user_quote ?? e.summary ?? '').replace(/\s+/g, ' ').slice(0, 90) || null;
  } catch { return null; }
}

function resolve(rules: Rule[], prefixes: string[]): { found: Rule[]; errors: string[] } {
  const found: Rule[] = [];
  const errors: string[] = [];
  for (const p of prefixes) {
    const m = rules.filter((r) => r.rule_id === p || r.rule_id.startsWith(p));
    if (m.length === 1) found.push(m[0]);
    else errors.push(m.length === 0 ? `${p}: 일치하는 룰 없음` : `${p}: ${m.length}개 일치 — 더 길게 입력`);
  }
  return { found, errors };
}

/** 유지: phase active + reviewed_at. 바꾼 수. */
export function keepRules(ids: string[], nowIso: string = new Date().toISOString()): number {
  let n = 0;
  for (const id of ids) {
    try {
      withFileLockSync(rulePath(id), () => {
        const r = loadRule(id);
        if (!r?.lifecycle || r.status !== 'active') return;
        saveRule({ ...r, lifecycle: { ...r.lifecycle, phase: 'active', reviewed_at: nowIso } });
        n++;
      });
    } catch { /* 잠금 실패 — 다시 실행 */ }
  }
  return n;
}

export function handleRuleReview(args: string[]): void {
  const rules = loadAllRules();
  const keepIdx = args.indexOf('--keep');
  const supIdx = args.indexOf('--suppress');
  const take = (i: number): string[] => {
    const out: string[] = [];
    if (i === -1) return out;
    for (let k = i + 1; k < args.length && !args[k].startsWith('--'); k++) out.push(args[k]);
    return out;
  };
  if (keepIdx !== -1 || supIdx !== -1) {
    const keep = resolve(rules, take(keepIdx));
    const sup = resolve(rules, take(supIdx));
    for (const e of [...keep.errors, ...sup.errors]) console.error(`  ${e}`);
    if (keep.found.length) console.log(`✓ 유지 ${keepRules(keep.found.map((r) => r.rule_id))}개 — 검토 이후 기록만 다시 셉니다.`);
    let s = 0;
    for (const r of sup.found) {
      if (r.strength === 'hard') { console.error(`  ${r.rule_id.slice(0, 8)}: hard 룰은 끌 수 없습니다(ADR-002).`); continue; }
      if (updateRuleStatus(r.rule_id, 'suppressed', 'review', 'user')) s++;
    }
    if (sup.found.length) console.log(`✓ 끔 ${s}개`);
    if (keep.errors.length || sup.errors.length) process.exitCode = 1;
    return;
  }

  const flagged = rules.filter((r) => r.status === 'active' && r.lifecycle?.phase === 'flagged');
  if (flagged.length === 0) { console.log('검토 대기 룰이 없습니다.'); return; }
  const causes = flagCauses(new Set(flagged.map((r) => r.rule_id)));
  const violations = readViolationsWindow(30);
  const blocks30 = new Map<string, number>();
  for (const v of violations) if (isRealBlock(v)) blocks30.set(v.rule_id, (blocks30.get(v.rule_id) ?? 0) + 1);
  const precision = precisionByRule(violations, readVerdicts(), 30);

  const order: FlagCause[] = ['correction', 'violations', 'bypass', 'unknown', 'legacy', 'conflict'];
  console.log(`\n  검토 대기 ${flagged.length}개\n`);
  for (const cause of order) {
    const list = flagged.filter((r) => causes.get(r.rule_id)?.cause === cause);
    if (!list.length) continue;
    console.log(`  ${FLAG_CAUSE_LABEL[cause]} (${list.length})`);
    for (const r of list) {
      console.log(`    ${r.rule_id.slice(0, 8)}  [${r.strength}]  ${r.policy.replace(/\s+/g, ' ').slice(0, 80)}`);
      const info = causes.get(r.rule_id);
      if (cause === 'correction') {
        const t = correctionText(info?.evidenceRef);
        console.log(`              교정${info?.at ? ` ${info.at.slice(0, 10)}` : ''}: ${t ?? '(교정 기록을 찾지 못함)'}`);
      } else if (cause === 'violations') {
        const p = precision.get(r.rule_id);
        const judged = p ? `정탐 ${p.correct} · 오탐 ${p.false_positive} · 미판정 ${p.unjudged}` : '판정 없음';
        console.log(`              최근 30일 차단 ${blocks30.get(r.rule_id) ?? 0}회 (${judged}) — 자주 막았다 = 모델이 계속 시도했거나 오탐`);
      }
    }
    console.log('');
  }
  console.log('  유지: forgen rule review --keep <id...>    끄기: forgen rule review --suppress <id...>');
  console.log('  고치기: Claude 에게 "이 룰을 이렇게 바꿔"라고 말하면 교정으로 대체됩니다.\n');
}
